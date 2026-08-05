"""Assembly Parts Tracker - child COMP readiness under APS/NPS parents."""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error
from .assembly_bom_route import (
    _BOM_LISTING_SQL,
    _OPEN_ROOT_SQL,
    _PROCESS_SHEET_HIERARCHY_SQL,
)
from .assembly_classify import (
    apply_stalled_child_flags,
    build_assembly_jobs,
    is_open_root,
)
from .helpers import planner_db, rows
from .staged_erp import live_query
from .utils import compact_text

logger = logging.getLogger(__name__)

assembly_parts_bp = Blueprint("assembly_parts", __name__)

ASSEMBLY_PARTS_PATH = "/assembly-parts"
_CACHE_TTL_SEC = 300
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

_CHILD_CACHE_SQL = """
SELECT DISTINCT ON (c.ps_id)
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
       c.current_stage_desc,
       c.current_stage_status
FROM pp_vouchers_cache c
WHERE c.ps_id = ANY(%s)
ORDER BY c.ps_id, c.stage_no NULLS FIRST
"""

_ALL_ROOTS_SQL = """
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
ORDER BY c.ps_id, c.pp_partial_no, c.stage_no NULLS FIRST
"""

_QUEUED_MACHINES_SQL = """
SELECT DISTINCT
    COALESCE(NULLIF(TRIM(o.source_ps_id), ''), NULLIF(TRIM(o.job_no), '')) AS raw_ps_id,
    m.machine_no
FROM planner_operation o
JOIN planner_run_block b ON b.operation_id = o.operation_id
JOIN planner_machines m ON m.machine_id = b.machine_id
WHERE COALESCE(b.active, TRUE) = TRUE
  AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
  AND m.active = TRUE
  AND COALESCE(NULLIF(TRIM(o.source_ps_id), ''), NULLIF(TRIM(o.job_no), '')) <> ''
ORDER BY raw_ps_id, m.machine_no
"""


def _ps_base_id(ps_id: str) -> str:
    return compact_text(ps_id).split("::")[0]


