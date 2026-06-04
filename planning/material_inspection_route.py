"""Material inspection status — live ERP QC job assignments vs inbound shipment lines."""
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
_cache: tuple[float, dict[str, list[dict[str, Any]]]] | None = None

_MATERIAL_INSPECTION_SQL = """
SELECT
    qja.inspection_voucher_no,
    lsv.source_voucher_no,
    qja.job_assignment_seq_no,
    qja.shipment_voucher_no,
    qja.shipment_line_item_no,
    lsv.grn_no,
    qja.inspector_code,
    qja.status,
    lsv.inventory_code,
    lsv.line_item_description,
    lsv.dt_type,
    qja.internal_remarks,
    qja.created_by,
    qja.created_datetime,
    qja.last_updated_datetime
FROM public.qc_job_assignment qja
INNER JOIN public.lg_in_shm_det_view lsv
    ON qja.shipment_voucher_no = lsv.shipment_voucher_no
    AND qja.shipment_line_item_no = lsv.line_item_no
WHERE qja.shipment_voucher_no IS NOT NULL
ORDER BY qja.created_datetime DESC NULLS LAST
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
    historical: list[dict[str, Any]] = []
    for row in rows:
        code = compact_text(row.get("status")).upper()
        if code == "H":
            historical.append(row)
        elif code == "R":
            outstanding.append(row)
    return {"outstanding": outstanding, "historical": historical}


def _fetch_material_inspection(*, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
    global _cache
    now = time.time()
    if not refresh and _cache and now - _cache[0] < _CACHE_TTL_SEC:
        return _cache[1]

    rows = _erp_query(_MATERIAL_INSPECTION_SQL)
    payload = _split_by_status(rows)
    _cache = (now, payload)
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
    historical = data.get("historical") or []
    cached_at = _cache[0] if _cache else time.time()

    return jsonify(
        {
            "ok": True,
            "outstanding_count": len(outstanding),
            "historical_count": len(historical),
            "count": len(outstanding) + len(historical),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "outstanding": outstanding,
            "historical": historical,
        }
    )
