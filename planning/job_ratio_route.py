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
    aggregate_customer_rows,
    aggregate_month_bucket,
    bucket_label,
    enrich_booked_row,
    filter_detail_rows,
    filter_rows_by_pp_types,
    volume_bucket_rules,
)
from .sales_report_alloc import index_pp_jobs_by_so_line, ps_type_from_process_sheet, so_line_key
from .sales_report_route import _BOOKED_SQL, _PP_JOBS_SQL, _erp_query
from .utils import compact_text

logger = logging.getLogger(__name__)

job_ratio_bp = Blueprint("job_ratio", __name__)

_CACHE_TTL_SEC = 300
_report_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_PP_TYPES = ("MPS", "APS", "NPS", "PPS", "CPS", "SR")


def _attach_pp_types(booked: list[dict[str, Any]], pp_jobs: list[dict[str, Any]]) -> None:
    """Resolve process_sheet_no / pp_type in Python — avoids per-line LATERAL ERP joins."""
    jobs_by_line = index_pp_jobs_by_so_line(pp_jobs)
    for row in booked:
        key = so_line_key(row.get("sales_order_no"), row.get("line_item_no"))
        jobs = jobs_by_line.get(key, [])
        if jobs and not compact_text(row.get("process_sheet_no")):
            row["process_sheet_no"] = jobs[0].get("process_sheet_no")
        row["pp_type"] = ps_type_from_process_sheet(row.get("process_sheet_no"))


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
        return {"APS", "NPS"}, False
    parts = [p.strip().upper() for p in raw.split(",") if p.strip()]
    if not parts or parts == ["ALL"]:
        return set(_PP_TYPES), True
    return set(parts), False


def _cache_key(year: int, pp_types: set[str], all_selected: bool) -> str:
    types_key = "ALL" if all_selected else ",".join(sorted(pp_types))
    return f"{year}:{types_key}"


def _fetch_report(year: int, pp_types: set[str], *, all_selected: bool, refresh: bool = False) -> dict[str, Any]:
    key = _cache_key(year, pp_types, all_selected)
    now = time.time()
    if not refresh:
        cached = _report_cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL_SEC:
            return cached[1]

    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    booked_raw = _erp_query(_BOOKED_SQL, (year_start.isoformat(), year_end.isoformat()))
    pp_jobs = _erp_query(_PP_JOBS_SQL)
    _attach_pp_types(booked_raw, pp_jobs)

    enriched = [enrich_booked_row(row, year) for row in booked_raw]
    filtered = filter_rows_by_pp_types(enriched, pp_types, all_selected=all_selected)
    unclassified = [row for row in filtered if not row.get("volume_bucket")]

    matrix = aggregate_month_bucket(filtered, year)
    customers = aggregate_customer_rows(filtered, year)

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
        "lens": "booked",
        "grain": "so_line",
        "pp_types": sorted(pp_types) if not all_selected else list(_PP_TYPES),
        "pp_types_all": all_selected,
        "bucket_rules": {
            bid: {"min": lo, "max": hi}
            for bid, lo, hi in rules
        },
        "bucket_meta": bucket_meta,
        "targets": dict(BUCKET_TARGETS),
        "matrix": matrix,
        "customers": customers,
        "line_count": len(filtered),
        "unclassified_count": len(unclassified),
        "booked_lines": filtered,
    }
    _report_cache[key] = (now, payload)
    return payload


def invalidate_job_ratio_cache() -> None:
    global _report_cache
    _report_cache = {}


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
        logger.exception("job ratio ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

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
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    rows = filter_detail_rows(data["booked_lines"], year=year, month=month, bucket=bucket)
    return jsonify(
        {
            "ok": True,
            "year": year,
            "month": month,
            "bucket": bucket,
            "count": len(rows),
            "rows": rows,
        }
    )
