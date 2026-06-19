"""Monthly sales report — backlog on hand, shipments, YTD grid."""
from __future__ import annotations

import calendar
import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .sales_report_alloc import (
    attribute_shipments,
    build_allocated_open_lines,
    index_pp_jobs_by_so_line,
    index_so_lines,
    integrity_check,
    ps_type_from_process_sheet,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

sales_report_bp = Blueprint("sales_report", __name__)

_CACHE_TTL_SEC = 300
_monthly_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_ytd_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_PP_TYPES = ("MPS", "APS", "NPS", "PPS", "CPS", "SR")
_YTD_ROW_TYPES = ("APS", "NPS", "PPS")

_FIRST_POSTED_SQL = """
SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
FROM public.so_order_rev_hst_hdr
GROUP BY sales_order_no
"""

_PS_SOURCING_JOIN = """
LEFT JOIN public.mfg_arc_format_sourcing_v1_view src
       ON src.pk_key_sales_order_no = {so_col}
      AND regexp_replace(src.pk_key_sales_line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace({line_col}::TEXT, '\\.0+$', '')
"""

# One row per SO line — authoritative remaining qty/$ (no PP join duplication).
_SO_LINES_SQL = """
SELECT
    det.sales_order_no,
    regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    det.inventory_code,
    NULLIF(TRIM(det.line_item_description), '') AS description,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped,
    GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) AS remaining_qty,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    (
        GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0))
        * COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price)
    ) AS remaining_value,
    det.required_shipment_date::date AS due_date,
    hdr.customer_code,
    hdr.customer_name,
    hdr.sales_person_name,
    hdr.sbu_desc,
    COALESCE(rev.first_posted_datetime, ost.posted_datetime) AS first_posted_datetime
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr ost ON ost.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view hdr ON hdr.sales_order_no = det.sales_order_no
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = det.sales_order_no
      AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = det.sales_order_no
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(ost.status, '') <> 'V'
  AND GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) > 0.0001
ORDER BY det.required_shipment_date NULLS LAST, det.sales_order_no, line_item_no
"""

# One row per PP voucher (process sheet job) — many may share one SO line.
_PP_JOBS_SQL = """
SELECT
    pp.pp_voucher_no,
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS process_sheet_no,
    pp.source_voucher_no AS sales_order_no,
    regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    COALESCE(ps.inventory_code, pp.inventory_code) AS inventory_code,
    pp.pp_qty,
    pp.proposed_edd::date AS proposed_edd,
    pp.production_due_date::date AS production_due_date,
    COALESCE(det.required_shipment_date, pp.source_rsd)::date AS so_due_date,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS so_line_qty_shipped
FROM public.mfg_pp_vch pp
LEFT JOIN (
    SELECT DISTINCT ON (pp_voucher_no)
        pp_voucher_no,
        process_sheet_no,
        inventory_code
    FROM public.mfg_process_sheet_info_v1_view
    ORDER BY pp_voucher_no, process_sheet_no
) ps ON ps.pp_voucher_no = pp.pp_voucher_no
LEFT JOIN public.so_order_ost_det det
       ON det.sales_order_no = pp.source_voucher_no
      AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
WHERE pp.source_voucher_no LIKE 'SO/%%'
ORDER BY pp.source_voucher_no, line_item_no, pp.pp_voucher_no
"""

_PP_PARTIALS_SQL = """
SELECT
    pp_voucher_no,
    pp_partial_no,
    partial_qty,
    production_due_date::date AS production_due_date,
    proposed_edd::date AS proposed_edd
FROM public.mfg_pp_partial
ORDER BY pp_voucher_no, pp_partial_no
"""

_OPEN_LINES_SQL = _SO_LINES_SQL

_SHIPMENTS_SQL = """
SELECT
    d.source_voucher_no AS sales_order_no,
    regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    d.inventory_code,
    NULLIF(TRIM(d.main_desc), '') AS description,
    d.qty_issued,
    d.unit_selling_price,
    COALESCE(h.exch_rate, 1) AS exch_rate,
    (d.unit_selling_price * d.qty_issued * COALESCE(h.exch_rate, 1)) AS total_home_amt,
    d.shipment_voucher_no,
    d.invoice_no,
    d.invoice_line_item_no,
    COALESCE(h.do_generation_datetime, h.arrival_date) AS shipment_datetime,
    COALESCE(h.do_generation_datetime, h.arrival_date)::date AS shipment_date,
    so_det.required_shipment_date::date AS due_date,
    v.customer_code,
    v.customer_name,
    v.sales_person_name,
    v.sbu_desc,
    COALESCE(rev.first_posted_datetime, hdr.posted_datetime) AS first_posted_datetime,
    (
        COALESCE(rev.first_posted_datetime, hdr.posted_datetime)::date < %s::date
    ) AS is_backlog_clear
FROM public.lg_out_shm_detail d
LEFT JOIN public.lg_out_shm_hst_hdr h
       ON d.shipment_voucher_no = h.shipment_voucher_no
LEFT JOIN public.so_order_ost_hdr hdr
       ON hdr.sales_order_no = d.source_voucher_no
LEFT JOIN public.so_order_view v
       ON v.sales_order_no = d.source_voucher_no
LEFT JOIN public.so_order_ost_det so_det
       ON so_det.sales_order_no = d.source_voucher_no
      AND regexp_replace(so_det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = d.source_voucher_no
WHERE d.source_voucher_no LIKE 'SO/%%'
  AND NOT (d.status = 'History' AND COALESCE(d.qty_issued, 0) = 0)
  AND COALESCE(h.do_generation_datetime, h.arrival_date)::date BETWEEN %s AND %s
ORDER BY shipment_datetime DESC, d.source_voucher_no, line_item_no
"""

_BOOKED_SQL = f"""
SELECT
    det.sales_order_no,
    regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    det.inventory_code,
    NULLIF(TRIM(det.line_item_description), '') AS description,
    det.qty,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    (
        det.qty * COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price)
    ) AS line_amount,
    det.required_shipment_date::date AS due_date,
    COALESCE(rev.first_posted_datetime, hdr.posted_datetime) AS first_posted_datetime,
    v.customer_code,
    v.customer_name,
    v.sales_person_name,
    v.sbu_desc
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr hdr ON hdr.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view v ON v.sales_order_no = det.sales_order_no
LEFT JOIN ({_FIRST_POSTED_SQL.strip()}) rev
       ON rev.sales_order_no = det.sales_order_no
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(hdr.status, '') <> 'V'
  AND COALESCE(rev.first_posted_datetime, hdr.posted_datetime)::date BETWEEN %s AND %s
ORDER BY first_posted_datetime DESC, det.sales_order_no, line_item_no
"""


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, tuple):
        return [_serialize_value(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bool):
        return value
    return value


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


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


def _sum_field(rows: list[dict[str, Any]], field: str) -> float:
    total = 0.0
    for row in rows:
        try:
            total += float(row.get(field) or 0)
        except (TypeError, ValueError):
            continue
    return total


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


def _parse_date_value(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = compact_text(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")[:19]).date()
    except ValueError:
        pass
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _ps_type(process_sheet_no: Any, pp_type: Any = None) -> str | None:
    if compact_text(pp_type):
        return compact_text(pp_type)
    return ps_type_from_process_sheet(process_sheet_no)


def _open_value(row: dict[str, Any]) -> float:
    try:
        if row.get("allocated_remaining_value") is not None:
            return float(row["allocated_remaining_value"])
        return float(row.get("remaining_value") or 0)
    except (TypeError, ValueError):
        return 0.0


def _open_qty(row: dict[str, Any]) -> float:
    try:
        if row.get("allocated_remaining_qty") is not None:
            return float(row["allocated_remaining_qty"])
        return float(row.get("remaining_qty") or 0)
    except (TypeError, ValueError):
        return 0.0


def _is_past_month(year: int, month: int, *, today: date | None = None) -> bool:
    anchor = today or date.today()
    if year < anchor.year:
        return True
    if year > anchor.year:
        return False
    return month < anchor.month


def _month_mode(year: int, month: int, *, today: date | None = None) -> str:
    return "past" if _is_past_month(year, month, today=today) else "open"


def _due_in_month(row: dict[str, Any], start_d: date, end_d: date) -> bool:
    due = _parse_date_value(row.get("due_date"))
    return due is not None and start_d <= due <= end_d


def _due_before_month(row: dict[str, Any], start_d: date) -> bool:
    due = _parse_date_value(row.get("due_date"))
    return due is not None and due < start_d


def _due_after_month(row: dict[str, Any], end_d: date) -> bool:
    due = _parse_date_value(row.get("due_date"))
    return due is not None and due > end_d


def _shipment_in_month(row: dict[str, Any], start_d: date, end_d: date) -> bool:
    ship = _parse_date_value(row.get("shipment_date") or row.get("shipment_datetime"))
    return ship is not None and start_d <= ship <= end_d


def _build_open_month_summary(
    open_lines: list[dict[str, Any]],
    start_d: date,
    end_d: date,
) -> dict[str, Any]:
    due_lines = [row for row in open_lines if _due_in_month(row, start_d, end_d)]
    overdue_lines = [row for row in open_lines if _due_before_month(row, start_d)]
    return {
        "mode": "open",
        "due_this_month": {
            "line_count": len(due_lines),
            "remaining_qty": sum(_open_qty(row) for row in due_lines),
            "remaining_value": sum(_open_value(row) for row in due_lines),
        },
        "overdue": {
            "line_count": len(overdue_lines),
            "remaining_qty": sum(_open_qty(row) for row in overdue_lines),
            "remaining_value": sum(_open_value(row) for row in overdue_lines),
        },
        # Legacy keys for monthly drill-down
        "on_hand": {
            "line_count": len(due_lines),
            "remaining_qty": sum(_open_qty(row) for row in due_lines),
            "remaining_value": sum(_open_value(row) for row in due_lines),
        },
        "backlog": {
            "line_count": len(overdue_lines),
            "remaining_qty": sum(_open_qty(row) for row in overdue_lines),
            "remaining_value": sum(_open_value(row) for row in overdue_lines),
        },
        "on_hand_lines": due_lines,
        "backlog_lines": overdue_lines,
    }


def _build_past_month_summary(
    shipments: list[dict[str, Any]],
    start_d: date,
    end_d: date,
) -> dict[str, Any]:
    month_shipments = [row for row in shipments if _shipment_in_month(row, start_d, end_d)]
    delivered = [
        row for row in month_shipments
        if _due_in_month(row, start_d, end_d)
    ]
    backlog_delivered = [
        row for row in month_shipments
        if _due_before_month(row, start_d)
    ]
    early_delivered = [
        row for row in month_shipments
        if _due_after_month(row, end_d)
    ]
    return {
        "mode": "past",
        "delivered": {
            "line_count": len(delivered),
            "qty_issued": _sum_field(delivered, "qty_issued"),
            "total_home_amt": _sum_field(delivered, "total_home_amt"),
        },
        "backlog_delivered": {
            "line_count": len(backlog_delivered),
            "qty_issued": _sum_field(backlog_delivered, "qty_issued"),
            "total_home_amt": _sum_field(backlog_delivered, "total_home_amt"),
        },
        "early_delivered": {
            "line_count": len(early_delivered),
            "qty_issued": _sum_field(early_delivered, "qty_issued"),
            "total_home_amt": _sum_field(early_delivered, "total_home_amt"),
        },
        "delivered_lines": delivered,
        "backlog_delivered_lines": backlog_delivered,
        "early_delivered_lines": early_delivered,
    }


def _build_booked_summary(booked: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "line_count": len(booked),
        "qty": _sum_field(booked, "qty"),
        "line_amount": _sum_field(booked, "line_amount"),
    }



def _build_ytd_grid(
    open_lines: list[dict[str, Any]],
    shipments: list[dict[str, Any]],
    year: int,
    *,
    today: date | None = None,
) -> dict[str, Any]:
    anchor = today or date.today()
    current_month = anchor.month if year == anchor.year else (12 if year < anchor.year else 1)

    months_meta: list[dict[str, Any]] = []
    for month in range(1, 13):
        start_d, end_d = _month_bounds(year, month)
        mode = _month_mode(year, month, today=anchor)
        is_current = year == anchor.year and month == anchor.month
        open_kind = None
        if mode == "open":
            open_kind = "current" if is_current else "future"
        months_meta.append(
            {
                "month": month,
                "label": date(year, month, 1).strftime("%b-%y"),
                "mode": mode,
                "open_kind": open_kind,
                "is_current": is_current,
                "from": start_d.isoformat(),
                "to": end_d.isoformat(),
            }
        )

    def _cells_for_type(pp_type: str | None) -> list[dict[str, Any]]:
        type_open = [
            row for row in open_lines
            if pp_type is None or _ps_type(row.get("process_sheet_no"), row.get("pp_type")) == pp_type
        ]
        type_shipments = [
            row for row in shipments
            if pp_type is None or _ps_type(row.get("process_sheet_no"), row.get("pp_type")) == pp_type
        ]
        cells: list[dict[str, Any]] = []
        for meta in months_meta:
            month = int(meta["month"])
            start_d, end_d = _month_bounds(year, month)
            if meta["mode"] == "past":
                past = _build_past_month_summary(type_shipments, start_d, end_d)
                cells.append(
                    {
                        "month": month,
                        "mode": "past",
                        "backlog_delivered": past["backlog_delivered"]["total_home_amt"],
                        "delivered": past["delivered"]["total_home_amt"],
                        "early_delivered": past["early_delivered"]["total_home_amt"],
                    }
                )
            else:
                open_summary = _build_open_month_summary(type_open, start_d, end_d)
                due_val = open_summary["due_this_month"]["remaining_value"]
                if meta.get("open_kind") == "current":
                    cells.append(
                        {
                            "month": month,
                            "mode": "open",
                            "open_kind": "current",
                            "overdue": open_summary["overdue"]["remaining_value"],
                            "due_this_month": due_val,
                        }
                    )
                else:
                    cells.append(
                        {
                            "month": month,
                            "mode": "open",
                            "open_kind": "future",
                            "due_this_month": due_val,
                        }
                    )
        return cells

    def _sum_cells(cell_lists: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for idx, meta in enumerate(months_meta):
            merged: dict[str, Any] = {"month": meta["month"], "mode": meta["mode"]}
            if meta["mode"] == "past":
                merged["backlog_delivered"] = sum(float(c[idx].get("backlog_delivered") or 0) for c in cell_lists)
                merged["delivered"] = sum(float(c[idx].get("delivered") or 0) for c in cell_lists)
                merged["early_delivered"] = sum(float(c[idx].get("early_delivered") or 0) for c in cell_lists)
            else:
                if meta.get("open_kind") == "current":
                    merged["overdue"] = sum(float(c[idx].get("overdue") or 0) for c in cell_lists)
                    merged["due_this_month"] = sum(float(c[idx].get("due_this_month") or 0) for c in cell_lists)
                    merged["open_kind"] = "current"
                else:
                    merged["due_this_month"] = sum(float(c[idx].get("due_this_month") or 0) for c in cell_lists)
                    merged["open_kind"] = "future"
            out.append(merged)
        return out

    row_cells: dict[str, list[dict[str, Any]]] = {}
    for pp_type in _YTD_ROW_TYPES:
        row_cells[pp_type] = _cells_for_type(pp_type)

    rows: list[dict[str, Any]] = []
    for pp_type in _YTD_ROW_TYPES:
        rows.append(
            {
                "id": pp_type,
                "label": pp_type,
                "cells": row_cells[pp_type],
            }
        )

    rows.append(
        {
            "id": "SUB_APS_NPS",
            "label": "Sub-Total (APS+NPS)",
            "cells": _sum_cells([row_cells["APS"], row_cells["NPS"]]),
            "emphasis": "subtotal",
        }
    )
    rows.append(
        {
            "id": "TOTAL",
            "label": "Total (All Segment)",
            "cells": _sum_cells([row_cells[t] for t in _YTD_ROW_TYPES]),
            "emphasis": "total",
        }
    )

    return {
        "year": year,
        "current_month": current_month,
        "today": anchor.isoformat(),
        "months": months_meta,
        "rows": rows,
    }


def _parse_month_args() -> tuple[int, int, date, date]:
    month_raw = compact_text(request.args.get("month"))
    year_raw = compact_text(request.args.get("year"))

    if month_raw and len(month_raw) == 7 and month_raw[4] == "-":
        year_raw, month_raw = month_raw.split("-", 1)

    today = date.today()
    try:
        year = int(year_raw) if year_raw else today.year
        month = int(month_raw) if month_raw else today.month
    except ValueError as exc:
        raise ValueError("year and month must be integers") from exc

    if month < 1 or month > 12:
        raise ValueError("month must be between 1 and 12")
    if year < 2000 or year > 2100:
        raise ValueError("year out of supported range")

    start_d, end_d = _month_bounds(year, month)
    return year, month, start_d, end_d


def _parse_year_arg() -> int:
    month_raw = compact_text(request.args.get("month"))
    year_raw = compact_text(request.args.get("year"))
    if month_raw and len(month_raw) == 7 and month_raw[4] == "-":
        year_raw = month_raw.split("-", 1)[0]
    today = date.today()
    try:
        year = int(year_raw) if year_raw else today.year
    except ValueError as exc:
        raise ValueError("year must be an integer") from exc
    if year < 2000 or year > 2100:
        raise ValueError("year out of supported range")
    return year


def _monthly_cache_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def _ytd_cache_key(year: int) -> str:
    return f"ytd-{year:04d}"


def _build_allocated_payload(
    so_lines: list[dict[str, Any]],
    pp_jobs: list[dict[str, Any]],
    shipments_raw: list[dict[str, Any]],
    pp_partials: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    allocated_open = build_allocated_open_lines(so_lines, pp_jobs, pp_partials)
    shipments_attributed = attribute_shipments(
        shipments_raw,
        index_pp_jobs_by_so_line(pp_jobs),
        index_so_lines(so_lines),
    )
    integrity = integrity_check(so_lines, allocated_open, shipments_raw, shipments_attributed)
    return {
        "so_lines": so_lines,
        "pp_jobs": pp_jobs,
        "allocated_open_lines": allocated_open,
        "shipments_attributed": shipments_attributed,
        "integrity": integrity,
    }


def _fetch_monthly_report(year: int, month: int, start_d: date, end_d: date, *, refresh: bool = False) -> dict[str, Any]:
    key = _monthly_cache_key(year, month)
    now = time.time()
    if not refresh:
        cached = _monthly_cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL_SEC:
            return cached[1]

    so_lines = _erp_query(_SO_LINES_SQL)
    pp_jobs = _erp_query(_PP_JOBS_SQL)
    pp_partials = _erp_query(_PP_PARTIALS_SQL)
    shipments_raw = _erp_query(
        _SHIPMENTS_SQL,
        (start_d.isoformat(), start_d.isoformat(), end_d.isoformat()),
    )
    booked = _erp_query(_BOOKED_SQL, (start_d.isoformat(), end_d.isoformat()))

    alloc = _build_allocated_payload(so_lines, pp_jobs, shipments_raw, pp_partials)
    open_lines = alloc["allocated_open_lines"]
    shipments = alloc["shipments_attributed"]

    if _is_past_month(year, month):
        period_summary = _build_past_month_summary(shipments, start_d, end_d)
        detail_backlog = period_summary["backlog_delivered_lines"]
        detail_on_hand = period_summary["delivered_lines"]
        detail_early = period_summary["early_delivered_lines"]
    else:
        period_summary = _build_open_month_summary(open_lines, start_d, end_d)
        detail_backlog = period_summary["backlog_lines"]
        detail_on_hand = period_summary["on_hand_lines"]
        detail_early = []

    payload = {
        "year": year,
        "month": month,
        "from": start_d.isoformat(),
        "to": end_d.isoformat(),
        "summary": {
            **period_summary,
            "booked": _build_booked_summary(booked),
        },
        "backlog": detail_backlog,
        "on_hand": detail_on_hand,
        "early_delivered": detail_early,
        "shipped": shipments,
        "booked": booked,
        "open_lines": open_lines,
        "so_lines": so_lines,
        "pp_jobs": pp_jobs,
        "allocated_open_lines": open_lines,
        "shipments_attributed": shipments,
        "integrity": alloc["integrity"],
    }
    _monthly_cache[key] = (now, payload)
    return payload


def _fetch_ytd_report(year: int, *, refresh: bool = False) -> dict[str, Any]:
    key = _ytd_cache_key(year)
    now = time.time()
    if not refresh:
        cached = _ytd_cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL_SEC:
            return cached[1]

    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    so_lines = _erp_query(_SO_LINES_SQL)
    pp_jobs = _erp_query(_PP_JOBS_SQL)
    pp_partials = _erp_query(_PP_PARTIALS_SQL)
    shipments_raw = _erp_query(
        _SHIPMENTS_SQL,
        (year_start.isoformat(), year_start.isoformat(), year_end.isoformat()),
    )
    alloc = _build_allocated_payload(so_lines, pp_jobs, shipments_raw, pp_partials)
    open_lines = alloc["allocated_open_lines"]
    shipments = alloc["shipments_attributed"]
    payload = {
        "year": year,
        "so_lines": so_lines,
        "pp_jobs": pp_jobs,
        "open_lines": open_lines,
        "allocated_open_lines": open_lines,
        "shipments": shipments,
        "shipments_attributed": shipments,
        "integrity": alloc["integrity"],
        "grid": _build_ytd_grid(open_lines, shipments, year),
    }
    _ytd_cache[key] = (now, payload)
    return payload


def invalidate_sales_report_cache() -> None:
    global _monthly_cache, _ytd_cache
    _monthly_cache = {}
    _ytd_cache = {}


@sales_report_bp.get("/sales-report")
def sales_report_page():
    return render_template("sales_report.html", active="sales_report")


@sales_report_bp.get("/api/sales-report/monthly")
def api_sales_report_monthly():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        year, month, start_d, end_d = _parse_month_args()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        data = _fetch_monthly_report(year, month, start_d, end_d, refresh=refresh)
    except Exception as exc:
        logger.exception("monthly sales report ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _monthly_cache.get(_monthly_cache_key(year, month))
    cached_at = cached[0] if cached else time.time()

    return jsonify(
        {
            "ok": True,
            "year": year,
            "month": month,
            "from": start_d.isoformat(),
            "to": end_d.isoformat(),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            **data,
        }
    )


@sales_report_bp.get("/api/sales-report/ytd")
def api_sales_report_ytd():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        year = _parse_year_arg()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        data = _fetch_ytd_report(year, refresh=refresh)
    except Exception as exc:
        logger.exception("YTD sales report ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _ytd_cache.get(_ytd_cache_key(year))
    cached_at = cached[0] if cached else time.time()

    return jsonify(
        {
            "ok": True,
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            **data,
        }
    )
