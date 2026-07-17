"""Job ratio report — booked SO line volume mix."""

from __future__ import annotations



import logging

import time

from datetime import date, datetime

from typing import Any



from flask import Blueprint, jsonify, render_template, request



from .job_ratio import (

    BUCKET_LABELS,

    BUCKET_TARGETS,

    MONTH_LENS_PO_DUE,

    aggregate_customer_rows,

    aggregate_month_bucket,

    aggregate_ranked_parts,

    bucket_label,

    build_job_rows_from_pp_vouchers,

    build_portion_summary,

    dedupe_pp_vouchers_by_ps,

    enrich_booked_row,

    filter_detail_rows,

    filter_rows_by_pp_types,

    sort_detail_rows,

    volume_bucket_rules,

)

from .sales_report_alloc import so_line_key

from .sales_report_route import (
    _FIRST_POSTED_SQL,
    _LINE_HOME_SQL,
    _UNIT_HOME_SQL,
    _erp_query,
)
from .staged_erp import STAGED_SO_LINE_PRICING_SQL, serialize_row as _serialize_row

from .utils import compact_text



logger = logging.getLogger(__name__)



job_ratio_bp = Blueprint("job_ratio", __name__)



_CACHE_TTL_SEC = 300

_report_cache: dict[str, tuple[float, dict[str, Any]]] = {}



_PP_TYPES = ("MPS", "APS", "NPS", "PPS", "CPS", "SR")

# Home-currency SO line pricing for PP voucher value allocation.
_SO_LINE_PRICING_SQL = f"""
SELECT
    det.sales_order_no,
    regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    det.inventory_code,
    NULLIF(TRIM(det.line_item_description), '') AS description,
    det.qty,
    {_UNIT_HOME_SQL.strip()} AS unit_selling_price,
    ({_LINE_HOME_SQL.strip()}) AS line_amount,
    det.required_shipment_date::date AS due_date,
    COALESCE(rev.first_posted_datetime, ost.posted_datetime) AS first_posted_datetime,
    COALESCE(rev.first_posted_datetime, ost.posted_datetime)::date AS so_posted_date,
    COALESCE(v.order_date, ost.posted_datetime::date) AS so_header_order_date,
    v.customer_code,
    v.customer_name,
    v.sales_person_name,
    v.sbu_desc
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr ost ON ost.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view v ON v.sales_order_no = det.sales_order_no
LEFT JOIN ({_FIRST_POSTED_SQL.strip()}) rev
       ON rev.sales_order_no = det.sales_order_no
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(ost.status, '') <> 'V'
ORDER BY det.sales_order_no, line_item_no
"""

_PP_VOUCHERS_YEAR_SQL = """
SELECT
    v.ps_id,
    v.pp_partial_no,
    v.stage_no,
    v.source_voucher_no,
    v.source_line_item_no,
    v.due_date,
    v.order_date,
    pv.pp_qty,
    v.partial_qty,
    v.so_det_qty,
    v.part_no,
    v.description
FROM {source} v
LEFT JOIN public.mfg_process_sheet_info psi
       ON psi.process_sheet_no = v.ps_id
LEFT JOIN LATERAL (
    SELECT MAX(p.pp_qty) AS pp_qty
    FROM public.pp_voucher p
    WHERE p.pp_voucher_no = COALESCE(psi.pp_voucher_no, v.ps_id)
      AND p.source_voucher_no = v.source_voucher_no
      AND regexp_replace(p.source_line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(v.source_line_item_no::TEXT, '\\.0+$', '')
) pv ON true
WHERE v.due_date BETWEEN %s AND %s
   OR v.order_date BETWEEN %s AND %s
ORDER BY v.ps_id, v.pp_partial_no NULLS LAST, v.stage_no NULLS LAST
"""


def _parse_year_arg() -> int:

    year_raw = compact_text(request.args.get("year"))

    today = date.today()

    try:

        year = int(year_raw) if year_raw else today.year

    except ValueError as exc:

        raise ValueError("year must be an integer") from exc

    if year < 2000 or year > 2100:

        raise ValueError("year out of supported range")

    return year





def _parse_pp_types_arg() -> tuple[set[str], bool]:

    raw = compact_text(request.args.get("pp_types"))

    if not raw:

        return {"NPS"}, False

    parts = [p.strip().upper() for p in raw.split(",") if p.strip()]

    if not parts or parts == ["ALL"]:

        return set(_PP_TYPES), True

    return set(parts), False





def _cache_key(year: int, pp_types: set[str], all_selected: bool) -> str:

    types_key = "ALL" if all_selected else ",".join(sorted(pp_types))

    return f"{year}:{types_key}"





