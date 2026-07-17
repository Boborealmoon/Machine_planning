"""Open APS/NPS jobs whose ERP structure contains child parts with their own BOM."""
from __future__ import annotations

import logging
import re
import time
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error
from .helpers import planner_db, rows
from .staged_erp import live_query
from .utils import SHIPPED_QTY_TOLERANCE, compact_text, shipped_quantity_completed

logger = logging.getLogger(__name__)

assembly_bom_bp = Blueprint("assembly_bom", __name__)

ASSEMBLY_BOM_PATH = "/assembly-boms"
_CACHE_TTL_SEC = 300
_cache: dict[bool, tuple[float, list[dict[str, Any]]]] = {}

_OPEN_ROOT_SQL = f"""
SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
       c.ps_id,
       c.pp_partial_no,
       c.part_no,
       c.description AS part_desc,
       c.bom_code,
       c.status,
       c.due_date,
       c.partial_qty,
       c.total_qty,
       c.qty_shipped,
       c.so_det_qty,
       c.source_voucher_no AS sales_order_no,
       c.source_line_item_no AS sales_order_line,
       c.current_stage_desc,
       c.current_stage_status
FROM pp_vouchers_cache c
WHERE (c.ps_id LIKE 'APS%%' OR c.ps_id LIKE 'NPS%%')
  AND LOWER(TRIM(COALESCE(c.status, ''))) NOT IN
      ('history', 'completed', 'complete', 'cancelled', 'canceled', 'void')
  AND (
      c.so_det_qty IS NULL
      OR COALESCE(c.qty_shipped, 0) < (c.so_det_qty - {SHIPPED_QTY_TOLERANCE})
  )
ORDER BY c.ps_id, c.pp_partial_no, c.stage_no NULLS FIRST
"""

_HISTORICAL_ASSEMBLY_SQL = """
WITH route_counts AS (
    SELECT source_inventory_code,
           ARRAY_AGG(DISTINCT bom_code ORDER BY bom_code)
               FILTER (WHERE COALESCE(bom_code, '') <> '') AS bom_codes,
           ARRAY_AGG(DISTINCT material_inventory_code ORDER BY material_inventory_code)
               FILTER (WHERE COALESCE(material_inventory_code, '') <> '') AS leaf_materials
    FROM material_per_bom
    GROUP BY source_inventory_code
), component_rows AS (
    SELECT m.pp_voucher_no,
           m.process_sheet_no,
           m.inventory_code,
           m.total_qty,
           COALESCE(rc.bom_codes, ARRAY[]::TEXT[]) AS bom_codes,
           COALESCE(rc.leaf_materials, ARRAY[]::TEXT[]) AS leaf_materials,
           COUNT(*) OVER (
               PARTITION BY m.pp_voucher_no, m.inventory_code
           ) AS part_instance_count
    FROM mfg_process_sheet_info m
    JOIN route_counts rc ON rc.source_inventory_code = m.inventory_code
    WHERE (m.pp_voucher_no LIKE 'APS%%' OR m.pp_voucher_no LIKE 'NPS%%')
      AND m.process_sheet_no IS NOT NULL
      AND m.process_sheet_no <> m.pp_voucher_no
), assembly_summary AS (
    SELECT pp_voucher_no,
           COUNT(*) AS child_process_sheets,
           COUNT(DISTINCT inventory_code) AS distinct_subassembly_parts,
           COUNT(*) - COUNT(DISTINCT inventory_code) AS repeated_child_sheets,
           COUNT(DISTINCT inventory_code)
               FILTER (WHERE CARDINALITY(bom_codes) > 1) AS multi_route_child_parts,
           MAX(CARDINALITY(bom_codes)) AS max_routes_on_one_child,
           JSONB_AGG(
               JSONB_BUILD_OBJECT(
                   'process_sheet_no', process_sheet_no,
                   'part_no', inventory_code,
                   'qty', total_qty,
                   'available_bom_codes', bom_codes,
                   'leaf_materials', leaf_materials,
                   'repeated', part_instance_count > 1
               )
               ORDER BY process_sheet_no
           ) AS children
    FROM component_rows
    GROUP BY pp_voucher_no
), root_cache AS (
    SELECT DISTINCT ON (c.ps_id)
           c.ps_id, c.pp_partial_no, c.part_no, c.description, c.bom_code,
           c.status, c.total_qty, c.partial_qty, c.qty_shipped, c.so_det_qty,
           c.due_date, c.source_voucher_no, c.source_line_item_no,
           c.current_stage_desc, c.current_stage_status
    FROM pp_vouchers_cache c
    JOIN assembly_summary a ON a.pp_voucher_no = c.ps_id
    ORDER BY c.ps_id, c.stage_no NULLS FIRST
), root_info AS (
    SELECT DISTINCT ON (m.pp_voucher_no)
           m.pp_voucher_no, m.inventory_code AS root_inventory_code,
           m.total_qty AS root_qty
    FROM mfg_process_sheet_info m
    JOIN assembly_summary a ON a.pp_voucher_no = m.pp_voucher_no
    WHERE m.process_sheet_no = m.pp_voucher_no
    ORDER BY m.pp_voucher_no
)
SELECT a.pp_voucher_no AS ps_id,
       COALESCE(r.pp_partial_no, 1) AS pp_partial_no,
       COALESCE(r.part_no, i.root_inventory_code, '') AS part_no,
       COALESCE(r.description, '') AS part_desc,
       COALESCE(r.bom_code, '') AS bom_code,
       COALESCE(r.status, '') AS status,
       COALESCE(r.total_qty, r.partial_qty, i.root_qty, 0) AS qty,
       COALESCE(r.qty_shipped, 0) AS qty_shipped,
       r.so_det_qty,
       r.due_date,
       COALESCE(r.source_voucher_no, '') AS sales_order_no,
       COALESCE(r.source_line_item_no, '') AS sales_order_line,
       COALESCE(r.current_stage_desc, '') AS current_stage_desc,
       COALESCE(r.current_stage_status, '') AS current_stage_status,
       a.child_process_sheets,
       a.distinct_subassembly_parts,
       a.repeated_child_sheets,
       a.multi_route_child_parts,
       a.max_routes_on_one_child,
       a.children
FROM assembly_summary a
LEFT JOIN root_cache r ON r.ps_id = a.pp_voucher_no
LEFT JOIN root_info i ON i.pp_voucher_no = a.pp_voucher_no
ORDER BY a.pp_voucher_no
"""

