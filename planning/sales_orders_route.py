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

from db import planner_db_connect_error
from .helpers import planner_db, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

sales_orders_bp = Blueprint("sales_orders", __name__)

_CACHE_TTL_SEC = 300
_cache: tuple[float, dict[str, list[dict[str, Any]]]] | None = None
_SCHEMA_VERSION = 4

_NOTE_FIELDS = (
    "material_subcon",
    "mtl_part_order",
    "quality_doc",
    "ops_notes",
    "sales_notes",
)

_MFG_PP_VCH_SQL = """
SELECT
    pp.pp_voucher_no,
    pp.inventory_code,
    pp.bom_code,
    pp.bom_desc,
    pp.pp_qty,
    pp.source_voucher_no,
    pp.source_rsd,
    pp.source_line_item_no,
    pp.status,
    pp.segment_1_code,
    pp.proposed_edd,
    pp.production_due_date,
    pp.remarks,
    pp.customer_code,
    pp.mark_as_complete,
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS process_sheet_no,
    COALESCE(ps.sales_order_date, hdr.order_date) AS order_date,
    COALESCE(NULLIF(TRIM(pd.main_desc), ''), NULLIF(TRIM(pp.bom_desc), '')) AS description,
    COALESCE(NULLIF(TRIM(part.customer_po_no), ''), NULLIF(TRIM(hdr.customer_po_no), '')) AS customer_po_no,
    COALESCE(det.required_shipment_date, pp.source_rsd) AS due_date,
    pp.proposed_edd AS delivery_date,
    det.unit_selling_price,
    (det.unit_selling_price * pp.pp_qty) AS amount
FROM public.mfg_pp_vch pp
LEFT JOIN public.mfg_process_sheet_info ps
       ON ps.pp_voucher_no = pp.pp_voucher_no
LEFT JOIN public.part_desc pd
       ON pd.inventory_code = COALESCE(ps.inventory_code, pp.inventory_code)
LEFT JOIN public.so_order_view hdr
       ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.so_order_ost_det det
       ON det.sales_order_no = pp.source_voucher_no
      AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT pp_voucher_no, MAX(customer_po_no) AS customer_po_no
    FROM public.mfg_pp_partial_view
    GROUP BY pp_voucher_no
) part ON part.pp_voucher_no = pp.pp_voucher_no
WHERE pp.source_voucher_no IS NOT NULL
ORDER BY pp.source_voucher_no, pp.pp_voucher_no
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

_SO_POSTED_DATES_SQL = """
SELECT
    h.sales_order_no,
    COALESCE(rev.first_posted_datetime, h.posted_datetime) AS first_posted_datetime,
    h.posted_datetime AS latest_posted_datetime
FROM public.so_order_ost_hdr h
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = h.sales_order_no
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
        str(order.get("first_posted_datetime") or order.get("order_date") or ""),
        str(order.get("created_datetime") or ""),
        str(order.get("sales_order_no") or ""),
    )


def _erp_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows_out = cur.fetchall()
            return [_serialize_row(dict(row)) for row in rows_out]
    finally:
        release_conn(conn)


