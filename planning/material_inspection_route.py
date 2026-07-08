"""Material inspection — synced QC inspections (stg_qc_inspection)."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .finishing_queue_service import (
    load_inspectors,
    load_mi_overlay_map,
    upsert_mi_overlay,
)
from .helpers import planner_db
from .utils import compact_text

logger = logging.getLogger(__name__)

material_inspection_bp = Blueprint("material_inspection", __name__)

_CACHE_TTL_SEC = 300
_CACHE_VERSION = 4  # bump when bucket / voucher filter logic changes
_cache: dict[str, tuple[float, int, dict[str, list[dict[str, Any]]]]] = {}

# ERP jasper view used by the QC inspection control screen (logistic shipment + QI lines).
_MATERIAL_INSPECTION_SELECT = """
SELECT
    inspection_voucher_no,
    status,
    inspector_code,
    inspector_name,
    po_no,
    supplier_code,
    supplier_name,
    source_voucher_no AS shipment_voucher_no,
    grn_no,
    item_no AS shipment_line_item_no,
    inventory_code,
    inventory_desc,
    uom,
    receiving_qty,
    inspected_qty,
    accepted_qty,
    rejected_qty,
    actual_arrival_date,
    goods_receipt_date,
    created_by_employee_code,
    created_by_employee_name,
    last_udpated_by_employee_code AS last_updated_by_employee_code,
    last_udpated_by_employee_name AS last_updated_by_employee_name,
    created_datetime,
    last_updated_datetime,
    internal_remarks,
    line_item_remarks,
    ncr_voucher_no,
    shipment_supplier_name,
    shipment_receiving_location_name,
    contact_person_name,
    generate_ncr
FROM public.zz_jasper_th5_quality_inspection_control_header
"""

_MATERIAL_INSPECTION_FILTERS = {
    "with_shipment": (
        "WHERE source_voucher_no IS NOT NULL"
        "  AND BTRIM(source_voucher_no) <> ''"
        "  AND inspection_voucher_no ~ '^QI[0-9]+$'"
    ),
    "no_shipment": (
        "WHERE (source_voucher_no IS NULL OR BTRIM(source_voucher_no) = '')"
        "  AND inspection_voucher_no ~ '^QI[0-9]+$'"
    ),
}


_STAGED_MI_SELECT = """
SELECT
    inspection_voucher_no,
    status,
    inspector_code,
    inspector_name,
    po_no,
    supplier_code,
    supplier_name,
    shipment_voucher_no,
    grn_no,
    shipment_line_item_no,
    inventory_code,
    inventory_desc,
    uom,
    receiving_qty,
    inspected_qty,
    accepted_qty,
    rejected_qty,
    actual_arrival_date,
    goods_receipt_date,
    created_by_employee_code,
    created_by_employee_name,
    last_updated_by_employee_code,
    last_updated_by_employee_name,
    created_datetime,
    last_updated_datetime,
    internal_remarks,
    line_item_remarks,
    ncr_voucher_no,
    shipment_supplier_name,
    shipment_receiving_location_name,
    contact_person_name,
    generate_ncr
FROM public.stg_qc_inspection
"""


def _material_inspection_sql(variant: str) -> tuple[str, str]:
    where = "WHERE has_shipment = true" if variant == "with_shipment" else "WHERE has_shipment = false"
    staged = f"{_STAGED_MI_SELECT}{where}\nORDER BY created_datetime DESC NULLS LAST"
    live = f"{_MATERIAL_INSPECTION_SELECT}{_MATERIAL_INSPECTION_FILTERS[variant]}\nORDER BY created_datetime DESC NULLS LAST"
    return staged, live


from .staged_erp import fetch_rows, serialize_row as _serialize_row


def _split_by_status(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    outstanding: list[dict[str, Any]] = []
    ready: list[dict[str, Any]] = []
    historical: list[dict[str, Any]] = []
    for row in rows:
        code = compact_text(row.get("status")).upper()
        if code == "H":
            historical.append(row)
        elif code == "R":
            ready.append(row)
        elif code == "O":
            outstanding.append(row)
    return {"outstanding": outstanding, "ready": ready, "historical": historical}


def invalidate_material_inspection_cache() -> None:
    global _cache
    _cache.clear()
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("material_inspection:")


def _fetch_material_inspection(
    *,
    variant: str = "with_shipment",
    refresh: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    if variant not in _MATERIAL_INSPECTION_FILTERS:
        raise ValueError(f"unknown material inspection variant: {variant}")

    now = time.time()
    cached = _cache.get(variant)
    if (
        not refresh
        and cached
        and cached[1] == _CACHE_VERSION
        and now - cached[0] < _CACHE_TTL_SEC
    ):
        return cached[2]

    staged_sql, live_sql = _material_inspection_sql(variant)
    rows = fetch_rows(staged_sql, live_sql=live_sql, staging_table="stg_qc_inspection", domain="material_inspection")
    payload = _split_by_status(rows)
    _cache[variant] = (now, _CACHE_VERSION, payload)
    return payload


def _voucher_no(row: dict[str, Any]) -> str:
    return compact_text(row.get("inspection_voucher_no"))


def _apply_assignment_overlay(
    buckets: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Merge planner-side QC assignment + done flag onto each ERP row.

    Returns the shared QC inspector team (empty on any DB hiccup so the ERP
    view still renders). Assignment is keyed by inspection voucher, so all
    lines of one inspection share the assignee. Applied per-request (not
    cached) so a fresh assignment shows immediately.
    """
    vouchers: list[str] = []
    for rows_list in buckets.values():
        for row in rows_list:
            voucher = _voucher_no(row)
            if voucher:
                vouchers.append(voucher)

    inspectors: list[dict[str, Any]] = []
    overlay_map: dict[str, dict[str, Any]] = {}
    if vouchers:
        try:
            with planner_db() as con:
                inspectors = [dict(i) for i in load_inspectors(con)]
                overlay_map = load_mi_overlay_map(con, vouchers)
        except Exception:
            logger.exception("material inspection assignment overlay load failed")
            inspectors = []
            overlay_map = {}

    for rows_list in buckets.values():
        for row in rows_list:
            overlay = overlay_map.get(_voucher_no(row)) or {}
            row["assigned_inspector_id"] = overlay.get("inspector_id")
            row["assigned_inspector_name"] = compact_text(overlay.get("inspector_name"))
            row["assignment_done"] = bool(overlay.get("done"))
            row["assignment_remarks"] = compact_text(overlay.get("remarks"))
    return inspectors