def _load_pp_vouchers_for_year(year_start: date, year_end: date) -> list[dict[str, Any]]:
    from planning.helpers import planner_db, rows as db_rows

    params = (
        year_start.isoformat(),
        year_end.isoformat(),
        year_start.isoformat(),
        year_end.isoformat(),
    )
    last_exc: Exception | None = None
    merged: dict[str, dict[str, Any]] = {}

    def _merge(rows: list[dict[str, Any]]) -> None:
        for row in dedupe_pp_vouchers_by_ps(rows):
            ps_id = compact_text(row.get("ps_id"))
            if ps_id:
                merged[ps_id] = row

    for source in ("public.vw_pp_vouchers", "public.pp_vouchers_cache"):
        try:
            with planner_db() as con:
                raw = db_rows(con.execute(_PP_VOUCHERS_YEAR_SQL.format(source=source), params))
                _merge([_serialize_row(dict(row)) for row in raw])
                if merged:
                    return list(merged.values())
        except Exception as exc:
            last_exc = exc
            logger.warning("job ratio PP voucher query via %s failed: %s", source, exc)
    raise RuntimeError(
        "Could not load PP vouchers from vw_pp_vouchers or pp_vouchers_cache"
    ) from last_exc


def _fetch_report(year: int, pp_types: set[str], *, all_selected: bool, refresh: bool = False) -> dict[str, Any]:

    key = _cache_key(year, pp_types, all_selected)

    now = time.time()

    if not refresh:

        cached = _report_cache.get(key)

        if cached and now - cached[0] < _CACHE_TTL_SEC:

            return cached[1]



    year_start = date(year, 1, 1)

    year_end = date(year, 12, 31)

    pp_vouchers = _load_pp_vouchers_for_year(year_start, year_end)

    voucher_keys = {
        so_line_key(v.get("source_voucher_no"), v.get("source_line_item_no"))
        for v in pp_vouchers
    }

    so_lines = _erp_query(STAGED_SO_LINE_PRICING_SQL, live_sql=_SO_LINE_PRICING_SQL)

    so_by_key = {
        so_line_key(row.get("sales_order_no"), row.get("line_item_no")): row
        for row in so_lines
        if so_line_key(row.get("sales_order_no"), row.get("line_item_no")) in voucher_keys
    }

    booked_raw = build_job_rows_from_pp_vouchers(pp_vouchers, so_by_key)

    portion = build_portion_summary(
        booked_raw, year, pp_types, lens=MONTH_LENS_PO_DUE, all_selected=all_selected
    )

    rules = volume_bucket_rules(year)

    bucket_meta = {

        bid: {

            "id": bid,

            "label": bucket_label(bid, year),

            "target_pct": BUCKET_TARGETS[bid],

            "short_label": BUCKET_LABELS.get(bid, bid),

        }

        for bid, _, _ in rules

    }



    payload = {

        "year": year,

        "grain": "pp_voucher",

        "value_basis": "home_currency_so_pp_qty_share",

        "pp_types": sorted(pp_types) if not all_selected else list(_PP_TYPES),

        "pp_types_all": all_selected,

        "bucket_rules": {

            bid: {"min": lo, "max": hi}

            for bid, lo, hi in rules

        },

        "bucket_meta": bucket_meta,

        "targets": dict(BUCKET_TARGETS),

        "month_basis": portion["month_basis"],

        "matrix": portion["matrix"],

        "customers": portion["customers"],

        "line_count": portion["line_count"],

        "classified_line_count": portion["classified_line_count"],

        "unclassified_count": portion["unclassified_count"],

        "pp_excluded_count": portion["pp_excluded_count"],

        "booked_lines": portion["booked_lines"],

    }

    _report_cache[key] = (now, payload)

    return payload





def invalidate_job_ratio_cache() -> None:

    global _report_cache

    _report_cache = {}
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("job_ratio:")





@job_ratio_bp.get("/job-ratio")

def job_ratio_page():

    return render_template("job_ratio.html", active="job_ratio")





@job_ratio_bp.get("/api/job-ratio/report")

def api_job_ratio_report():

    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:

        year = _parse_year_arg()

        pp_types, all_selected = _parse_pp_types_arg()

    except ValueError as exc:

        return jsonify({"error": str(exc)}), 400



    try:

        data = _fetch_report(year, pp_types, all_selected=all_selected, refresh=refresh)

    except Exception as exc:

        logger.exception("job ratio query failed")

        return jsonify({"error": f"Job ratio query failed: {exc}"}), 502



    cached = _report_cache.get(_cache_key(year, pp_types, all_selected))

    cached_at = cached[0] if cached else time.time()



    response = {k: v for k, v in data.items() if k != "booked_lines"}

    return jsonify(

        {

            "ok": True,

            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),

            "cache_ttl_sec": _CACHE_TTL_SEC,

            **response,

        }

    )





