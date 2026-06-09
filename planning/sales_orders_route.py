"""Sales orders — mfg_pp_vch foundation, nested partials, so_order_view header join."""
from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .utils import compact_text

logger = logging.getLogger(__name__)

sales_orders_bp = Blueprint("sales_orders", __name__)

_CACHE_TTL_SEC = 300
_cache: tuple[float, dict[str, list[dict[str, Any]]]] | None = None
_SCHEMA_VERSION = 2

_MFG_PP_VCH_SQL = """
SELECT
    pp_voucher_no,
    inventory_code,
    bom_code,
    bom_desc,
    pp_qty,
    source_voucher_no,
    source_rsd,
    source_line_item_no,
    status,
    segment_1_code,
    proposed_edd,
    production_due_date,
    remarks,
    customer_code,
    mark_as_complete
FROM public.mfg_pp_vch
WHERE source_voucher_no IS NOT NULL
ORDER BY source_voucher_no, pp_voucher_no
"""

_MFG_PP_PARTIAL_SQL = """
SELECT
    pp_voucher_no,
    pp_partial_no,
    inventory_code,
    customer_code,
    party_name,
    customer_po_no
FROM public.mfg_pp_partial_view
ORDER BY pp_voucher_no, pp_partial_no
"""

_SO_ORDER_HEADER_SQL = """
SELECT
    sales_order_no,
    status,
    voucher_status,
    order_date,
    customer_code,
    customer_name,
    customer_short_name,
    customer_po_no,
    sales_person_code,
    sales_person_name,
    sbu_code,
    sbu_desc,
    reference_no,
    sales_quotation_no,
    total_after_tax_home_amt,
    total_pre_tax_home_amt,
    created_datetime,
    created_by_alias,
    last_updated_datetime,
    last_updated_by_alias,
    remarks,
    external_remarks,
    subject
FROM public.so_order_view
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


def _normalize_line_item_no(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = re.sub(r"\.0+$", "", text)
    return text or None


def _order_sort_key(order: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(order.get("order_date") or ""),
        str(order.get("created_datetime") or ""),
        str(order.get("sales_order_no") or ""),
    )


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


def _headers_by_sales_order(headers: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_so: dict[str, dict[str, Any]] = {}
    for row in headers:
        so_no = compact_text(row.get("sales_order_no"))
        if so_no:
            by_so[so_no] = row
    return by_so


def _partials_by_pp_voucher(partials: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for raw in partials:
        row = dict(raw)
        pp_no = compact_text(row.get("pp_voucher_no"))
        if not pp_no:
            continue
        grouped.setdefault(pp_no, []).append(row)
    for rows in grouped.values():
        rows.sort(key=lambda row: int(row.get("pp_partial_no") or 0))
    return grouped


def _build_orders_from_pp_vouchers(
    pp_rows: list[dict[str, Any]],
    partials_by_pp: dict[str, list[dict[str, Any]]],
    headers_by_so: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """mfg_pp_vch rows grouped by source_voucher_no with nested partials + SO header."""
    grouped: dict[str, dict[str, Any]] = {}

    for raw in pp_rows:
        pp = dict(raw)
        pp_no = compact_text(pp.get("pp_voucher_no"))
        so_no = compact_text(pp.get("source_voucher_no"))
        if not pp_no or not so_no:
            continue

        pp["source_line_item_no"] = _normalize_line_item_no(pp.get("source_line_item_no"))
        pp_partials = partials_by_pp.get(pp_no, [])
        pp["partials"] = pp_partials
        pp["partial_count"] = len(pp_partials)

        if so_no not in grouped:
            header = dict(headers_by_so.get(so_no, {}))
            header["sales_order_no"] = so_no
            header["has_header"] = so_no in headers_by_so
            header["pp_vouchers"] = []
            grouped[so_no] = header

        grouped[so_no]["pp_vouchers"].append(pp)

    orders: list[dict[str, Any]] = []
    for order in grouped.values():
        pp_vouchers = order.get("pp_vouchers") or []
        pp_vouchers.sort(key=lambda row: str(row.get("pp_voucher_no") or ""))
        order["pp_count"] = len(pp_vouchers)
        order["partial_count"] = sum(int(row.get("partial_count") or 0) for row in pp_vouchers)
        orders.append(order)

    orders.sort(key=_order_sort_key, reverse=True)
    return orders


def _split_by_voucher_status(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    active: list[dict[str, Any]] = []
    complete: list[dict[str, Any]] = []
    for row in rows:
        code = compact_text(row.get("voucher_status")).upper()
        if code == "C":
            complete.append(row)
        else:
            active.append(row)
    return {"active": active, "complete": complete}


def _fetch_sales_orders(*, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
    global _cache
    now = time.time()
    if not refresh and _cache and now - _cache[0] < _CACHE_TTL_SEC:
        return _cache[1]

    pp_rows = _erp_query(_MFG_PP_VCH_SQL)
    partials = _erp_query(_MFG_PP_PARTIAL_SQL)
    headers = _erp_query(_SO_ORDER_HEADER_SQL)
    orders = _build_orders_from_pp_vouchers(
        pp_rows,
        _partials_by_pp_voucher(partials),
        _headers_by_sales_order(headers),
    )
    payload = _split_by_voucher_status(orders)
    _cache = (now, payload)
    return payload


@sales_orders_bp.get("/sales-orders")
def sales_orders_page():
    return render_template("sales_orders.html", active="sales_orders")


@sales_orders_bp.get("/api/sales-orders")
def api_sales_orders():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        data = _fetch_sales_orders(refresh=refresh)
    except Exception as exc:
        logger.exception("sales orders ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    active = data.get("active") or []
    complete = data.get("complete") or []
    cached_at = _cache[0] if _cache else time.time()
    pp_count = sum(int(row.get("pp_count") or 0) for row in active + complete)
    partial_count = sum(int(row.get("partial_count") or 0) for row in active + complete)
    missing_header = sum(1 for row in active + complete if not row.get("has_header"))

    return jsonify(
        {
            "ok": True,
            "schema_version": _SCHEMA_VERSION,
            "source": "mfg_pp_vch",
            "active_count": len(active),
            "complete_count": len(complete),
            "pp_count": pp_count,
            "partial_count": partial_count,
            "missing_header_count": missing_header,
            "count": len(active) + len(complete),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "active": active,
            "complete": complete,
        }
    )
