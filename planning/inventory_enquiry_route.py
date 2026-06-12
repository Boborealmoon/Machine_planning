"""Inventory enquiry — live ERP mt_inventory master read."""
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

inventory_enquiry_bp = Blueprint("inventory_enquiry", __name__)

_CACHE_TTL_SEC = 300
_CACHE_VERSION = 1
_cache: tuple[float, int, list[dict[str, Any]]] | None = None

_BYTEA_COLS = frozenset({"inventory_image", "thumbnail"})

_CLASS_KEY_BY_CODE = {
    "RAW MATERIAL": "raw_material",
    "FG MFG COMMERCIAL": "fg_mfg_commercial",
    "FG MRO": "fg_mro",
    "CP": "cp",
    "CFM": "cfm",
}

_INVENTORY_SQL = """
SELECT *
FROM public.mt_inventory
WHERE inventory_code IS NOT NULL
  AND BTRIM(inventory_code) <> ''
ORDER BY
    inventory_class_code NULLS LAST,
    inventory_code
"""


def _class_key(row: dict[str, Any]) -> str:
    code = compact_text(row.get("inventory_class_code")).upper()
    return _CLASS_KEY_BY_CODE.get(code, "other")


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (bytes, memoryview)):
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    out = {key: _serialize_value(val) for key, val in row.items() if key not in _BYTEA_COLS}
    out["class_key"] = _class_key(out)
    return out


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


def _class_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {key: 0 for key in _CLASS_KEY_BY_CODE.values()}
    counts["other"] = 0
    counts["all"] = len(rows)
    for row in rows:
        key = row.get("class_key") or "other"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _status_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    active = 0
    suspended = 0
    for row in rows:
        if compact_text(row.get("is_suspend")).upper() == "Y":
            suspended += 1
        else:
            active += 1
    return {"active": active, "suspended": suspended}


def _fetch_inventory(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _cache
    now = time.time()
    if (
        not refresh
        and _cache
        and _cache[1] == _CACHE_VERSION
        and now - _cache[0] < _CACHE_TTL_SEC
    ):
        return _cache[2]

    rows = _erp_query(_INVENTORY_SQL)
    _cache = (now, _CACHE_VERSION, rows)
    return rows


@inventory_enquiry_bp.get("/planning-data/inventory-enquiry")
def inventory_enquiry_page():
    return render_template("inventory_enquiry.html", active="planning_data")


@inventory_enquiry_bp.get("/api/inventory-enquiry")
def api_inventory_enquiry():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        rows = _fetch_inventory(refresh=refresh)
    except Exception as exc:
        logger.exception("inventory enquiry ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached_at = _cache[0] if _cache else time.time()
    return jsonify(
        {
            "ok": True,
            "count": len(rows),
            "class_counts": _class_counts(rows),
            "status_counts": _status_counts(rows),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