_PROCESS_SHEET_HIERARCHY_SQL = """
SELECT
    sales_order_no,
    line_item_no,
    type,
    path,
    component_link_no,
    component_line_item_no,
    parent_inventory_code,
    inventory_code,
    total_qty,
    pp_voucher_no,
    process_sheet_no,
    component_seq_no,
    customer_code,
    customer_po_no,
    sales_order_date,
    inventory_main_desc,
    inventory_short_desc
FROM public.mfg_process_sheet_info_v1_view
WHERE pp_voucher_no = ANY(%s)
ORDER BY pp_voucher_no, component_seq_no NULLS FIRST, process_sheet_no
"""

_BOM_LISTING_SQL = """
SELECT
    bom_code,
    bom_desc,
    source_inventory_code,
    level,
    root,
    inventory_code,
    material_inventory_code,
    description,
    qty_parent,
    qty_fg,
    uom_code,
    selected_bom_code,
    in_house_production
FROM public.inventory_bom_listing
WHERE source_inventory_code = ANY(%s)
ORDER BY source_inventory_code, bom_code, level, root
"""


def bom_code_match_key(code: Any) -> str:
    """Compare ERP BOM aliases while retaining the original code for display."""
    text = compact_text(code).upper()
    return re.sub(r"[^A-Z0-9]+", "", text) if text else ""


def _as_int(value: Any) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def is_open_root(row: dict[str, Any]) -> bool:
    status = compact_text(row.get("status")).lower()
    if status in {"history", "completed", "complete", "cancelled", "canceled", "void"}:
        return False
    so_qty = row.get("so_det_qty")
    return so_qty is None or not shipped_quantity_completed(so_qty, row.get("qty_shipped"))


def _codes(rows_: list[dict[str, Any]]) -> list[str]:
    return sorted({compact_text(row.get("bom_code")) for row in rows_ if compact_text(row.get("bom_code"))})


