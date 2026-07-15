"""PR status enquiry — tooling purchase frequency analytics from COMAIN.

Reads live from public.pr_status_enquiry_view. Cached in memory for 5 minutes.
UI aggregates by item_code (purchase frequency) with drill-down to PR lines.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .staged_erp import live_query
from .utils import compact_text

logger = logging.getLogger(__name__)

pr_status_enquiry_bp = Blueprint("pr_status_enquiry", __name__)

_CACHE_TTL_SEC = 300
_cache: tuple[float, list[dict[str, Any]]] | None = None

_PR_STATUS_SQL = """
SELECT
    no,
    item_code,
    item_description,
    inventory_code,
    service_code,
    line_item_description,
    qty,
    status,
    project_no,
    purchase_requisition_no,
    pr_revision_no,
    pr_date,
    required_arrival_date,
    line_item_no,
    shipment_no,
    purchase_order_no,
    po_revision_no,
    po_date,
    estimated_shipment_date,
    estimated_arrival_date,
    supplier_code,
    shipment_voucher_no,
    grn_no,
    grn_date,
    actual_shipment_date,
    actual_arrival_date,
    inspection_voucher_no,
    ncr_voucher_no,
    ncr_completion_date_time,
    ncr_disposition_type,
    red_flag,
    ncr_remarks,
    default_order,
    sbu_code,
    created_by
FROM public.pr_status_enquiry_view
ORDER BY pr_date DESC NULLS LAST, purchase_requisition_no, no
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


def invalidate_pr_status_enquiry_cache() -> None:
    global _cache
    _cache = None


def _fetch(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _cache
    now = time.time()
    if not refresh and _cache and (now - _cache[0]) < _CACHE_TTL_SEC:
        return _cache[1]

    fetched = live_query(_PR_STATUS_SQL)
    rows = [{key: _serialize_value(val) for key, val in raw.items()} for raw in fetched]
    _cache = (now, rows)
    return rows


@pr_status_enquiry_bp.get("/pr-status-enquiry")
def pr_status_enquiry_page():
    return render_template("pr_status_enquiry.html", active="pr_status_enquiry")


@pr_status_enquiry_bp.get("/api/pr-status-enquiry")
def api_pr_status_enquiry():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}

    try:
        rows = _fetch(refresh=refresh)
    except Exception as exc:
        logger.exception("pr_status_enquiry ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached_at = _cache[0] if _cache else time.time()
    statuses = sorted({compact_text(r.get("status")) for r in rows if compact_text(r.get("status"))})
    sbu_codes = sorted({compact_text(r.get("sbu_code")) for r in rows if compact_text(r.get("sbu_code"))})

    return jsonify(
        {
            "ok": True,
            "source": "pr_status_enquiry_view (live COMAIN)",
            "count": len(rows),
            "statuses": statuses,
            "sbu_codes": sbu_codes,
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