def _headers_by_sales_order(headers: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_so: dict[str, dict[str, Any]] = {}
    for row in headers:
        so_no = compact_text(row.get("sales_order_no"))
        if so_no:
            by_so[so_no] = row
    return by_so


def _posted_dates_by_sales_order(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_so: dict[str, dict[str, Any]] = {}
    for row in rows:
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
    for pp_rows in grouped.values():
        pp_rows.sort(key=lambda row: int(row.get("pp_partial_no") or 0))
    return grouped


def _empty_notes() -> dict[str, str]:
    return {field: "" for field in _NOTE_FIELDS}


def _notes_from_row(row: dict[str, Any] | None) -> dict[str, str]:
    if not row:
        return _empty_notes()
    return {field: compact_text(row.get(field)) for field in _NOTE_FIELDS}


def _ensure_notes_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_so_pp_notes (
            pp_voucher_no       TEXT         PRIMARY KEY,
            material_subcon     TEXT         NOT NULL DEFAULT '',
            mtl_part_order      TEXT         NOT NULL DEFAULT '',
            quality_doc         TEXT         NOT NULL DEFAULT '',
            ops_notes           TEXT         NOT NULL DEFAULT '',
            sales_notes         TEXT         NOT NULL DEFAULT '',
            updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )


def _load_notes_map(pp_voucher_nos: list[str]) -> dict[str, dict[str, str]]:
    ids = [compact_text(v) for v in pp_voucher_nos if compact_text(v)]
    if not ids:
        return {}
    try:
        with planner_db() as con:
            _ensure_notes_table(con)
            fetched = rows(
                con.execute(
                    """
                    SELECT pp_voucher_no, material_subcon, mtl_part_order,
                           quality_doc, ops_notes, sales_notes
                    FROM planner_so_pp_notes
                    WHERE pp_voucher_no = ANY(%s)
                    """,
                    (ids,),
                )
            )
    except Exception as exc:
        logger.warning("planner_so_pp_notes load skipped: %s", exc)
        return {}

    out: dict[str, dict[str, str]] = {}
    for row in fetched:
        key = compact_text(row.get("pp_voucher_no"))
        if key:
            out[key] = _notes_from_row(row)
    return out


def _build_orders_from_pp_vouchers(
    pp_rows: list[dict[str, Any]],
    partials_by_pp: dict[str, list[dict[str, Any]]],
    headers_by_so: dict[str, dict[str, Any]],
    posted_by_so: dict[str, dict[str, Any]] | None = None,
    notes_by_pp: dict[str, dict[str, str]] | None = None,
) -> list[dict[str, Any]]:
    """mfg_pp_vch rows grouped by source_voucher_no with nested partials + SO header."""
    grouped: dict[str, dict[str, Any]] = {}
    notes_map = notes_by_pp or {}

    for raw in pp_rows:
        pp = dict(raw)
        pp_no = compact_text(pp.get("pp_voucher_no"))
        so_no = compact_text(pp.get("source_voucher_no"))
        if not pp_no or not so_no:
            continue

        pp["source_line_item_no"] = _normalize_line_item_no(pp.get("source_line_item_no"))
        pp["partials"] = partials_by_pp.get(pp_no, [])
        pp["partial_count"] = len(pp["partials"])
        pp.update(notes_map.get(pp_no, _empty_notes()))

        if so_no not in grouped:
            header = dict(headers_by_so.get(so_no, {}))
            header["sales_order_no"] = so_no
            header["has_header"] = so_no in headers_by_so
            posted = dict((posted_by_so or {}).get(so_no, {}))
            header["first_posted_datetime"] = posted.get("first_posted_datetime")
            header["latest_posted_datetime"] = posted.get("latest_posted_datetime")
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
    notes_map = _load_notes_map([str(row.get("pp_voucher_no") or "") for row in pp_rows])
    partials = _erp_query(_MFG_PP_PARTIAL_SQL)
    headers = _erp_query(_SO_ORDER_HEADER_SQL)
    posted_dates = _erp_query(_SO_POSTED_DATES_SQL)
    orders = _build_orders_from_pp_vouchers(
        pp_rows,
        _partials_by_pp_voucher(partials),
        _headers_by_sales_order(headers),
        _posted_dates_by_sales_order(posted_dates),
        notes_map,
    )
    payload = _split_by_voucher_status(orders)
    _cache = (now, payload)
    return payload


def _upsert_notes(pp_voucher_no: str, patch: dict[str, str]) -> dict[str, Any]:
    with planner_db() as con:
        _ensure_notes_table(con)
        existing = rows(
            con.execute(
                """
                SELECT pp_voucher_no, material_subcon, mtl_part_order,
                       quality_doc, ops_notes, sales_notes
                FROM planner_so_pp_notes
                WHERE pp_voucher_no = %s
                """,
                (pp_voucher_no,),
            )
        )
        current = _notes_from_row(existing[0] if existing else None)
        current.update(patch)
        con.execute(
            """
            INSERT INTO planner_so_pp_notes (
                pp_voucher_no, material_subcon, mtl_part_order,
                quality_doc, ops_notes, sales_notes, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (pp_voucher_no) DO UPDATE SET
                material_subcon = EXCLUDED.material_subcon,
                mtl_part_order = EXCLUDED.mtl_part_order,
                quality_doc = EXCLUDED.quality_doc,
                ops_notes = EXCLUDED.ops_notes,
                sales_notes = EXCLUDED.sales_notes,
                updated_at = NOW()
            """,
            (
                pp_voucher_no,
                current["material_subcon"],
                current["mtl_part_order"],
                current["quality_doc"],
                current["ops_notes"],
                current["sales_notes"],
            ),
        )
        return {"pp_voucher_no": pp_voucher_no, **current}


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


@sales_orders_bp.patch("/api/sales-orders/notes/<path:pp_voucher_no>")
@sales_orders_bp.put("/api/sales-orders/notes/<path:pp_voucher_no>")
def api_sales_order_notes(pp_voucher_no):
    pp_voucher_no = compact_text(pp_voucher_no)
    if not pp_voucher_no:
        return jsonify({"error": "pp_voucher_no is required"}), 400

    data = request.get_json(force=True, silent=True) or {}
    patch: dict[str, str] = {}
    for field in _NOTE_FIELDS:
        if field in data:
            patch[field] = compact_text(data.get(field))

    if not patch:
        return jsonify({"error": "No editable fields supplied"}), 400

    try:
        payload = _upsert_notes(pp_voucher_no, patch)
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        logger.exception("sales order notes save failed")
        return jsonify({"error": str(exc)}), 500

    if _cache:
        for bucket in ("active", "complete"):
            for order in _cache[1].get(bucket, []):
                for pp in order.get("pp_vouchers") or []:
                    if compact_text(pp.get("pp_voucher_no")) == pp_voucher_no:
                        pp.update(payload)

    return jsonify({"ok": True, **payload})
