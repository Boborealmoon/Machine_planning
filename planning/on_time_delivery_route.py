"""On-time delivery report - process sheets vs PO due or proposed EDD."""
from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Any

from flask import Blueprint, Response, jsonify, render_template, request

from .on_time_delivery import (
    BENCHMARK_PROPOSED_EDD,
    PP_TYPES,
    aggregate_on_time_delivery,
    apply_benchmark,
    benchmark_label,
    build_overview_sections,
    classify_process_sheets,
    narrow_report_rows,
    normalize_benchmark,
    salesperson_key,
    select_year_segment,
)
from .otd_new_parts import flag_new_process_sheets, list_new_part_history, start_month_end_snapshot_loop
from .on_time_delivery_pdf import build_on_time_delivery_pdf
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
  AND (
    shipped.last_shipment_date::date BETWEEN %s AND %s
    OR COALESCE(det.required_shipment_date, pp.source_rsd)::date BETWEEN %s AND %s
  )
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
  AND (
    shipped.last_shipment_date BETWEEN %s AND %s
    OR COALESCE(det.required_shipment_date, pp.source_rsd)::date BETWEEN %s AND %s
  )
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


def _parse_optional_month() -> int | None:
    raw = compact_text(request.args.get("month"))
    if not raw:
        return None
    try:
        month = int(raw)
    except ValueError:
        return None
    if 1 <= month <= 12:
        return month
    return None


def _voucher_base(value: Any) -> str:
    return compact_text(value).split("::")[0]


def _iso_date_text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return compact_text(value.isoformat())[:10]
    return compact_text(value)[:10]


