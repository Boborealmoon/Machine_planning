"""Material inspection — live ERP QC inspections on inbound logistic shipments."""
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
_CACHE_VERSION = 3  # bump when bucket / voucher filter logic changes
_cache: tuple[float, int, dict[str, list[dict[str, Any]]]] | None = None

# ERP jasper view used by the QC inspection control screen (logistic shipment + QI lines).
_MATERIAL_INSPECTION_SQL = """
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
WHERE source_voucher_no IS NOT NULL
  AND BTRIM(source_voucher_no) <> ''
  AND inspection_voucher_no ~ '^QI[0-9]+$'
ORDER BY created_datetime DESC NULLS LAST
"""


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


def _erp_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
            return [_serialize_row(dict(row)) for row in rows]
    finally:
        release_conn(conn)


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


def _fetch_material_inspection(*, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
    global _cache
    now = time.time()
    if (
        not refresh
        and _cache
        and _cache[1] == _CACHE_VERSION
        and now - _cache[0] < _CACHE_TTL_SEC
    ):
        return _cache[2]

    rows = _erp_query(_MATERIAL_INSPECTION_SQL)
    payload = _split_by_status(rows)
    _cache = (now, _CACHE_VERSION, payload)
    return payload


@material_inspection_bp.get("/material-inspection")
def material_inspection_page():
    return render_template("material_inspection.html", active="material_inspection")


@material_inspection_bp.get("/api/material-inspection")
def api_material_inspection():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        data = _fetch_material_inspection(refresh=refresh)
    except Exception as exc:
        logger.exception("material inspection ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    outstanding = data.get("outstanding") or []
    ready = data.get("ready") or []
    historical = data.get("historical") or []
    cached_at = _cache[0] if _cache else time.time()

    return jsonify(
        {
            "ok": True,
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
