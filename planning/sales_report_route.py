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
    index_pp_partials,
    index_so_lines,
    integrity_check,
    ps_type_from_process_sheet,
    so_line_key,
)
from .staged_erp import (
    STAGED_BOOKED_SQL,
    STAGED_PP_JOBS_SQL,
    STAGED_PP_PARTIALS_SQL,
    STAGED_SHIPMENTS_SQL,
    STAGED_SO_LINES_SQL,
    fetch_rows,
    serialize_row as _serialize_row,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

sales_report_bp = Blueprint("sales_report", __name__)

_CACHE_TTL_SEC = 300
_monthly_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_ytd_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_PP_TYPES = ("MPS", "APS", "NPS", "PPS", "CPS", "SR")
_YTD_ROW_TYPES = _PP_TYPES

DATE_BASIS_PO_DUE = "po_due"
DATE_BASIS_POSTED = "posted"

# Home-currency $ — matches ERP pre_tax_extended_home_amt and shipment total_home_amt.
_UNIT_FC_SQL = "COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price)"
_EXCH_OST_SQL = "COALESCE(ost.exch_rate, 1)"
_UNIT_HOME_SQL = f"""
CASE
    WHEN COALESCE(det.qty, 0) > 0 AND det.pre_tax_extended_home_amt IS NOT NULL
        THEN det.pre_tax_extended_home_amt / det.qty
    ELSE {_UNIT_FC_SQL} * {_EXCH_OST_SQL}
END
"""
_REMAINING_HOME_SQL = f"""
CASE
    WHEN COALESCE(det.qty, 0) > 0 AND det.pre_tax_extended_home_amt IS NOT NULL
        THEN det.pre_tax_extended_home_amt
            * GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) / det.qty
    ELSE GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0))
        * {_UNIT_FC_SQL} * {_EXCH_OST_SQL}
END
"""
_LINE_HOME_SQL = f"""
CASE
    WHEN COALESCE(det.qty, 0) > 0 AND det.pre_tax_extended_home_amt IS NOT NULL
        THEN det.pre_tax_extended_home_amt
    ELSE det.qty * {_UNIT_FC_SQL} * {_EXCH_OST_SQL}
END
"""

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
# Prefer part master description over SO line_item_description (often BATCH#/SERIAL#).
_SO_LINES_SQL = f"""
SELECT
    det.sales_order_no,
    regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    det.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), '')
    ) AS description,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped,
    GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) AS remaining_qty,
    {_UNIT_HOME_SQL.strip()} AS unit_selling_price,
    ({_REMAINING_HOME_SQL.strip()}) AS remaining_value,
    ({_REMAINING_HOME_SQL.strip()}) AS outstanding_balance_home,
    ({_LINE_HOME_SQL.strip()}) AS line_value_home,
    {_UNIT_FC_SQL} AS unit_selling_price_fc,
    {_EXCH_OST_SQL} AS exch_rate,
    ost.order_currency_code,
    det.required_shipment_date::date AS due_date,
    hdr.customer_code,
    hdr.customer_name,
    hdr.sales_person_name,
    hdr.sbu_desc,
    COALESCE(rev.first_posted_datetime, ost.posted_datetime) AS first_posted_datetime
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr ost ON ost.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view hdr ON hdr.sales_order_no = det.sales_order_no
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = det.inventory_code
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
    d.unit_selling_price AS unit_selling_price_fc,
    (d.unit_selling_price * d.qty_issued) AS line_fc_amt,
    COALESCE(h.exch_rate, 1) AS exch_rate,
    (d.unit_selling_price * d.qty_issued * COALESCE(h.exch_rate, 1)) AS total_home_amt,
    hdr.order_currency_code,
    d.shipment_voucher_no,
    d.invoice_no,
    d.invoice_line_item_no,
    COALESCE(h.arrival_date, h.do_generation_datetime) AS shipment_datetime,
    COALESCE(h.arrival_date, h.do_generation_datetime)::date AS shipment_date,
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
  AND COALESCE(h.arrival_date, h.do_generation_datetime)::date BETWEEN %s AND %s
ORDER BY shipment_datetime DESC, d.source_voucher_no, line_item_no
"""

_BOOKED_SQL = f"""
SELECT
    det.sales_order_no,
    regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    det.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), '')
    ) AS description,
    det.qty,
    {_UNIT_FC_SQL} AS unit_selling_price_fc,
    {_EXCH_OST_SQL} AS exch_rate,
    ost.order_currency_code,
    {_UNIT_HOME_SQL.strip()} AS unit_selling_price,
    ({_LINE_HOME_SQL.strip()}) AS line_amount,
    det.required_shipment_date::date AS due_date,
    COALESCE(rev.first_posted_datetime, ost.posted_datetime) AS first_posted_datetime,
    v.customer_code,
    v.customer_name,
    v.sales_person_name,
    v.sbu_desc
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr ost ON ost.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view v ON v.sales_order_no = det.sales_order_no
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = det.inventory_code
LEFT JOIN ({_FIRST_POSTED_SQL.strip()}) rev
       ON rev.sales_order_no = det.sales_order_no
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(ost.status, '') <> 'V'
  AND COALESCE(rev.first_posted_datetime, ost.posted_datetime)::date BETWEEN %s AND %s
ORDER BY first_posted_datetime DESC, det.sales_order_no, line_item_no
"""


def _erp_query(sql: str, params: tuple = (), *, live_sql: str | None = None) -> list[dict[str, Any]]:
    return fetch_rows(sql, params, live_sql=live_sql or sql)


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


def _so_line_identity(row: dict[str, Any]) -> tuple[str, str]:
    return so_line_key(
        row.get("sales_order_no"),
        row.get("line_item_no") or row.get("source_line_item_no"),
    )


def _named_money(row: dict[str, Any], field: str) -> float | None:
    if row.get(field) is None or row.get(field) == "":
        return None
    try:
        return float(row[field])
    except (TypeError, ValueError):
        return None


def _line_value_home(row: dict[str, Any]) -> float:
    named = _named_money(row, "line_value_home")
    if named is not None:
        return named
    try:
        qty = float(row.get("so_det_qty") or 0)
        unit = float(row.get("unit_selling_price") or 0)
        return qty * unit
    except (TypeError, ValueError):
        return 0.0


def _outstanding_balance_home(row: dict[str, Any]) -> float:
    """Achievable remaining $ = remaining SO qty × home unit (cost)."""
    named = _named_money(row, "outstanding_balance_home")
    if named is not None:
        return named
    rem_qty = _named_money(row, "remaining_qty")
    unit = _named_money(row, "unit_selling_price")
    if rem_qty is not None and unit is not None:
        return rem_qty * unit
    named_remaining = _named_money(row, "remaining_value")
    return named_remaining if named_remaining is not None else 0.0


def summarize_open_so_value(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Unique-per-SO-line original value vs remaining SO qty × home unit."""
    seen: set[tuple[str, str]] = set()
    line_value = 0.0
    outstanding = 0.0
    for row in rows:
        key = _so_line_identity(row)
        if not key[0] or key in seen:
            continue
        seen.add(key)
        line_value += _line_value_home(row)
        outstanding += _outstanding_balance_home(row)
    line_value = round(line_value, 2)
    outstanding = round(outstanding, 2)
    pct_left = round(100.0 * outstanding / line_value, 1) if line_value else 0.0
    return {
        "line_value_home": line_value,
        "outstanding_balance_home": outstanding,
        "pct_left": pct_left,
        "so_line_count": len(seen),
    }


def _open_remaining_total(rows: list[dict[str, Any]]) -> float:
    return round(sum(_open_value(row) for row in rows), 2)


def _past_month_sales(cell: dict[str, Any]) -> float:
    named = cell.get("sales")
    if named is not None:
        try:
            return float(named)
        except (TypeError, ValueError):
            pass
    return (
        float(cell.get("backlog_delivered") or 0)
        + float(cell.get("delivered") or 0)
        + float(cell.get("early_delivered") or 0)
    )


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


def _parse_date_basis(raw: Any = None) -> str:
    text = compact_text(raw).lower().replace("-", "_")
    if text in {"posted", "so_posted", "first_posted", "so"}:
        return DATE_BASIS_POSTED
    return DATE_BASIS_PO_DUE


def _row_anchor_date(
    row: dict[str, Any],
    *,
    basis: str = DATE_BASIS_PO_DUE,
    for_shipment: bool = False,
) -> date | None:
    """Date that owns the month bucket — PO due (default) or SO first-posted."""
    if basis == DATE_BASIS_POSTED:
        return (
            _parse_date_value(row.get("first_posted_datetime"))
            or _parse_date_value(row.get("so_posted_date"))
        )
    if for_shipment:
        due = _parse_date_value(row.get("so_due_date"))
        if due is not None:
            return due
    return _parse_date_value(row.get("due_date"))


def _due_in_month(
    row: dict[str, Any],
    start_d: date,
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    due = _row_anchor_date(row, basis=basis)
    return due is not None and start_d <= due <= end_d


def _due_before_month(
    row: dict[str, Any],
    start_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    due = _row_anchor_date(row, basis=basis)
    return due is not None and due < start_d


def _due_after_month(
    row: dict[str, Any],
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    due = _row_anchor_date(row, basis=basis)
    return due is not None and due > end_d


def _shipment_bucket_due(
    row: dict[str, Any],
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> date | None:
    """Month-class date for backlog/on-time/early — PO due, or SO posted when flipped."""
    return _row_anchor_date(row, basis=basis, for_shipment=True)


def _shipment_due_in_month(
    row: dict[str, Any],
    start_d: date,
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    due = _shipment_bucket_due(row, basis=basis)
    return due is not None and start_d <= due <= end_d


def _shipment_due_before_month(
    row: dict[str, Any],
    start_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    due = _shipment_bucket_due(row, basis=basis)
    return due is not None and due < start_d


def _shipment_due_after_month(
    row: dict[str, Any],
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    due = _shipment_bucket_due(row, basis=basis)
    return due is not None and due > end_d


def _outstanding_rest(
    row: dict[str, Any],
    start_d: date,
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> bool:
    """Open lines not in backlog and not in this month (future anchor or unscheduled)."""
    due = _row_anchor_date(row, basis=basis)
    if due is None:
        return True
    return due > end_d


def _shipment_in_month(row: dict[str, Any], start_d: date, end_d: date) -> bool:
    ship = _parse_date_value(row.get("shipment_date") or row.get("shipment_datetime"))
    return ship is not None and start_d <= ship <= end_d


def _build_open_month_summary(
    open_lines: list[dict[str, Any]],
    start_d: date,
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> dict[str, Any]:
    due_lines = [row for row in open_lines if _due_in_month(row, start_d, end_d, basis=basis)]
    overdue_lines = [row for row in open_lines if _due_before_month(row, start_d, basis=basis)]
    rest_lines = [row for row in open_lines if _outstanding_rest(row, start_d, end_d, basis=basis)]
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
        "outstanding_rest": {
            "line_count": len(rest_lines),
            "remaining_qty": sum(_open_qty(row) for row in rest_lines),
            "remaining_value": sum(_open_value(row) for row in rest_lines),
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
        "outstanding_rest_lines": rest_lines,
    }


def _build_past_month_summary(
    shipments: list[dict[str, Any]],
    start_d: date,
    end_d: date,
    *,
    basis: str = DATE_BASIS_PO_DUE,
) -> dict[str, Any]:
    month_shipments = [row for row in shipments if _shipment_in_month(row, start_d, end_d)]
    delivered = [
        row for row in month_shipments
        if _shipment_due_in_month(row, start_d, end_d, basis=basis)
    ]
    backlog_delivered = [
        row for row in month_shipments
        if _shipment_due_before_month(row, start_d, basis=basis)
    ]
    early_delivered = [
        row for row in month_shipments
        if _shipment_due_after_month(row, end_d, basis=basis)
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
    basis: str = DATE_BASIS_PO_DUE,
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
                past = _build_past_month_summary(type_shipments, start_d, end_d, basis=basis)
                sales = (
                    past["backlog_delivered"]["total_home_amt"]
                    + past["delivered"]["total_home_amt"]
                    + past["early_delivered"]["total_home_amt"]
                )
                cells.append(
                    {
                        "month": month,
                        "mode": "past",
                        "sales": sales,
                        "backlog_delivered": past["backlog_delivered"]["total_home_amt"],
                        "delivered": past["delivered"]["total_home_amt"],
                        "early_delivered": past["early_delivered"]["total_home_amt"],
                    }
                )
            else:
                open_summary = _build_open_month_summary(type_open, start_d, end_d, basis=basis)
                due_val = open_summary["due_this_month"]["remaining_value"]
                if meta.get("open_kind") == "current":
                    cells.append(
                        {
                            "month": month,
                            "mode": "open",
                            "open_kind": "current",
                            "backlog": open_summary["backlog"]["remaining_value"],
                            "on_hand": due_val,
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
                merged["sales"] = sum(_past_month_sales(c[idx]) for c in cell_lists)
            else:
                if meta.get("open_kind") == "current":
                    merged["backlog"] = sum(float(c[idx].get("backlog") or 0) for c in cell_lists)
                    merged["on_hand"] = sum(float(c[idx].get("on_hand") or 0) for c in cell_lists)
                    merged["open_kind"] = "current"
                else:
                    merged["due_this_month"] = sum(float(c[idx].get("due_this_month") or 0) for c in cell_lists)
                    merged["open_kind"] = "future"
            out.append(merged)
        return out

    row_cells: dict[str, list[dict[str, Any]]] = {}
    remaining_by_type: dict[str, float] = {}
    for pp_type in _YTD_ROW_TYPES:
        row_cells[pp_type] = _cells_for_type(pp_type)
        remaining_by_type[pp_type] = _open_remaining_total(
            [
                row
                for row in open_lines
                if _ps_type(row.get("process_sheet_no"), row.get("pp_type")) == pp_type
            ]
        )

    rows: list[dict[str, Any]] = []
    for pp_type in _YTD_ROW_TYPES:
        rows.append(
            {
                "id": pp_type,
                "label": pp_type,
                "cells": row_cells[pp_type],
                "open_remaining": remaining_by_type[pp_type],
            }
        )

    rows.append(
        {
            "id": "TOTAL",
            "label": "Total (All Segment)",
            "cells": _sum_cells([row_cells[t] for t in _YTD_ROW_TYPES]),
            "emphasis": "total",
            "open_remaining": round(sum(remaining_by_type.values()), 2),
        }
    )

    return {
        "year": year,
        "current_month": current_month,
        "today": anchor.isoformat(),
        "date_basis": basis,
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
    partials_by_voucher = index_pp_partials(pp_partials or [])
    shipments_attributed = attribute_shipments(
        shipments_raw,
        index_pp_jobs_by_so_line(pp_jobs),
        index_so_lines(so_lines),
        partials_by_voucher=partials_by_voucher,
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

    so_lines = _erp_query(STAGED_SO_LINES_SQL, live_sql=_SO_LINES_SQL)
    pp_jobs = _erp_query(STAGED_PP_JOBS_SQL, live_sql=_PP_JOBS_SQL)
    pp_partials = _erp_query(STAGED_PP_PARTIALS_SQL, live_sql=_PP_PARTIALS_SQL)
    shipments_raw = _erp_query(
        STAGED_SHIPMENTS_SQL,
        (start_d.isoformat(), start_d.isoformat(), end_d.isoformat()),
        live_sql=_SHIPMENTS_SQL,
    )
    booked = _erp_query(
        STAGED_BOOKED_SQL,
        (start_d.isoformat(), end_d.isoformat()),
        live_sql=_BOOKED_SQL,
    )

    alloc = _build_allocated_payload(so_lines, pp_jobs, shipments_raw, pp_partials)
    open_lines = alloc["allocated_open_lines"]
    shipments = alloc["shipments_attributed"]

    if _is_past_month(year, month):
        period_summary = _build_past_month_summary(shipments, start_d, end_d)
        detail_backlog = period_summary["backlog_delivered_lines"]
        detail_on_hand = period_summary["delivered_lines"]
        detail_early = period_summary["early_delivered_lines"]
        detail_outstanding_rest = []
    else:
        period_summary = _build_open_month_summary(open_lines, start_d, end_d)
        detail_backlog = period_summary["backlog_lines"]
        detail_on_hand = period_summary["on_hand_lines"]
        detail_early = []
        detail_outstanding_rest = period_summary.get("outstanding_rest_lines") or []

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
        "outstanding_rest": detail_outstanding_rest,
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
    so_lines = _erp_query(STAGED_SO_LINES_SQL, live_sql=_SO_LINES_SQL)
    pp_jobs = _erp_query(STAGED_PP_JOBS_SQL, live_sql=_PP_JOBS_SQL)
    pp_partials = _erp_query(STAGED_PP_PARTIALS_SQL, live_sql=_PP_PARTIALS_SQL)
    shipments_raw = _erp_query(
        STAGED_SHIPMENTS_SQL,
        (year_start.isoformat(), year_start.isoformat(), year_end.isoformat()),
        live_sql=_SHIPMENTS_SQL,
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


def _apply_month_basis(
    data: dict[str, Any],
    year: int,
    month: int,
    start_d: date,
    end_d: date,
    basis: str,
) -> dict[str, Any]:
    """Rebuild month buckets from cached lines without mutating the ERP cache."""
    open_lines = data.get("allocated_open_lines") or data.get("open_lines") or []
    shipments = data.get("shipments_attributed") or data.get("shipped") or []
    booked = data.get("booked") or []
    if _is_past_month(year, month):
        period_summary = _build_past_month_summary(shipments, start_d, end_d, basis=basis)
        detail_backlog = period_summary["backlog_delivered_lines"]
        detail_on_hand = period_summary["delivered_lines"]
        detail_early = period_summary["early_delivered_lines"]
        detail_outstanding_rest: list[dict[str, Any]] = []
    else:
        period_summary = _build_open_month_summary(open_lines, start_d, end_d, basis=basis)
        detail_backlog = period_summary["backlog_lines"]
        detail_on_hand = period_summary["on_hand_lines"]
        detail_early = []
        detail_outstanding_rest = period_summary.get("outstanding_rest_lines") or []
    view = dict(data)
    view["date_basis"] = basis
    view["summary"] = {
        **period_summary,
        "booked": _build_booked_summary(booked),
    }
    view["backlog"] = detail_backlog
    view["on_hand"] = detail_on_hand
    view["early_delivered"] = detail_early
    view["outstanding_rest"] = detail_outstanding_rest
    return view


def _apply_ytd_basis(data: dict[str, Any], year: int, basis: str) -> dict[str, Any]:
    open_lines = data.get("allocated_open_lines") or data.get("open_lines") or []
    shipments = data.get("shipments_attributed") or data.get("shipments") or []
    view = dict(data)
    view["date_basis"] = basis
    view["grid"] = _build_ytd_grid(open_lines, shipments, year, basis=basis)
    return view


def invalidate_sales_report_cache() -> None:
    global _monthly_cache, _ytd_cache
    _monthly_cache = {}
    _ytd_cache = {}
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("sales_report:")


@sales_report_bp.get("/sales-report")
def sales_report_page():
    return render_template("sales_report.html", active="sales_report")


@sales_report_bp.get("/api/sales-report/monthly")
def api_sales_report_monthly():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    basis = _parse_date_basis(request.args.get("basis") or request.args.get("date_basis"))

    try:
        year, month, start_d, end_d = _parse_month_args()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        data = _fetch_monthly_report(year, month, start_d, end_d, refresh=refresh)
        data = _apply_month_basis(data, year, month, start_d, end_d, basis)
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
            "date_basis": basis,
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            **data,
        }
    )


@sales_report_bp.get("/api/sales-report/ytd")
def api_sales_report_ytd():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    basis = _parse_date_basis(request.args.get("basis") or request.args.get("date_basis"))

    try:
        year = _parse_year_arg()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        data = _fetch_ytd_report(year, refresh=refresh)
        data = _apply_ytd_basis(data, year, basis)
    except Exception as exc:
        logger.exception("YTD sales report ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _ytd_cache.get(_ytd_cache_key(year))
    cached_at = cached[0] if cached else time.time()

    return jsonify(
        {
            "ok": True,
            "date_basis": basis,
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            **data,
        }
    )
