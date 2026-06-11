"""New posted sales orders — live ERP read with short-lived in-memory cache."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .utils import compact_text

logger = logging.getLogger(__name__)

new_orders_bp = Blueprint("new_orders", __name__)

_CACHE_TTL_SEC = 300
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

_FIRST_POSTED_SQL = """
SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
FROM public.so_order_rev_hst_hdr
GROUP BY sales_order_no
"""

_NEW_ORDERS_SQL = f"""
SELECT
    d.source_voucher_no,
    d.source_voucher_line_item_no,
    s.process_sheet_no,
    d.inventory_code,
    d.main_desc,
    q.required_shipment_date AS po_due_date,
    d.qty,
    s.customer_po_no,
    s.customer_po_line_item_no,
    d.status,
    d.qty_issued,
    d.invoice_no,
    d.invoice_line_item_no,
    d.shipment_voucher_no,
    d.unit_selling_price,
    d.line_item_description,
    h.arrival_date,
    h.exch_rate,
    h.do_no,
    h.do_generation_datetime,
    pp.proposed_edd,
    hdr.reference_no,
    COALESCE(rev.first_posted_datetime, hdr.posted_datetime) AS first_posted_datetime,
    hdr.posted_datetime AS latest_posted_datetime,
    hdr.customer_code,
    (d.unit_selling_price * d.qty_issued * h.exch_rate) AS total_home_amt
FROM public.lg_out_shm_detail d
LEFT JOIN public.lg_out_shm_hst_hdr h
    ON d.shipment_voucher_no = h.shipment_voucher_no
LEFT JOIN public.so_order_ost_det q
    ON d.source_voucher_no = q.sales_order_no
    AND d.source_voucher_line_item_no = q.line_item_no
LEFT JOIN public.mfg_arc_format_sourcing_v1_view s
    ON s.pk_key_sales_order_no = d.source_voucher_no
    AND s.pk_key_sales_line_item_no = d.source_voucher_line_item_no
LEFT JOIN public.mfg_pp_vch pp
    ON pp.pp_voucher_no = s.process_sheet_no
LEFT JOIN public.so_order_ost_hdr hdr
    ON hdr.sales_order_no = d.source_voucher_no
LEFT JOIN ({_FIRST_POSTED_SQL.strip()}) rev
    ON rev.sales_order_no = d.source_voucher_no
WHERE d.source_voucher_no LIKE 'SO/%%'
  AND NOT (d.status = 'History' AND d.qty_issued = 0)
  AND COALESCE(rev.first_posted_datetime, hdr.posted_datetime)::date BETWEEN %s AND %s
ORDER BY COALESCE(rev.first_posted_datetime, hdr.posted_datetime) DESC,
         d.source_voucher_no,
         d.source_voucher_line_item_no
"""


def working_week_range(for_date: date | None = None, offset_weeks: int = 0) -> tuple[date, date]:
    """Mon–Sat working week (matches planner calendar)."""
    anchor = for_date or date.today()
    monday = anchor - timedelta(days=anchor.weekday()) + timedelta(weeks=offset_weeks)
    saturday = monday + timedelta(days=5)
    return monday, saturday


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


def _erp_query(sql: str, params: tuple) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
            return [_serialize_row(dict(row)) for row in rows]
    finally:
        release_conn(conn)


def _cache_key(from_d: date, to_d: date) -> str:
    return f"{from_d.isoformat()}:{to_d.isoformat()}"


def _fetch_new_orders(from_d: date, to_d: date, *, refresh: bool = False) -> list[dict[str, Any]]:
    key = _cache_key(from_d, to_d)
    now = time.time()
    if not refresh:
        cached = _cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL_SEC:
            return cached[1]

    rows = _erp_query(_NEW_ORDERS_SQL, (from_d, to_d))
    _cache[key] = (now, rows)
    return rows


def _parse_iso_date(raw: str | None, field: str) -> date | None:
    text = compact_text(raw)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        raise ValueError(f"{field} must be YYYY-MM-DD") from None


@new_orders_bp.get("/new-orders")
def new_orders_page():
    return render_template("new_orders.html", active="new_orders")


@new_orders_bp.get("/api/new-orders")
def api_new_orders():
    week = compact_text(request.args.get("week")).lower()
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        if week == "last_week":
            from_d, to_d = working_week_range(offset_weeks=-1)
        elif week == "this_week" or (not week and not request.args.get("from")):
            from_d, to_d = working_week_range()
        else:
            from_raw = compact_text(request.args.get("from"))
            to_raw = compact_text(request.args.get("to"))
            if not from_raw or not to_raw:
                from_d, to_d = working_week_range()
            else:
                from_d = _parse_iso_date(from_raw, "from")
                to_d = _parse_iso_date(to_raw, "to")
                if from_d is None or to_d is None:
                    return jsonify({"error": "from and to are required for custom range"}), 400
                if to_d < from_d:
                    from_d, to_d = to_d, from_d
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        rows = _fetch_new_orders(from_d, to_d, refresh=refresh)
    except Exception as exc:
        logger.exception("new orders ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _cache.get(_cache_key(from_d, to_d))
    cached_at = cached[0] if cached else time.time()

    if week in {"this_week", "last_week"}:
        week_label = week
    elif compact_text(request.args.get("from")) and compact_text(request.args.get("to")):
        week_label = "custom"
    else:
        week_label = "this_week"

    return jsonify(
        {
            "ok": True,
            "from": from_d.isoformat(),
            "to": to_d.isoformat(),
            "week": week_label,
            "count": len(rows),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