def _material_inspection_api_response(variant: str):
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        data = _fetch_material_inspection(variant=variant, refresh=refresh)
    except Exception as exc:
        logger.exception("material inspection ERP query failed (%s)", variant)
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    outstanding = data.get("outstanding") or []
    ready = data.get("ready") or []
    historical = data.get("historical") or []
    inspectors = _apply_assignment_overlay(
        {"outstanding": outstanding, "ready": ready, "historical": historical}
    )
    cached = _cache.get(variant)
    cached_at = cached[0] if cached else time.time()

    return jsonify(
        {
            "ok": True,
            "variant": variant,
            "outstanding_count": len(outstanding),
            "ready_count": len(ready),
            "historical_count": len(historical),
            "count": len(outstanding) + len(ready) + len(historical),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "inspectors": inspectors,
            "outstanding": outstanding,
            "ready": ready,
            "historical": historical,
        }
    )


def _parse_overlay_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = compact_text(value).lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


@material_inspection_bp.get("/material-inspection")
def material_inspection_page():
    return render_template(
        "material_inspection.html",
        active="material_inspection",
        mi_page_title="Material Inspection",
        mi_subtitle=(
            "Inbound logistic shipment QC inspections linked to a shipment voucher. "
            "Toggle outstanding <strong>O</strong>, ready <strong>R</strong>, or historical <strong>H</strong>. "
            "Historical is grouped by arrival week (this week, last week, then earlier). Click a row for full detail."
        ),
        mi_api_path="/api/material-inspection",
        mi_show_shipment_column=True,
    )


@material_inspection_bp.get("/material-inspection/no-shipment")
def material_inspection_no_shipment_page():
    return render_template(
        "material_inspection.html",
        active="material_inspection_no_shipment",
        mi_page_title="Material Inspection (no shipment)",
        mi_subtitle=(
            "QC inspections with <strong>no shipment voucher</strong> on the inbound line. "
            "Toggle outstanding <strong>O</strong>, ready <strong>R</strong>, or historical <strong>H</strong>. "
            "Historical is grouped by arrival week (this week, last week, then earlier). Click a row for full detail."
        ),
        mi_api_path="/api/material-inspection/no-shipment",
        mi_show_shipment_column=False,
    )


@material_inspection_bp.get("/api/material-inspection")
def api_material_inspection():
    return _material_inspection_api_response("with_shipment")


@material_inspection_bp.get("/api/material-inspection/no-shipment")
def api_material_inspection_no_shipment():
    return _material_inspection_api_response("no_shipment")


@material_inspection_bp.put("/api/material-inspection/overlay")
def api_material_inspection_overlay():
    payload = request.get_json(silent=True) or {}
    voucher = compact_text(payload.get("inspection_voucher_no"))
    if not voucher:
        return jsonify({"ok": False, "error": "inspection_voucher_no is required"}), 400

    has_inspector = "inspector_id" in payload
    inspector_raw = payload.get("inspector_id")
    inspector_id: int | None = None
    clear_inspector = has_inspector and inspector_raw in (None, "")
    if has_inspector and not clear_inspector:
        try:
            inspector_id = int(inspector_raw)
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "invalid inspector_id"}), 400

    done = _parse_overlay_bool(payload.get("done")) if "done" in payload else None
    remarks = payload.get("remarks") if "remarks" in payload else None

    if not has_inspector and done is None and remarks is None:
        return jsonify({"ok": False, "error": "inspector_id, done, or remarks is required"}), 400

    try:
        with planner_db() as con:
            row = upsert_mi_overlay(
                con,
                inspection_voucher_no=voucher,
                inspector_id=inspector_id if has_inspector and not clear_inspector else None,
                remarks=remarks,
                done=done,
                clear_inspector=clear_inspector,
            )
    except Exception as exc:
        logger.exception("material inspection overlay save failed")
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, "overlay": row})


@material_inspection_bp.post("/api/material-inspection/overlay")
def api_material_inspection_overlay_post():
    """POST alias for environments that block PUT."""
    return api_material_inspection_overlay()
