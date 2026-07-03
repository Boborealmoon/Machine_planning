"""Material inspection — synced QC inspections (stg_qc_inspection)."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

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
            "outstanding": outstanding,
            "ready": ready,
            "historical": historical,
        }
    )


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
