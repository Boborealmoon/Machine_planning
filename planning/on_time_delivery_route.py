"""On-time delivery report - process sheets vs PO due date."""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .on_time_delivery import (
    PP_TYPES,
    aggregate_on_time_delivery,
    build_overview_sections,
    classify_process_sheets,
)
from .staged_erp import fetch_cached, fetch_rows
from .utils import compact_text

logger = logging.getLogger(__name__)

on_time_delivery_bp = Blueprint("on_time_delivery", __name__)

# Same grain as Sales Orders: one PP voucher, PO due vs last delivery on the SO line.
_STAGED_DELIVERED_PS_SQL = """
SELECT
    pp.pp_voucher_no,
    pp.pp_voucher_no AS process_sheet_no,
    pp.source_voucher_no AS sales_order_no,
    pp.source_line_item_no AS line_item_no,
    pp.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), ''),
        NULLIF(TRIM(pp.bom_desc), '')
    ) AS description,
    COALESCE(hdr.customer_code, pp.customer_code) AS customer_code,
    hdr.customer_name,
    hdr.sales_person_code,
    hdr.sales_person_name,
    COALESCE(det.required_shipment_date, pp.source_rsd)::date AS po_due_date,
    shipped.last_shipment_date AS delivery_date,
    pp.pp_qty,
    (COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) * pp.pp_qty) AS amount,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped
FROM public.pp_voucher_hdr pp
LEFT JOIN public.part_desc pd
       ON pd.inventory_code = pp.inventory_code
LEFT JOIN public.so_order_header hdr
       ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.so_order_line det
       ON det.sales_order_no = pp.source_voucher_no
      AND det.line_item_no = pp.source_line_item_no
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND sq.line_item_no = pp.source_line_item_no
LEFT JOIN (
    SELECT
        sales_order_no,
        line_item_no,
        MAX(shipment_date) AS last_shipment_date
    FROM public.lg_out_shipment_line
    WHERE COALESCE(qty_issued, 0) > 0
    GROUP BY sales_order_no, line_item_no
) shipped
       ON shipped.sales_order_no = pp.source_voucher_no
      AND shipped.line_item_no = pp.source_line_item_no
WHERE pp.source_voucher_no IS NOT NULL
  AND shipped.last_shipment_date IS NOT NULL
  AND shipped.last_shipment_date::date BETWEEN %s AND %s
  AND det.qty IS NOT NULL
  AND COALESCE(sq.qty_shipped, 0) >= det.qty - 0.0001
ORDER BY shipped.last_shipment_date, pp.pp_voucher_no
"""

_LIVE_DELIVERED_PS_SQL = """
SELECT
    pp.pp_voucher_no,
    pp.pp_voucher_no AS process_sheet_no,
    pp.source_voucher_no AS sales_order_no,
    regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    pp.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), ''),
        NULLIF(TRIM(pp.bom_desc), '')
    ) AS description,
    COALESCE(hdr.customer_code, pp.customer_code) AS customer_code,
    hdr.customer_name,
    hdr.sales_person_code,
    hdr.sales_person_name,
    COALESCE(det.required_shipment_date, pp.source_rsd)::date AS po_due_date,
    shipped.last_shipment_date AS delivery_date,
    pp.pp_qty,
    (COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) * pp.pp_qty) AS amount,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped
FROM public.mfg_pp_vch pp
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = pp.inventory_code
LEFT JOIN public.so_order_view hdr
       ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.so_order_ost_det det
       ON det.sales_order_no = pp.source_voucher_no
      AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT
        d.source_voucher_no AS sales_order_no,
        regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        MAX(COALESCE(h.arrival_date, h.do_generation_datetime)::date) AS last_shipment_date
    FROM public.lg_out_shm_detail d
    LEFT JOIN public.lg_out_shm_hst_hdr h
           ON d.shipment_voucher_no = h.shipment_voucher_no
    WHERE NOT (d.status = 'History' AND COALESCE(d.qty_issued, 0) = 0)
      AND COALESCE(d.qty_issued, 0) > 0
    GROUP BY d.source_voucher_no,
             regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '')
) shipped
       ON shipped.sales_order_no = pp.source_voucher_no
      AND shipped.line_item_no = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
WHERE pp.source_voucher_no IS NOT NULL
  AND shipped.last_shipment_date IS NOT NULL
  AND shipped.last_shipment_date BETWEEN %s AND %s
  AND det.qty IS NOT NULL
  AND COALESCE(sq.qty_shipped, 0) >= det.qty - 0.0001
ORDER BY shipped.last_shipment_date, pp.pp_voucher_no
"""


def _parse_year_arg() -> int:
    year_raw = compact_text(request.args.get("year"))
    today = datetime.now().date()
    try:
        year = int(year_raw) if year_raw else today.year
    except ValueError as exc:
        raise ValueError("year must be an integer") from exc
    if year < 2000 or year > 2100:
        raise ValueError("year out of supported range")
    return year


def _parse_pp_types_arg() -> list[str]:
    raw = compact_text(request.args.get("pp_types"))
    if not raw:
        return ["APS", "NPS"]
    if raw.upper() == "ALL":
        return list(PP_TYPES)
    parts = [item.strip().upper() for item in raw.split(",") if item.strip()]
    allowed = set(PP_TYPES)
    selected = [item for item in parts if item in allowed]
    return selected or ["APS", "NPS"]


def _parse_sales_persons_arg() -> list[str]:
    raw = compact_text(
        request.args.get("sales_persons") or request.args.get("sales_person")
    )
    if not raw or raw.upper() == "ALL":
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _fetch_delivered_process_sheets(year: int, *, refresh: bool = False) -> list[dict[str, Any]]:
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    params = (year_start.isoformat(), year_end.isoformat())

    def loader() -> list[dict[str, Any]]:
        return fetch_rows(
            _STAGED_DELIVERED_PS_SQL,
            params,
            live_sql=_LIVE_DELIVERED_PS_SQL,
        )

    return fetch_cached(
        f"on-time-delivery:v2:{year}",
        loader,
        refresh=refresh,
    )


def build_report_payload(
    *,
    year: int,
    pp_types: list[str],
    sales_persons: list[str] | None = None,
    refresh: bool = False,
) -> dict[str, Any]:
    raw_rows = _fetch_delivered_process_sheets(year, refresh=refresh)
    classified = classify_process_sheets(raw_rows)
    payload = aggregate_on_time_delivery(
        raw_rows,
        year=year,
        pp_types=pp_types,
        sales_persons=sales_persons,
        collapsed=classified,
    )
    payload["overview"] = build_overview_sections(classified, year=year)
    return payload


@on_time_delivery_bp.get("/on-time-delivery")
def on_time_delivery_page():
    return render_template("on_time_delivery.html", active="on_time_delivery")


@on_time_delivery_bp.get("/api/on-time-delivery/report")
def api_on_time_delivery_report():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    try:
        year = _parse_year_arg()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    pp_types = _parse_pp_types_arg()
    sales_persons = _parse_sales_persons_arg()
    try:
        data = build_report_payload(
            year=year,
            pp_types=pp_types,
            sales_persons=sales_persons,
            refresh=refresh,
        )
    except Exception as exc:
        logger.exception("on-time delivery report query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502
    return jsonify(
        {
            "ok": True,
            "cached_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
            **data,
        }
    )