@job_ratio_bp.get("/api/job-ratio/detail")

def api_job_ratio_detail():

    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    month_raw = compact_text(request.args.get("month"))

    bucket = compact_text(request.args.get("bucket")).lower() or None

    customer_code = compact_text(request.args.get("customer_code")) or None

    sort = compact_text(request.args.get("sort")).lower() or "volume"

    if sort not in {"volume", "value", "date"}:

        return jsonify({"error": "sort must be volume, value, or date"}), 400

    if bucket and bucket not in BUCKET_TARGETS:

        return jsonify({"error": f"unknown bucket: {bucket}"}), 400



    month: int | None = None

    if month_raw:

        try:

            month = int(month_raw)

        except ValueError:

            return jsonify({"error": "month must be an integer"}), 400

        if month < 1 or month > 12:

            return jsonify({"error": "month must be between 1 and 12"}), 400



    try:

        year = _parse_year_arg()

        pp_types, all_selected = _parse_pp_types_arg()

    except ValueError as exc:

        return jsonify({"error": str(exc)}), 400



    try:

        data = _fetch_report(year, pp_types, all_selected=all_selected, refresh=refresh)

    except Exception as exc:

        logger.exception("job ratio detail query failed")

        return jsonify({"error": f"Job ratio query failed: {exc}"}), 502



    rows = filter_detail_rows(

        data.get("booked_lines") or [],

        year=year,

        month=month,

        bucket=bucket,

        customer_code=customer_code,

        sort=sort,

    )

    total_value = sum(float(row.get("line_amount") or 0) for row in rows)

    return jsonify(

        {

            "ok": True,

            "year": year,

            "month": month,

            "bucket": bucket,

            "customer_code": customer_code,

            "sort": sort,

            "count": len(rows),

            "total_value": round(total_value, 2),

            "rows": rows,

        }

    )


@job_ratio_bp.get("/api/job-ratio/parts")
def api_job_ratio_parts():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    month_raw = compact_text(request.args.get("month"))
    customer_code = compact_text(request.args.get("customer_code")) or None
    sort = compact_text(request.args.get("sort")).lower() or "score"
    score_mode = compact_text(request.args.get("score_mode")).lower() or "volume_value"
    if sort not in {"score", "volume", "value", "orders", "part"}:
        return jsonify({"error": "sort must be score, volume, value, orders, or part"}), 400
    if score_mode not in {"volume_value", "repeat_demand"}:
        return jsonify({"error": "score_mode must be volume_value or repeat_demand"}), 400

    month: int | None = None
    if month_raw:
        try:
            month = int(month_raw)
        except ValueError:
            return jsonify({"error": "month must be an integer"}), 400
        if month < 1 or month > 12:
            return jsonify({"error": "month must be between 1 and 12"}), 400

    thresholds: dict[str, float] = {}
    for name in ("min_qty", "min_value"):
        raw = compact_text(request.args.get(name))
        try:
            value = float(raw) if raw else 0.0
        except ValueError:
            return jsonify({"error": f"{name} must be a number"}), 400
        if value < 0:
            return jsonify({"error": f"{name} must be zero or greater"}), 400
        thresholds[name] = value

    try:
        year = _parse_year_arg()
        pp_types, all_selected = _parse_pp_types_arg()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        data = _fetch_report(year, pp_types, all_selected=all_selected, refresh=refresh)
    except Exception as exc:
        logger.exception("job ratio parts query failed")
        return jsonify({"error": f"Job ratio query failed: {exc}"}), 502

    rows = aggregate_ranked_parts(
        data.get("booked_lines") or [],
        year,
        month=month,
        customer_code=customer_code,
        min_qty=thresholds["min_qty"],
        min_value=thresholds["min_value"],
        sort=sort,
        score_mode=score_mode,
    )
    total_qty = sum(float(row.get("total_qty") or 0) for row in rows)
    total_value = sum(float(row.get("total_value") or 0) for row in rows)
    customer_options = [
        {
            "customer_code": row.get("customer_code"),
            "customer_name": row.get("customer_name"),
        }
        for row in data.get("customers") or []
    ]
    customer_options.sort(
        key=lambda row: (
            str(row.get("customer_name") or "").casefold(),
            str(row.get("customer_code") or "").casefold(),
        )
    )

    return jsonify(
        {
            "ok": True,
            "year": year,
            "month": month,
            "customer_code": customer_code,
            "min_qty": thresholds["min_qty"],
            "min_value": thresholds["min_value"],
            "sort": sort,
            "score_mode": score_mode,
            "pp_types": data.get("pp_types") or [],
            "count": len(rows),
            "total_qty": round(total_qty, 2),
            "total_value": round(total_value, 2),
            "customer_options": customer_options,
            "rows": rows,
        }
    )