def _attach_proposed_edd(rows: list[dict[str, Any]]) -> None:
    """Fill proposed EDD from planner_process_sheet when the ERP row has none."""
    if not rows or not (os.getenv("SUPA_DB_URL") or "").strip():
        return
    vouchers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if compact_text(row.get("proposed_edd") or row.get("coway_proposed_edd")):
            continue
        base = _voucher_base(row.get("pp_voucher_no") or row.get("process_sheet_no"))
        if not base or base in seen:
            continue
        seen.add(base)
        vouchers.append(base)
    if not vouchers:
        return
    try:
        from .helpers import planner_db, rows as db_rows
        from .process_sheets import _ensure_coway_proposed_edd_column

        with planner_db() as con:
            _ensure_coway_proposed_edd_column(con)
            fetched = db_rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id, pp_partial_no, coway_proposed_edd
                    FROM planner_process_sheet
                    WHERE coway_proposed_edd IS NOT NULL
                      AND (
                        source_ps_id = ANY(%s)
                        OR planner_ps_id = ANY(%s)
                        OR split_part(planner_ps_id, '::', 1) = ANY(%s)
                      )
                    """,
                    (vouchers, vouchers, vouchers),
                )
            )
    except Exception as exc:
        logger.warning("proposed EDD overlay skipped: %s", exc)
        return

    by_base: dict[str, tuple[int, str]] = {}
    for item in fetched:
        edd = _iso_date_text(item.get("coway_proposed_edd"))
        if not edd:
            continue
        try:
            partial_no = max(1, int(item.get("pp_partial_no") or 1))
        except (TypeError, ValueError):
            partial_no = 1
        for key in (item.get("source_ps_id"), item.get("planner_ps_id")):
            base = _voucher_base(key)
            if not base:
                continue
            current = by_base.get(base)
            if current is None or partial_no < current[0]:
                by_base[base] = (partial_no, edd)
    if not by_base:
        return
    for row in rows:
        if compact_text(row.get("proposed_edd") or row.get("coway_proposed_edd")):
            continue
        base = _voucher_base(row.get("pp_voucher_no") or row.get("process_sheet_no"))
        match = by_base.get(base)
        if match:
            row["proposed_edd"] = match[1]


def _fetch_delivered_process_sheets(year: int, *, refresh: bool = False) -> list[dict[str, Any]]:
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    window = (year_start.isoformat(), year_end.isoformat())
    params = (*window, *window)

    def loader() -> list[dict[str, Any]]:
        return fetch_rows(
            _STAGED_DELIVERED_PS_SQL,
            params,
            live_sql=_LIVE_DELIVERED_PS_SQL,
        )

    return fetch_cached(
        f"on-time-delivery:v3:{year}",
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
    _attach_proposed_edd(raw_rows)
    classified = flag_new_process_sheets(classify_process_sheets(raw_rows))
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


@on_time_delivery_bp.get("/api/on-time-delivery/new-parts/history")
def api_on_time_delivery_new_part_history():
    try:
        snapshots = list_new_part_history()
    except Exception as exc:
        logger.exception("on-time delivery new-part history failed")
        return jsonify({"error": f"Could not read saved months: {exc}"}), 502
    return jsonify({"ok": True, "snapshots": snapshots})


def _pdf_view_payload(
    *,
    year: int,
    pp_types: list[str],
    sales_persons: list[str],
    refresh: bool,
) -> dict[str, Any]:
    benchmark = normalize_benchmark(request.args.get("benchmark"))
    view = compact_text(request.args.get("view")).lower()
    if view not in {"detail", "overview"}:
        view = "detail"
    report = build_report_payload(
        year=year,
        pp_types=pp_types if view == "detail" else list(PP_TYPES),
        sales_persons=sales_persons if view == "detail" else None,
        refresh=refresh,
    )
    classified = report.get("source_rows") or []
    other = "po_due" if benchmark == BENCHMARK_PROPOSED_EDD else BENCHMARK_PROPOSED_EDD
    if view == "overview":
        in_year = [
            row for row in select_year_segment(
                classified, year=year, benchmark=benchmark, segment="due",
            )
            if row.get("month")
        ]
        other_in_year = [
            row for row in select_year_segment(
                classified, year=year, benchmark=other, segment="due",
            )
            if row.get("month")
        ]
        sections = build_overview_sections(in_year, year=year)
        other_sections = build_overview_sections(other_in_year, year=year)
        return {
            "year": year,
            "benchmark": benchmark,
            "summary": {
                "classified": sum(int(item["summary"]["classified"] or 0) for item in sections),
                "early": sum(int(item["summary"]["early"] or 0) for item in sections),
                "on_time": sum(int(item["summary"]["on_time"] or 0) for item in sections),
                "late": sum(int(item["summary"]["late"] or 0) for item in sections),
                "on_time_rate": 0,
            },
            "other_summary": {
                "classified": sum(int(item["summary"]["classified"] or 0) for item in other_sections),
                "early": sum(int(item["summary"]["early"] or 0) for item in other_sections),
                "on_time": sum(int(item["summary"]["on_time"] or 0) for item in other_sections),
                "late": sum(int(item["summary"]["late"] or 0) for item in other_sections),
                "on_time_rate": 0,
            },
            "missing_edd": sum(1 for row in classified if not compact_text(row.get("proposed_edd"))),
            "sections": sections,
            "filter_note": f"Overview - due in {year} and shipped in {year} - APS, NPS, and PPS (Alice)",
        }

    month = _parse_optional_month()
    ps = compact_text(request.args.get("ps")).upper()
    status = compact_text(request.args.get("status")).lower()
    query = compact_text(request.args.get("q"))
    segment = compact_text(request.args.get("segment")) or "due"
    if segment not in {"due", "carried_in", "early_ship", "no_benchmark"}:
        segment = "due"
    selected_types = {compact_text(item) for item in pp_types if compact_text(item)}
    all_types = not selected_types or selected_types.issuperset(set(PP_TYPES))
    people = {compact_text(item).lower() for item in sales_persons if compact_text(item)}
    scoped = []
    for row in classified:
        pp_type = compact_text(row.get("pp_type"))
        if not all_types and pp_type not in selected_types:
            continue
        if people and salesperson_key(row) not in people:
            continue
        scoped.append(row)
    selected_rows = select_year_segment(
        scoped, year=year, benchmark=benchmark, segment=segment,
    )
    in_chart = [row for row in selected_rows if row.get("month")]
    outside = [row for row in selected_rows if not row.get("month")]
    chart_rows = narrow_report_rows(in_chart, month=month, pp_type=ps or None)
    active_rows = narrow_report_rows(
        chart_rows,
        status=status or None,
        query=query or None,
    )
    visible_keys = {compact_text(row.get("process_sheet_no")) for row in active_rows}
    other_rows = [
        row for row in apply_benchmark(scoped, other)
        if compact_text(row.get("process_sheet_no")) in visible_keys
    ]
    active_payload = aggregate_on_time_delivery(
        [],
        year=year,
        pp_types=pp_types,
        sales_persons=sales_persons,
        collapsed=active_rows,
        include_source_rows=False,
    )
    other_payload = aggregate_on_time_delivery(
        [],
        year=year,
        pp_types=pp_types,
        sales_persons=sales_persons,
        collapsed=other_rows,
        include_source_rows=False,
    )
    segment_note = {
        "due": f"{benchmark_label(benchmark)} in {year}, shipped in {year}",
        "carried_in": f"Shipped in {year}, {benchmark_label(benchmark)} before {year}",
        "early_ship": f"Shipped in {year}, {benchmark_label(benchmark)} after {year}",
        "no_benchmark": f"Shipped in {year} with no {benchmark_label(benchmark)}",
    }[segment]
    notes = [f"Benchmark {benchmark_label(benchmark)}", segment_note]
    if outside:
        notes.append(
            f"{len(outside)} due in {year} but shipped in another year, left out of the chart"
        )
    if month:
        notes.append(f"month {month}")
    if ps:
        notes.append(ps)
    if status == "late":
        notes.append("late only")
    elif status == "on_time":
        notes.append("on time only")
    if query:
        notes.append(f'search "{query}"')
    return {
        "year": year,
        "benchmark": benchmark,
        "summary": active_payload["summary"],
        "other_summary": other_payload["summary"],
        "by_month": active_payload["by_month"],
        "rows": active_payload["rows"],
        "missing_edd": sum(1 for row in active_rows if not compact_text(row.get("proposed_edd"))),
        "filter_note": " - ".join(notes),
    }


def _fix_rate(summary: dict[str, Any]) -> None:
    classified = int(summary.get("classified") or 0)
    on_time = int(summary.get("early") or 0) + int(summary.get("on_time") or 0)
    summary["on_time_rate"] = round(on_time / classified, 4) if classified else 0.0


@on_time_delivery_bp.get("/api/on-time-delivery/report.pdf")
def api_on_time_delivery_pdf():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    try:
        year = _parse_year_arg()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        payload = _pdf_view_payload(
            year=year,
            pp_types=_parse_pp_types_arg(),
            sales_persons=_parse_sales_persons_arg(),
            refresh=refresh,
        )
    except Exception as exc:
        logger.exception("on-time delivery pdf query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502
    _fix_rate(payload["summary"])
    _fix_rate(payload["other_summary"])
    try:
        pdf_bytes = build_on_time_delivery_pdf(payload)
    except Exception as exc:
        logger.exception("on-time delivery pdf render failed")
        return jsonify({"error": f"PDF failed: {exc}"}), 500
    benchmark = normalize_benchmark(payload.get("benchmark"))
    slug = "proposed-edd" if benchmark == BENCHMARK_PROPOSED_EDD else "po-due"
    filename = f"on-time-delivery-{year}-{slug}.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


start_month_end_snapshot_loop()