def _selected_root_row(
    root_rows: list[dict[str, Any]],
    child_part: str,
    parent_bom: str,
) -> dict[str, Any]:
    candidates = [
        row
        for row in root_rows
        if _as_int(row.get("level")) == 1
        and compact_text(row.get("material_inventory_code")).upper() == child_part.upper()
    ]
    if not candidates:
        return {}
    parent_key = bom_code_match_key(parent_bom)
    if parent_key:
        matched = [row for row in candidates if bom_code_match_key(row.get("bom_code")) == parent_key]
        if matched:
            return matched[0]
    return candidates[0]


def _resolve_child_bom(
    selected_bom: str,
    available_boms: list[str],
) -> tuple[str, str]:
    """Return display route and one of ok/alias/missing/unresolved."""
    selected = compact_text(selected_bom)
    if not selected:
        return "", "missing"
    if selected in available_boms:
        return selected, "ok"
    selected_key = bom_code_match_key(selected)
    alias = next((code for code in available_boms if bom_code_match_key(code) == selected_key), "")
    if alias:
        return alias, "alias"
    return selected, "unresolved"


def classify_assembly_job(
    root: dict[str, Any],
    hierarchy_rows: list[dict[str, Any]],
    listing_by_source: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    """Build one parent job and its component/BOM diagnostics."""
    ps_id = compact_text(root.get("ps_id"))
    parent_part = compact_text(root.get("part_no"))
    parent_bom = compact_text(root.get("bom_code"))
    fg_row = next(
        (
            row
            for row in hierarchy_rows
            if compact_text(row.get("type")).upper() == "FG"
            and compact_text(row.get("inventory_code")).upper() == parent_part.upper()
        ),
        {},
    )
    component_rows = [
        row
        for row in hierarchy_rows
        if compact_text(row.get("type")).upper() == "COMP"
        and (
            not compact_text(row.get("parent_inventory_code"))
            or compact_text(row.get("parent_inventory_code")).upper() == parent_part.upper()
        )
    ]
    if not component_rows:
        return None

    root_rows = listing_by_source.get(parent_part.upper(), [])
    instance_counts = Counter(compact_text(row.get("inventory_code")).upper() for row in component_rows)
    children: list[dict[str, Any]] = []
    flag_set = {"nested_assembly"}

    for component in component_rows:
        child_part = compact_text(component.get("inventory_code"))
        root_listing = _selected_root_row(root_rows, child_part, parent_bom)
        in_house = compact_text(root_listing.get("in_house_production")).upper() == "Y"
        child_rows = listing_by_source.get(child_part.upper(), [])
        # A component is a subassembly when it is itself a BOM parent. The
        # in-house marker is useful context, but is not reliable enough to be
        # a detection requirement (outsourced and incompletely tagged parts).
        if not child_rows:
            continue
        available_boms = _codes(child_rows)
        selected_bom = compact_text(root_listing.get("selected_bom_code"))
        resolved_bom, route_status = _resolve_child_bom(selected_bom, available_boms)
        if len(available_boms) > 1:
            flag_set.add("multiple_boms")
        if route_status == "missing":
            flag_set.add("missing_bom")
        elif route_status == "unresolved":
            flag_set.add("unresolved_bom")
        elif route_status == "alias":
            flag_set.add("bom_alias")
        if instance_counts[child_part.upper()] > 1:
            flag_set.add("repeated_component")

        route_key = bom_code_match_key(resolved_bom or selected_bom)
        route_rows = [
            row for row in child_rows if not route_key or bom_code_match_key(row.get("bom_code")) == route_key
        ]
        leaf_materials = sorted(
            {
                compact_text(row.get("material_inventory_code"))
                for row in route_rows
                if compact_text(row.get("material_inventory_code"))
            }
        )
        children.append(
            {
                "process_sheet_no": compact_text(component.get("process_sheet_no")),
                "component_seq_no": _as_int(component.get("component_seq_no")),
                "component_link_no": compact_text(component.get("component_link_no")),
                "component_line_item_no": compact_text(component.get("component_line_item_no")),
                "path": compact_text(component.get("path")),
                "part_no": child_part,
                "description": compact_text(root_listing.get("description")),
                "qty": _as_float(component.get("total_qty")),
                "in_house": in_house,
                "selected_bom_code": selected_bom,
                "resolved_bom_code": resolved_bom,
                "available_bom_codes": available_boms,
                "route_status": route_status,
                "leaf_materials": leaf_materials,
                "repeated": instance_counts[child_part.upper()] > 1,
            }
        )

    if not children:
        return None

    max_depth = max((_as_int(row.get("level")) for row in root_rows), default=1)
    if max_depth >= 2:
        flag_set.add("deep_nested")
    child_part_counts = Counter(child["part_no"].upper() for child in children)
    warning_flags = sorted(flag_set - {"nested_assembly", "deep_nested", "repeated_component"})
    display_qty = _as_float(root.get("partial_qty") or root.get("total_qty"))
    return {
        "ps_id": ps_id,
        "pp_partial_no": _as_int(root.get("pp_partial_no")) or 1,
        "part_no": parent_part,
        "part_desc": compact_text(root.get("part_desc") or fg_row.get("inventory_main_desc")),
        "bom_code": parent_bom,
        "status": compact_text(root.get("status")),
        "due_date": compact_text(root.get("due_date")),
        "qty": display_qty,
        "qty_shipped": _as_float(root.get("qty_shipped")),
        "sales_order_no": compact_text(root.get("sales_order_no") or fg_row.get("sales_order_no")),
        "sales_order_line": compact_text(root.get("sales_order_line") or fg_row.get("line_item_no")),
        "customer_code": compact_text(fg_row.get("customer_code")),
        "customer_po_no": compact_text(fg_row.get("customer_po_no")),
        "current_stage_desc": compact_text(root.get("current_stage_desc")),
        "current_stage_status": compact_text(root.get("current_stage_status")),
        "component_count": len(children),
        "distinct_child_count": len(child_part_counts),
        "max_depth": max_depth,
        "flags": sorted(flag_set),
        "warning_flags": warning_flags,
        "has_anomaly": bool(warning_flags),
        "children": sorted(
            children,
            key=lambda child: (
                child.get("component_seq_no") or 999999,
                child.get("process_sheet_no") or "",
            ),
        ),
    }


def build_assembly_jobs(
    roots: list[dict[str, Any]],
    hierarchy_rows: list[dict[str, Any]],
    bom_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    hierarchy_by_ps: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in hierarchy_rows:
        hierarchy_by_ps[compact_text(row.get("pp_voucher_no")).upper()].append(row)
    listing_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in bom_rows:
        listing_by_source[compact_text(row.get("source_inventory_code")).upper()].append(row)

    jobs = [
        job
        for root in roots
        if (
            job := classify_assembly_job(
                root,
                hierarchy_by_ps.get(compact_text(root.get("ps_id")).upper(), []),
                listing_by_source,
            )
        )
    ]
    jobs.sort(key=lambda job: (job.get("due_date") or "9999-12-31", job.get("ps_id") or ""))
    return jobs


def _load_open_roots() -> list[dict[str, Any]]:
    with planner_db() as con:
        return [row for row in rows(con.execute(_OPEN_ROOT_SQL)) if is_open_root(row)]


def _fetch_assembly_jobs_uncached() -> list[dict[str, Any]]:
    roots = _load_open_roots()
    ps_ids = sorted({compact_text(row.get("ps_id")) for row in roots if compact_text(row.get("ps_id"))})
    if not ps_ids:
        return []
    hierarchy_rows = live_query(_PROCESS_SHEET_HIERARCHY_SQL, (ps_ids,))
    component_ps_ids = {
        compact_text(row.get("pp_voucher_no")).upper()
        for row in hierarchy_rows
        if compact_text(row.get("type")).upper() == "COMP"
    }
    roots = [
        row for row in roots if compact_text(row.get("ps_id")).upper() in component_ps_ids
    ]
    if not roots:
        return []
    hierarchy_rows = [
        row
        for row in hierarchy_rows
        if compact_text(row.get("pp_voucher_no")).upper() in component_ps_ids
    ]
    all_parts = {
        compact_text(row.get("part_no"))
        for row in roots
        if compact_text(row.get("part_no"))
    }
    all_parts.update(
        compact_text(row.get("inventory_code"))
        for row in hierarchy_rows
        if compact_text(row.get("inventory_code"))
    )
    bom_rows = live_query(_BOM_LISTING_SQL, (sorted(all_parts),)) if all_parts else []
    return build_assembly_jobs(roots, hierarchy_rows, bom_rows)


def _fetch_historical_assembly_jobs_uncached() -> list[dict[str, Any]]:
    with planner_db() as con:
        raw = rows(con.execute(_HISTORICAL_ASSEMBLY_SQL))
    jobs: list[dict[str, Any]] = []
    for row in raw:
        children = []
        for child in row.get("children") or []:
            available = sorted({compact_text(code) for code in child.get("available_bom_codes") or [] if compact_text(code)})
            children.append(
                {
                    "process_sheet_no": compact_text(child.get("process_sheet_no")),
                    "component_seq_no": 0,
                    "component_link_no": "",
                    "component_line_item_no": "",
                    "path": "",
                    "part_no": compact_text(child.get("part_no")),
                    "description": "",
                    "qty": _as_float(child.get("qty")),
                    "in_house": None,
                    "selected_bom_code": "",
                    "resolved_bom_code": available[0] if len(available) == 1 else "",
                    "available_bom_codes": available,
                    "route_status": "history",
                    "leaf_materials": sorted(
                        {
                            compact_text(code)
                            for code in child.get("leaf_materials") or []
                            if compact_text(code)
                        }
                    ),
                    "repeated": bool(child.get("repeated")),
                }
            )
        flags = {"nested_assembly", "deep_nested"}
        if _as_int(row.get("multi_route_child_parts")) > 0:
            flags.add("multiple_boms")
        if _as_int(row.get("repeated_child_sheets")) > 0:
            flags.add("repeated_component")
        warning_flags = sorted(flags - {"nested_assembly", "deep_nested", "repeated_component"})
        jobs.append(
            {
                "ps_id": compact_text(row.get("ps_id")),
                "pp_partial_no": _as_int(row.get("pp_partial_no")) or 1,
                "part_no": compact_text(row.get("part_no")),
                "part_desc": compact_text(row.get("part_desc")),
                "bom_code": compact_text(row.get("bom_code")),
                "status": compact_text(row.get("status")),
                "due_date": compact_text(row.get("due_date")),
                "qty": _as_float(row.get("qty")),
                "qty_shipped": _as_float(row.get("qty_shipped")),
                "sales_order_no": compact_text(row.get("sales_order_no")),
                "sales_order_line": compact_text(row.get("sales_order_line")),
                "customer_code": "",
                "customer_po_no": "",
                "current_stage_desc": compact_text(row.get("current_stage_desc")),
                "current_stage_status": compact_text(row.get("current_stage_status")),
                "component_count": _as_int(row.get("child_process_sheets")),
                "distinct_child_count": _as_int(row.get("distinct_subassembly_parts")),
                "max_depth": 2,
                "max_child_bom_routes": _as_int(row.get("max_routes_on_one_child")),
                "flags": sorted(flags),
                "warning_flags": warning_flags,
                "has_anomaly": bool(warning_flags),
                "is_history": not is_open_root(row),
                "children": children,
            }
        )
    jobs.sort(key=lambda job: (job.get("due_date") or "9999-12-31", job.get("ps_id") or ""))
    return jobs


def fetch_assembly_jobs(
    *,
    refresh: bool = False,
    include_history: bool = True,
) -> list[dict[str, Any]]:
    global _cache
    now = time.time()
    cached = _cache.get(include_history)
    if not refresh and cached and now - cached[0] < _CACHE_TTL_SEC:
        return cached[1]
    jobs = (
        _fetch_historical_assembly_jobs_uncached()
        if include_history
        else _fetch_assembly_jobs_uncached()
    )
    _cache[include_history] = (now, jobs)
    return jobs


@assembly_bom_bp.get(ASSEMBLY_BOM_PATH)
def assembly_bom_page():
    return render_template("assembly_boms.html", active="assembly_boms")


@assembly_bom_bp.get("/api/assembly-boms")
def api_assembly_boms():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    include_history = compact_text(request.args.get("include_history", "1")).lower() not in {
        "0", "false", "no",
    }
    try:
        jobs = fetch_assembly_jobs(refresh=refresh, include_history=include_history)
        return jsonify(
            {
                "ok": True,
                "count": len(jobs),
                "anomaly_count": sum(1 for job in jobs if job.get("has_anomaly")),
                "include_history": include_history,
                "items": jobs,
                "fetched_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
                "cache_ttl_sec": _CACHE_TTL_SEC,
            }
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("assembly BOM query failed")
        return jsonify({"ok": False, "error": str(exc)}), 502
