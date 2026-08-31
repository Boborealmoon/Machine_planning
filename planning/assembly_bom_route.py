"""Open APS/NPS/[SR] jobs whose ERP structure contains child parts with their own BOM."""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error
from .assembly_classify import (
    as_float,
    as_int,
    assembly_ps_type,
    build_assembly_jobs,
    classify_assembly_family,
    hierarchy_from_bom_listing,
    is_open_root,
    is_sr_process_sheet,
    resolve_child_bom,
    selected_root_row,
)
from .helpers import planner_db, rows
from .staged_erp import live_query
from .utils import (
    SHIPPED_QTY_TOLERANCE,
    bom_code_match_key,
    compact_text,
)

logger = logging.getLogger(__name__)

assembly_bom_bp = Blueprint("assembly_bom", __name__)

ASSEMBLY_BOM_PATH = "/assembly-boms"
_CACHE_TTL_SEC = 300
_cache: dict[bool, tuple[float, list[dict[str, Any]]]] = {}

# Re-exports for tests / callers that import from this module.
__all__ = [
    "assembly_bom_bp",
    "assembly_ps_id_sql",
    "bom_code_match_key",
    "build_assembly_jobs",
    "classify_assembly_job",
    "fetch_assembly_jobs",
    "is_open_root",
    "summarize_sr_assembly_jobs",
]


def assembly_ps_id_sql(column: str) -> str:
    """APS/NPS plus A/N-prefixed service-repair vouchers (``N26-[SR]22``)."""
    return (
        f"({column} LIKE 'APS%%' OR {column} LIKE 'NPS%%' "
        f"OR ({column} LIKE '%%[SR]%%' AND ({column} LIKE 'A%%' OR {column} LIKE 'N%%')))"
    )


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
WHERE {assembly_ps_id_sql("c.ps_id")}
  AND LOWER(TRIM(COALESCE(c.status, ''))) NOT IN
      ('history', 'completed', 'complete', 'cancelled', 'canceled', 'void')
  AND (
      c.so_det_qty IS NULL
      OR COALESCE(c.qty_shipped, 0) < (c.so_det_qty - {SHIPPED_QTY_TOLERANCE})
  )
ORDER BY c.ps_id, c.pp_partial_no, c.stage_no NULLS FIRST
"""

_SR_ROOT_SQL = f"""
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
WHERE c.ps_id LIKE '%%[SR]%%'
  AND (c.ps_id LIKE 'A%%' OR c.ps_id LIKE 'N%%')
ORDER BY c.ps_id, c.pp_partial_no, c.stage_no NULLS FIRST
"""

_HISTORICAL_ASSEMBLY_SQL = f"""
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
    WHERE (m.pp_voucher_no LIKE 'APS%%' OR m.pp_voucher_no LIKE 'NPS%%'
           OR (m.pp_voucher_no LIKE '%%[SR]%%'
               AND (m.pp_voucher_no LIKE 'A%%' OR m.pp_voucher_no LIKE 'N%%')))
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


def _as_int(value: Any) -> int:
    return as_int(value)


def _as_float(value: Any) -> float:
    return as_float(value)


def _codes(rows_: list[dict[str, Any]]) -> list[str]:
    from .assembly_classify import bom_codes

    return bom_codes(rows_)


def _selected_root_row(
    root_rows: list[dict[str, Any]],
    child_part: str,
    parent_bom: str,
) -> dict[str, Any]:
    return selected_root_row(root_rows, child_part, parent_bom)


def _resolve_child_bom(
    selected_bom: str,
    available_boms: list[str],
) -> tuple[str, str]:
    return resolve_child_bom(selected_bom, available_boms)