def _serialize_overlay_date(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ", timespec="seconds")
    text = compact_text(value)
    return text or None


def _load_material_in(process_sheet_nos: list[str]) -> dict[str, dict[str, Any]]:
    bases: list[str] = []
    seen: set[str] = set()
    for raw in process_sheet_nos:
        base = _ps_base_id(raw)
        if not base or base in seen:
            continue
        seen.add(base)
        bases.append(base)
    if not bases:
        return {}
    default = {"material_in": False, "material_in_date": None}
    try:
        from .process_sheets import _ensure_planner_overlay_columns

        with planner_db() as con:
            _ensure_planner_overlay_columns(con)
            fetched = rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id,
                           COALESCE(material_in, FALSE) AS material_in,
                           material_in_date
                    FROM planner_process_sheet
                    WHERE planner_ps_id = ANY(%s)
                       OR source_ps_id = ANY(%s)
                       OR split_part(planner_ps_id, '::', 1) = ANY(%s)
                    """,
                    (bases, bases, bases),
                )
            )
    except Exception as exc:
        logger.warning("assembly parts material_in overlay skipped: %s", exc)
        return {base: dict(default) for base in bases}

    out = {base: dict(default) for base in bases}
    for row in fetched:
        payload = {
            "material_in": bool(row.get("material_in")),
            "material_in_date": _serialize_overlay_date(row.get("material_in_date")),
        }
        for key in (
            compact_text(row.get("planner_ps_id")),
            compact_text(row.get("source_ps_id")),
        ):
            base = _ps_base_id(key)
            if base in out:
                out[base] = payload
    return out


def _load_logistics_notes(process_sheet_nos: list[str]) -> dict[str, dict[str, Any]]:
    """Material arrival date + remark notes from Material Tracking overlays."""
    bases: list[str] = []
    seen: set[str] = set()
    for raw in process_sheet_nos:
        base = _ps_base_id(raw)
        if not base or base in seen:
            continue
        seen.add(base)
        bases.append(base)
    if not bases:
        return {}
    default = {"material_subcon": "", "mtl_part_order": ""}
    try:
        from .sales_orders_route import _ensure_notes_table

        with planner_db() as con:
            _ensure_notes_table(con)
            fetched = rows(
                con.execute(
                    """
                    SELECT pp_voucher_no, material_subcon, mtl_part_order
                    FROM planner_so_pp_notes
                    WHERE pp_voucher_no = ANY(%s)
                    """,
                    (bases,),
                )
            )
    except Exception as exc:
        logger.warning("assembly parts logistics notes overlay skipped: %s", exc)
        return {base: dict(default) for base in bases}

    out = {base: dict(default) for base in bases}
    for row in fetched:
        key = _ps_base_id(compact_text(row.get("pp_voucher_no")))
        if key not in out:
            continue
        out[key] = {
            "material_subcon": compact_text(row.get("material_subcon")),
            "mtl_part_order": compact_text(row.get("mtl_part_order")),
        }
    return out


def _load_queued_machines() -> dict[str, list[str]]:
    from .catalog import _canonical_catalog_ps_id

    out: dict[str, list[str]] = {}
    try:
        with planner_db() as con:
            fetched = rows(con.execute(_QUEUED_MACHINES_SQL))
    except Exception as exc:
        logger.warning("assembly parts queued machines overlay skipped: %s", exc)
        return out
    for row in fetched:
        raw_ps_id = compact_text(row.get("raw_ps_id"))
        machine = compact_text(row.get("machine_no"))
        if not raw_ps_id or not machine:
            continue
        canonical = _canonical_catalog_ps_id(raw_ps_id)
        if not canonical:
            continue
        bucket = out.setdefault(canonical, [])
        if machine not in bucket:
            bucket.append(machine)
    return out


def _machines_for_ps(by_canonical: dict[str, list[str]], ps_id: str) -> list[str]:
    from .catalog import _canonical_catalog_ps_id, _catalog_op_qty_ps_ids

    machines: list[str] = []
    base = _ps_base_id(ps_id)
    if not base:
        return machines
    for variant in _catalog_op_qty_ps_ids(base):
        canonical = _canonical_catalog_ps_id(variant)
        for machine in by_canonical.get(canonical, []):
            if machine not in machines:
                machines.append(machine)
    return machines


def _child_ready(child: dict[str, Any]) -> bool:
    if child.get("missing_comp_sheet"):
        return False
    status = compact_text(child.get("status")).lower()
    if status in {"history", "completed", "complete"}:
        return True
    stage_status = compact_text(child.get("current_stage_status")).upper()
    if stage_status in {"C", "COMPLETE", "COMPLETED"}:
        return True
    so_qty = child.get("so_det_qty")
    if so_qty is not None and is_open_root(
        {
            "status": child.get("status"),
            "so_det_qty": so_qty,
            "qty_shipped": child.get("qty_shipped"),
        }
    ) is False and status not in {"cancelled", "canceled", "void"}:
        # fully shipped counts as ready for rollup
        from .utils import shipped_quantity_completed

        if shipped_quantity_completed(so_qty, child.get("qty_shipped")):
            return True
    return False


def _enrich_families(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    child_ids = sorted(
        {
            compact_text(child.get("process_sheet_no"))
            for job in jobs
            for child in (job.get("children") or [])
            if compact_text(child.get("process_sheet_no"))
        }
    )
    cache_by_ps: dict[str, dict[str, Any]] = {}
    if child_ids:
        try:
            with planner_db() as con:
                for row in rows(con.execute(_CHILD_CACHE_SQL, (child_ids,))):
                    cache_by_ps[compact_text(row.get("ps_id")).upper()] = row
        except Exception as exc:
            logger.warning("assembly parts child cache load skipped: %s", exc)

    material_in = _load_material_in(child_ids)
    logistics_notes = _load_logistics_notes(child_ids)
    queued = _load_queued_machines()

    for job in jobs:
        ready = 0
        for child in job.get("children") or []:
            ps_no = compact_text(child.get("process_sheet_no"))
            cache = cache_by_ps.get(ps_no.upper(), {}) if ps_no else {}
            if cache:
                child["status"] = compact_text(cache.get("status") or child.get("status"))
                child["due_date"] = compact_text(cache.get("due_date") or job.get("due_date"))
                child["current_stage_desc"] = compact_text(cache.get("current_stage_desc"))
                child["current_stage_status"] = compact_text(cache.get("current_stage_status"))
                child["qty_shipped"] = cache.get("qty_shipped")
                child["so_det_qty"] = cache.get("so_det_qty")
                child["sales_order_no"] = compact_text(
                    cache.get("sales_order_no") or job.get("sales_order_no")
                )
                if not child.get("description"):
                    child["description"] = compact_text(cache.get("part_desc"))
                ps_bom = compact_text(cache.get("bom_code"))
                if ps_bom:
                    child["ps_bom_code"] = ps_bom
            else:
                child.setdefault("status", "")
                child.setdefault("due_date", compact_text(job.get("due_date")))
                child.setdefault("current_stage_desc", "")
                child.setdefault("current_stage_status", "")
                child.setdefault("sales_order_no", compact_text(job.get("sales_order_no")))

            base = _ps_base_id(ps_no)
            mi = material_in.get(base, {"material_in": False, "material_in_date": None})
            notes = logistics_notes.get(
                base,
                {"material_subcon": "", "mtl_part_order": ""},
            )
            child["material_in"] = bool(mi.get("material_in"))
            child["material_in_date"] = mi.get("material_in_date")
            child["material_subcon"] = compact_text(notes.get("material_subcon"))
            child["remark"] = compact_text(notes.get("mtl_part_order"))
            machines = _machines_for_ps(queued, ps_no) if ps_no else []
            child["queued_machines"] = machines
            child["needs_scheduling"] = bool(
                ps_no
                and not machines
                and compact_text(child.get("status")).lower()
                not in {"history", "completed", "complete", "cancelled", "canceled", "void"}
                and child.get("in_house") is not False
                and not child.get("missing_comp_sheet")
            )
            child["ready"] = _child_ready(child)
            if child["ready"]:
                ready += 1
            child["process_sheets_url"] = f"/process-sheets?q={ps_no}" if ps_no else "/process-sheets"
            child["sales_orders_url"] = (
                f"/sales-orders?q={compact_text(child.get('sales_order_no') or job.get('sales_order_no'))}"
                if compact_text(child.get("sales_order_no") or job.get("sales_order_no"))
                else "/sales-orders"
            )

        apply_stalled_child_flags(job)
        total = len(job.get("children") or [])
        job["children_ready"] = ready
        job["children_total"] = total
        job["readiness_label"] = f"{ready}/{total}"
        job["has_issues"] = bool(job.get("warning_flags")) or any(
            child.get("stalled") or child.get("missing_comp_sheet")
            for child in (job.get("children") or [])
        )
        job["process_sheets_url"] = f"/process-sheets?q={compact_text(job.get('ps_id'))}"
        so = compact_text(job.get("sales_order_no"))
        job["sales_orders_url"] = f"/sales-orders?q={so}" if so else "/sales-orders"
    return jobs


def _load_roots(*, view: str) -> list[dict[str, Any]]:
    """Active = open roots; complete = non-open APS/NPS from cache (still need COMP hierarchy)."""
    with planner_db() as con:
        if view == "complete":
            all_roots = rows(con.execute(_ALL_ROOTS_SQL))
            return [row for row in all_roots if not is_open_root(row)]
        return [row for row in rows(con.execute(_OPEN_ROOT_SQL)) if is_open_root(row)]


def _fetch_assembly_parts_uncached(*, view: str) -> list[dict[str, Any]]:
    roots = _load_roots(view=view)
    ps_ids = sorted({compact_text(row.get("ps_id")) for row in roots if compact_text(row.get("ps_id"))})
    if not ps_ids:
        return []
    hierarchy_rows = live_query(_PROCESS_SHEET_HIERARCHY_SQL, (ps_ids,))
    component_ps_ids = {
        compact_text(row.get("pp_voucher_no")).upper()
        for row in hierarchy_rows
        if compact_text(row.get("type")).upper() == "COMP"
    }
    roots = [row for row in roots if compact_text(row.get("ps_id")).upper() in component_ps_ids]
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
    jobs = build_assembly_jobs(
        roots,
        hierarchy_rows,
        bom_rows,
        require_subassembly_children=False,
    )
    return _enrich_families(jobs)


def _overlay_editable_fields(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Refresh material arrival / remark fields without rebuilding the assembly tree."""
    child_ids = sorted(
        {
            compact_text(child.get("process_sheet_no"))
            for job in jobs
            for child in (job.get("children") or [])
            if compact_text(child.get("process_sheet_no"))
        }
    )
    material_in = _load_material_in(child_ids)
    logistics_notes = _load_logistics_notes(child_ids)
    for job in jobs:
        for child in job.get("children") or []:
            ps_no = compact_text(child.get("process_sheet_no"))
            base = _ps_base_id(ps_no)
            mi = material_in.get(base, {"material_in": False, "material_in_date": None})
            notes = logistics_notes.get(
                base,
                {"material_subcon": "", "mtl_part_order": ""},
            )
            child["material_in"] = bool(mi.get("material_in"))
            child["material_in_date"] = mi.get("material_in_date")
            child["material_subcon"] = compact_text(notes.get("material_subcon"))
            child["remark"] = compact_text(notes.get("mtl_part_order"))
    return jobs


def fetch_assembly_parts(*, refresh: bool = False, view: str = "active") -> list[dict[str, Any]]:
    global _cache
    view_key = "complete" if view == "complete" else "active"
    now = time.time()
    cached = _cache.get(view_key)
    if not refresh and cached and now - cached[0] < _CACHE_TTL_SEC:
        # Structure is cached; always re-read editable logistics notes.
        return _overlay_editable_fields(cached[1])
    jobs = _fetch_assembly_parts_uncached(view=view_key)
    _cache[view_key] = (now, jobs)
    return jobs


@assembly_parts_bp.get(ASSEMBLY_PARTS_PATH)
def assembly_parts_page():
    return render_template("assembly_parts.html", active="assembly_parts")


@assembly_parts_bp.get("/api/assembly-parts")
def api_assembly_parts():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    view = compact_text(request.args.get("view") or "active").lower()
    if view not in {"active", "complete"}:
        view = "active"
    try:
        jobs = fetch_assembly_parts(refresh=refresh, view=view)
        child_count = sum(len(job.get("children") or []) for job in jobs)
        return jsonify(
            {
                "ok": True,
                "view": view,
                "count": len(jobs),
                "child_count": child_count,
                "issue_count": sum(1 for job in jobs if job.get("has_issues")),
                "items": jobs,
                "fetched_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
                "cache_ttl_sec": _CACHE_TTL_SEC,
            }
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("assembly parts query failed")
        return jsonify({"ok": False, "error": str(exc)}), 502
