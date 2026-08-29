"""Material Tracking - PR enquiry and Purchase Order tabs from COMAIN views.

Scopes:
  pr  -> pr_status_enquiry_view_lg_{ost,hst}
  po  -> pr_status_enquiry_view_po_{ost,new,hst}

Live COMAIN reads, cached in memory for 5 minutes.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, request

from .staged_erp import live_query
from .utils import compact_text

logger = logging.getLogger(__name__)

material_tracking_pr_po_bp = Blueprint("material_tracking_pr_po", __name__)

_CACHE_TTL_SEC = 300
_QUERY_TIMEOUT_MS = 60000
_rows_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_counts_cache: tuple[float, dict[str, dict[str, int]]] | None = None

_VIEW_BY_KEY: dict[tuple[str, str], str] = {
    ("pr", "ost"): "pr_status_enquiry_view_lg_ost",
    ("pr", "hst"): "pr_status_enquiry_view_lg_hst",
    ("po", "ost"): "pr_status_enquiry_view_po_ost",
    ("po", "new"): "pr_status_enquiry_view_po_new",
    ("po", "hst"): "pr_status_enquiry_view_po_hst",
}

_BUCKETS_BY_SCOPE: dict[str, tuple[str, ...]] = {
    "pr": ("ost", "hst"),
    "po": ("ost", "new", "hst"),
}

# po_new lacks GRN / shipment actual columns - select NULLs for a uniform payload.
_SQL_FULL = """
SELECT
    no,
    item_code,
    item_description,
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
    supplier_name,
    sbu_code,
    created_by,
    shipment_voucher_no,
    grn_no,
    grn_date,
    actual_shipment_date,
    actual_arrival_date
FROM public.{view}
ORDER BY pr_date DESC NULLS LAST, purchase_requisition_no, no
"""

_SQL_PO_NEW = """
SELECT
    no,
    item_code,
    item_description,
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
    supplier_name,
    sbu_code,
    created_by,
    NULL::character varying AS shipment_voucher_no,
    NULL::character varying AS grn_no,
    NULL::timestamp without time zone AS grn_date,
    NULL::timestamp without time zone AS actual_shipment_date,
    NULL::timestamp without time zone AS actual_arrival_date
FROM public.pr_status_enquiry_view_po_new
ORDER BY COALESCE(default_order, 2147483647), pr_date DESC NULLS LAST, purchase_requisition_no, no
"""


def resolve_view(scope: str, bucket: str) -> str | None:
    """Return COMAIN view name for a valid (scope, bucket), else None."""
    return _VIEW_BY_KEY.get((scope, bucket))


def cache_key(scope: str, bucket: str) -> str:
    return f"{scope}:{bucket}"


def _sql_for(scope: str, bucket: str) -> str:
    if scope == "po" and bucket == "new":
        return _SQL_PO_NEW
    view = _VIEW_BY_KEY[(scope, bucket)]
    return _SQL_FULL.format(view=view)


def invalidate_material_tracking_pr_po_cache() -> None:
    global _counts_cache
    _rows_cache.clear()
    _counts_cache = None


def _fetch_rows(scope: str, bucket: str, *, refresh: bool = False) -> list[dict[str, Any]]:
    key = cache_key(scope, bucket)
    now = time.time()
    cached = _rows_cache.get(key)
    if not refresh and cached and (now - cached[0]) < _CACHE_TTL_SEC:
        return cached[1]

    fetched = live_query(_sql_for(scope, bucket), timeout_ms=_QUERY_TIMEOUT_MS)
    _rows_cache[key] = (now, fetched)
    return fetched


def _empty_counts() -> dict[str, dict[str, int]]:
    return {scope: {} for scope in _BUCKETS_BY_SCOPE}


def _fetch_counts(
    scope: str,
    bucket: str,
    row_count: int,
    *,
    refresh: bool = False,
) -> dict[str, dict[str, int]]:
    """Chip counts for the current tab, without scanning every PR/PO view.

    Counting history (thousands of rows) on every Outstanding load was blocking
    the page for 10+ seconds. Seed the active bucket from the rows we already
    fetched; keep any cached counts for the other tabs.
    """
    global _counts_cache
    now = time.time()
    counts = _empty_counts()
    if _counts_cache and (now - _counts_cache[0]) < _CACHE_TTL_SEC:
        cached = _counts_cache[1]
        counts = {
            key: dict(value or {}) for key, value in cached.items() if key in counts
        }
        for key in _BUCKETS_BY_SCOPE:
            counts.setdefault(key, {})

    counts.setdefault(scope, {})[bucket] = int(row_count)
    if refresh or not _counts_cache or (now - _counts_cache[0]) >= _CACHE_TTL_SEC:
        _counts_cache = (now, counts)
    else:
        _counts_cache = (_counts_cache[0], counts)
    return counts


@material_tracking_pr_po_bp.get("/api/material-tracking/pr-po")
def api_material_tracking_pr_po():
    scope = compact_text(request.args.get("scope")).lower() or "pr"
    bucket = compact_text(request.args.get("bucket")).lower() or "ost"
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}

    if scope not in _BUCKETS_BY_SCOPE:
        return jsonify({"error": f"unknown scope '{scope}'"}), 400
    if bucket not in _BUCKETS_BY_SCOPE[scope]:
        return jsonify({"error": f"invalid bucket '{bucket}' for scope '{scope}'"}), 400

    view = resolve_view(scope, bucket)
    assert view is not None

    try:
        rows = _fetch_rows(scope, bucket, refresh=refresh)
        counts = _fetch_counts(scope, bucket, len(rows), refresh=refresh)
    except Exception as exc:
        logger.exception("material tracking pr-po ERP query failed (%s/%s)", scope, bucket)
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _rows_cache.get(cache_key(scope, bucket))
    cached_at = cached[0] if cached else time.time()

    return jsonify(
        {
            "ok": True,
            "scope": scope,
            "bucket": bucket,
            "source": f"{view} (live COMAIN)",
            "count": len(rows),
            "counts": counts,
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