def classify_assembly_job(
    root: dict[str, Any],
    hierarchy_rows: list[dict[str, Any]],
    listing_by_source: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    """Build one parent job (Monitor: subassembly children only)."""
    return classify_assembly_family(
        root,
        hierarchy_rows,
        listing_by_source,
        require_subassembly_children=True,
    )


def _load_open_roots() -> list[dict[str, Any]]:
    with planner_db() as con:
        return [row for row in rows(con.execute(_OPEN_ROOT_SQL)) if is_open_root(row)]


def _load_sr_roots() -> list[dict[str, Any]]:
    with planner_db() as con:
        return rows(con.execute(_SR_ROOT_SQL))


def _jobs_from_bom_listings(roots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Classify nested assemblies from inventory BOM when child process sheets are missing."""
    if not roots:
        return []
    parent_parts = sorted(
        {compact_text(row.get("part_no")) for row in roots if compact_text(row.get("part_no"))}
    )
    parent_bom_rows = live_query(_BOM_LISTING_SQL, (parent_parts,)) if parent_parts else []
    listing_by_parent: dict[str, list[dict[str, Any]]] = {}
    for row in parent_bom_rows:
        listing_by_parent.setdefault(
            compact_text(row.get("source_inventory_code")).upper(), []
        ).append(row)
    hierarchy: list[dict[str, Any]] = []
    for root in roots:
        listing = listing_by_parent.get(compact_text(root.get("part_no")).upper(), [])
        hierarchy.extend(hierarchy_from_bom_listing(root, listing))
    all_parts = {
        compact_text(row.get("part_no")) for row in roots if compact_text(row.get("part_no"))
    }
    all_parts.update(
        compact_text(row.get("inventory_code"))
        for row in hierarchy
        if compact_text(row.get("inventory_code"))
    )
    child_only = sorted(all_parts - set(parent_parts))
    bom_rows = list(parent_bom_rows)
    if child_only:
        bom_rows.extend(live_query(_BOM_LISTING_SQL, (child_only,)))
    return build_assembly_jobs(roots, hierarchy, bom_rows, require_subassembly_children=True)


def _fetch_assembly_jobs_uncached() -> list[dict[str, Any]]:
    all_roots = _load_open_roots()
    ps_ids = sorted({compact_text(row.get("ps_id")) for row in all_roots if compact_text(row.get("ps_id"))})
    if not ps_ids:
        return []
    hierarchy_rows = live_query(_PROCESS_SHEET_HIERARCHY_SQL, (ps_ids,))
    component_ps_ids = {
        compact_text(row.get("pp_voucher_no")).upper()
        for row in hierarchy_rows
        if compact_text(row.get("type")).upper() == "COMP"
    }
    roots = [
        row for row in all_roots if compact_text(row.get("ps_id")).upper() in component_ps_ids
    ]
    leftover_srs = [
        row
        for row in all_roots
        if is_sr_process_sheet(row.get("ps_id"))
        and compact_text(row.get("ps_id")).upper() not in component_ps_ids
    ]
    jobs: list[dict[str, Any]] = []
    if roots:
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
        jobs = build_assembly_jobs(roots, hierarchy_rows, bom_rows, require_subassembly_children=True)
    if leftover_srs:
        try:
            jobs = _merge_open_and_historical_jobs(jobs, _jobs_from_bom_listings(leftover_srs))
        except Exception:
            logger.exception("assembly BOM open SR listing fallback failed")
    return jobs


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
                    "is_subassembly": True,
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
                    "flags": [],
                }
            )
        flags = {"nested_assembly", "deep_nested"}
        if _as_int(row.get("multi_route_child_parts")) > 0:
            flags.add("multiple_boms")
        if _as_int(row.get("repeated_child_sheets")) > 0:
            flags.add("repeated_component")
        warning_flags = sorted(flags - {"nested_assembly", "deep_nested", "repeated_component", "leaf_component"})
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
                "is_open": is_open_root(row),
                "ps_type": assembly_ps_type(row.get("ps_id")),
                "children": children,
            }
        )
    jobs.sort(key=lambda job: (job.get("due_date") or "9999-12-31", job.get("ps_id") or ""))
    return jobs


def _merge_open_and_historical_jobs(
    open_jobs: list[dict[str, Any]],
    historical_jobs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep live open nested assemblies, then add historical jobs not already present.

    Staged material_per_bom can lag live ERP, so an open job may be missing from
    history even though its children already have BOM routes. Live rows win on
    duplicate ps_id because they carry current route diagnostics.
    """
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for job in (*open_jobs, *historical_jobs):
        key = compact_text(job.get("ps_id")).upper()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(job)
    merged.sort(key=lambda job: (compact_text(job.get("due_date")) or "9999-12-31", job.get("ps_id") or ""))
    return merged


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
    open_jobs: list[dict[str, Any]] = []
    try:
        open_jobs = _fetch_assembly_jobs_uncached()
    except Exception:
        if not include_history:
            raise
        logger.exception("assembly BOM live open query failed; falling back to staged history")
    if include_history:
        historical_jobs = _fetch_historical_assembly_jobs_uncached()
        try:
            sr_jobs = _jobs_from_bom_listings(_load_sr_roots())
        except Exception:
            logger.exception("assembly BOM SR listing fallback failed")
            sr_jobs = []
        jobs = _merge_open_and_historical_jobs(open_jobs, [*historical_jobs, *sr_jobs])
    else:
        jobs = open_jobs
    _cache[include_history] = (now, jobs)
    return jobs


@assembly_bom_bp.get(ASSEMBLY_BOM_PATH)
def assembly_bom_page():
    return render_template("assembly_boms.html", active="assembly_boms")


def summarize_sr_assembly_jobs(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Slim [SR] jobs that have nested sub-assembly parts (e.g. ``N26-[SR]22``)."""
    out: list[dict[str, Any]] = []
    for job in jobs or []:
        if not is_sr_process_sheet(job.get("ps_id")):
            continue
        children: list[dict[str, Any]] = []
        for child in job.get("children") or []:
            if not child.get("is_subassembly"):
                continue
            part_no = compact_text(child.get("part_no"))
            if not part_no:
                continue
            children.append(
                {
                    "part_no": part_no,
                    "description": compact_text(child.get("description")),
                    "qty": as_float(child.get("qty")),
                    "process_sheet_no": compact_text(child.get("process_sheet_no")),
                    "is_subassembly": True,
                }
            )
        if not children:
            continue
        out.append(
            {
                "ps_id": compact_text(job.get("ps_id")),
                "part_no": compact_text(job.get("part_no")),
                "sales_order_no": compact_text(job.get("sales_order_no")),
                "children": children,
            }
        )
    return out


@assembly_bom_bp.get("/api/material-tracking/sr-assemblies")
def api_material_tracking_sr_assemblies():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    try:
        jobs = fetch_assembly_jobs(refresh=refresh, include_history=True)
        items = summarize_sr_assembly_jobs(jobs)
        return jsonify(
            {
                "ok": True,
                "count": len(items),
                "items": items,
                "fetched_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
                "cache_ttl_sec": _CACHE_TTL_SEC,
            }
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("material tracking SR assembly overlay failed")
        return jsonify({"ok": False, "error": str(exc)}), 502


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
