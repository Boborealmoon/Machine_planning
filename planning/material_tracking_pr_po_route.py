"""Material Tracking - PR enquiry and Purchase Order tabs from COMAIN.

Scopes:
  pr  ost -> draft PRs + posted PRs that do not yet have a PO
  pr  hst -> posted PRs that already have a PO
  po  ost -> open / under-variation purchase orders (po_order_ost status O, U)
  po  new -> draft / pending purchase orders (po_order_new)
  po  hst -> completed / cancelled purchase orders (po_order_ost status C, X)

The previous pr_status_enquiry_view_lg_* / _po_* sources were inbound-shipment
views, so raw-material POs never appeared and remarks were not selected.

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

_SOURCE_BY_KEY: dict[tuple[str, str], str] = {
    ("pr", "ost"): "pr_req_new + pr_req_hst (no PO)",
    ("pr", "hst"): "pr_req_hst (with PO)",
    ("po", "ost"): "po_order_ost (open)",
    ("po", "new"): "po_order_new",
    ("po", "hst"): "po_order_ost (completed/cancelled)",
}

_BUCKETS_BY_SCOPE: dict[str, tuple[str, ...]] = {
    "pr": ("ost", "hst"),
    "po": ("ost", "new", "hst"),
}

_NULL_GRN = """
    NULL::character varying AS shipment_voucher_no,
    NULL::character varying AS grn_no,
    NULL::timestamp without time zone AS grn_date,
    NULL::timestamp without time zone AS actual_shipment_date,
    NULL::timestamp without time zone AS actual_arrival_date
"""

_PO_SELECT = f"""
SELECT
    ROW_NUMBER() OVER (
        ORDER BY h.order_date DESC NULLS LAST, h.purchase_order_no, d.line_item_no
    ) AS no,
    COALESCE(
        NULLIF(TRIM(d.inventory_code), ''),
        NULLIF(TRIM(d.service_code), ''),
        NULLIF(TRIM(d.fixed_asset_code), '')
    ) AS item_code,
    COALESCE(inv.main_desc, srv.service_desc) AS item_description,
    d.line_item_description,
    d.qty,
    {{status_expr}} AS status,
    COALESCE(
        NULLIF(TRIM(h.project_no), ''),
        NULLIF(TRIM(h.sales_order_no), ''),
        NULLIF(TRIM(h.alloc_to_so_no), '')
    ) AS project_no,
    h.purchase_requisition_no,
    NULL::integer AS pr_revision_no,
    NULL::timestamp without time zone AS pr_date,
    NULL::timestamp without time zone AS required_arrival_date,
    d.line_item_no,
    shm.shipment_no,
    h.purchase_order_no,
    {{po_revision_expr}} AS po_revision_no,
    h.order_date AS po_date,
    shm.estimated_shipment_date,
    shm.estimated_arrival_date,
    h.supplier_code,
    p.party_name AS supplier_name,
    h.sbu_code,
    h.created_by,
    h.sales_order_no,
    COALESCE(NULLIF(TRIM(h.remarks), ''), NULLIF(TRIM(h.internal_remarks), '')) AS remarks,
    h.internal_remarks,
    {_NULL_GRN.strip()}
"""

_PO_OST_STATUS = """
    CASE h.status
        WHEN 'O' THEN 'PO Outstanding'
        WHEN 'U' THEN 'PO Under Variation'
        WHEN 'C' THEN 'PO Completed'
        WHEN 'X' THEN 'PO Cancelled'
        ELSE COALESCE(h.status, '')
    END
"""

_PO_NEW_STATUS = """
    CASE
        WHEN h.state::text = 'N' AND COALESCE(h.approved_flag::text, 'N') = 'R' THEN 'PO Rejected'
        WHEN h.state::text = 'P' THEN 'PO Pending Approval'
        ELSE 'PO Draft'
    END
"""

_SQL_PO_OST = f"""
{_PO_SELECT.format(status_expr=_PO_OST_STATUS, po_revision_expr="h.revision_no")}
FROM po_order_ost_hdr h
JOIN po_order_ost_det d
  ON d.purchase_order_no = h.purchase_order_no
LEFT JOIN mt_inventory inv
  ON inv.inventory_code = d.inventory_code
LEFT JOIN mt_service srv
  ON srv.service_code = d.service_code
LEFT JOIN mt_party p
  ON p.party_code = h.supplier_code
LEFT JOIN (
    SELECT
        purchase_order_no,
        MIN(shipment_no) AS shipment_no,
        MIN(etd_date) AS estimated_shipment_date,
        MIN(eta_date) AS estimated_arrival_date
    FROM po_order_ost_shm_hdr
    GROUP BY purchase_order_no
) shm ON shm.purchase_order_no = h.purchase_order_no
WHERE h.status IN ('O', 'U')
ORDER BY h.order_date DESC NULLS LAST, h.purchase_order_no, d.line_item_no
"""

_SQL_PO_HST = f"""
{_PO_SELECT.format(status_expr=_PO_OST_STATUS, po_revision_expr="h.revision_no")}
FROM po_order_ost_hdr h
JOIN po_order_ost_det d
  ON d.purchase_order_no = h.purchase_order_no
LEFT JOIN mt_inventory inv
  ON inv.inventory_code = d.inventory_code
LEFT JOIN mt_service srv
  ON srv.service_code = d.service_code
LEFT JOIN mt_party p
  ON p.party_code = h.supplier_code
LEFT JOIN (
    SELECT
        purchase_order_no,
        MIN(shipment_no) AS shipment_no,
        MIN(etd_date) AS estimated_shipment_date,
        MIN(eta_date) AS estimated_arrival_date
    FROM po_order_ost_shm_hdr
    GROUP BY purchase_order_no
) shm ON shm.purchase_order_no = h.purchase_order_no
WHERE h.status IN ('C', 'X')
ORDER BY h.order_date DESC NULLS LAST, h.purchase_order_no, d.line_item_no
"""

_SQL_PO_NEW = f"""
{_PO_SELECT.format(status_expr=_PO_NEW_STATUS, po_revision_expr="NULL::integer")}
FROM po_order_new_hdr h
JOIN po_order_new_det d
  ON d.purchase_order_no = h.purchase_order_no
LEFT JOIN mt_inventory inv
  ON inv.inventory_code = d.inventory_code
LEFT JOIN mt_service srv
  ON srv.service_code = d.service_code
LEFT JOIN mt_party p
  ON p.party_code = h.supplier_code
LEFT JOIN (
    SELECT
        purchase_order_no,
        MIN(shipment_no) AS shipment_no,
        MIN(etd_date) AS estimated_shipment_date,
        MIN(eta_date) AS estimated_arrival_date
    FROM po_order_new_shm_hdr
    GROUP BY purchase_order_no
) shm ON shm.purchase_order_no = h.purchase_order_no
ORDER BY h.order_date DESC NULLS LAST, h.purchase_order_no, d.line_item_no
"""

_PR_HST_SELECT = f"""
SELECT
    ROW_NUMBER() OVER (
        ORDER BY h.purchase_requisition_date DESC NULLS LAST, h.purchase_requisition_no, d.line_item_no
    ) AS no,
    COALESCE(
        NULLIF(TRIM(d.inventory_code), ''),
        NULLIF(TRIM(d.service_code), ''),
        NULLIF(TRIM(d.fixed_asset_code), '')
    ) AS item_code,
    COALESCE(NULLIF(TRIM(d.item_description), ''), inv.main_desc, srv.service_desc) AS item_description,
    d.line_item_description,
    d.qty,
    {{status_literal}} AS status,
    COALESCE(
        NULLIF(TRIM(h.project_no), ''),
        NULLIF(TRIM(h.source_project_no), ''),
        NULLIF(TRIM(h.source_voucher_no), '')
    ) AS project_no,
    h.purchase_requisition_no,
    h.revision_no AS pr_revision_no,
    h.purchase_requisition_date AS pr_date,
    shm.required_arrival_date,
    d.line_item_no,
    shm.shipment_no,
    po.purchase_order_no,
    NULL::integer AS po_revision_no,
    po.po_date,
    NULL::timestamp without time zone AS estimated_shipment_date,
    NULL::timestamp without time zone AS estimated_arrival_date,
    COALESCE(po.supplier_code, h.default_supplier_code) AS supplier_code,
    p.party_name AS supplier_name,
    h.sbu_code,
    h.created_by,
    NULL::character varying AS sales_order_no,
    COALESCE(NULLIF(TRIM(h.remarks), ''), NULLIF(TRIM(h.internal_remarks), '')) AS remarks,
    h.internal_remarks,
    {_NULL_GRN.strip()}
FROM pr_req_hst_hdr h
JOIN pr_req_hst_max_revision mx
  ON mx.purchase_requisition_no = h.purchase_requisition_no
 AND mx.max_revision_no = h.revision_no
JOIN pr_req_hst_det d
  ON d.purchase_requisition_no = h.purchase_requisition_no
 AND d.revision_no = h.revision_no
LEFT JOIN mt_inventory inv
  ON inv.inventory_code = d.inventory_code
LEFT JOIN mt_service srv
  ON srv.service_code = d.service_code
LEFT JOIN (
    SELECT
        purchase_requisition_no,
        MIN(purchase_order_no) AS purchase_order_no,
        MIN(order_date) AS po_date,
        MIN(supplier_code) AS supplier_code
    FROM po_order_ost_hdr
    WHERE NULLIF(TRIM(purchase_requisition_no), '') IS NOT NULL
    GROUP BY purchase_requisition_no
) po ON po.purchase_requisition_no = h.purchase_requisition_no
LEFT JOIN mt_party p
  ON p.party_code = COALESCE(po.supplier_code, h.default_supplier_code)
LEFT JOIN (
    SELECT
        purchase_requisition_no,
        revision_no,
        MIN(shipment_no) AS shipment_no,
        MIN(required_date) AS required_arrival_date
    FROM pr_req_hst_shm_hdr
    GROUP BY purchase_requisition_no, revision_no
) shm
  ON shm.purchase_requisition_no = h.purchase_requisition_no
 AND shm.revision_no = h.revision_no
"""

_SQL_PR_NEW = f"""
SELECT
    ROW_NUMBER() OVER (
        ORDER BY h.purchase_requisition_date DESC NULLS LAST, h.purchase_requisition_no, d.line_item_no
    ) AS no,
    COALESCE(
        NULLIF(TRIM(d.inventory_code), ''),
        NULLIF(TRIM(d.service_code), ''),
        NULLIF(TRIM(d.fixed_asset_code), '')
    ) AS item_code,
    COALESCE(NULLIF(TRIM(d.item_description), ''), inv.main_desc, srv.service_desc) AS item_description,
    d.line_item_description,
    d.qty,
    'PR Draft' AS status,
    COALESCE(
        NULLIF(TRIM(h.project_no), ''),
        NULLIF(TRIM(h.source_project_no), ''),
        NULLIF(TRIM(h.source_voucher_no), '')
    ) AS project_no,
    h.purchase_requisition_no,
    h.revision_no AS pr_revision_no,
    h.purchase_requisition_date AS pr_date,
    NULL::timestamp without time zone AS required_arrival_date,
    d.line_item_no,
    NULL::integer AS shipment_no,
    NULL::character varying AS purchase_order_no,
    NULL::integer AS po_revision_no,
    NULL::timestamp without time zone AS po_date,
    NULL::timestamp without time zone AS estimated_shipment_date,
    NULL::timestamp without time zone AS estimated_arrival_date,
    h.default_supplier_code AS supplier_code,
    p.party_name AS supplier_name,
    h.sbu_code,
    h.created_by,
    NULL::character varying AS sales_order_no,
    COALESCE(NULLIF(TRIM(h.remarks), ''), NULLIF(TRIM(h.internal_remarks), '')) AS remarks,
    h.internal_remarks,
    {_NULL_GRN.strip()}
FROM pr_req_new_hdr h
JOIN pr_req_new_det d
  ON d.purchase_requisition_no = h.purchase_requisition_no
LEFT JOIN mt_inventory inv
  ON inv.inventory_code = d.inventory_code
LEFT JOIN mt_service srv
  ON srv.service_code = d.service_code
LEFT JOIN mt_party p
  ON p.party_code = h.default_supplier_code
"""

_SQL_PR_OST = f"""
{_PR_HST_SELECT.format(status_literal="'PR Outstanding'")}
WHERE po.purchase_order_no IS NULL
UNION ALL
{_SQL_PR_NEW}
ORDER BY pr_date DESC NULLS LAST, purchase_requisition_no, line_item_no
"""

_SQL_PR_HST = f"""
{_PR_HST_SELECT.format(status_literal="'PR Converted'")}
WHERE po.purchase_order_no IS NOT NULL
ORDER BY h.purchase_requisition_date DESC NULLS LAST, h.purchase_requisition_no, d.line_item_no
"""

_SQL_BY_KEY: dict[tuple[str, str], str] = {
    ("pr", "ost"): _SQL_PR_OST,
    ("pr", "hst"): _SQL_PR_HST,
    ("po", "ost"): _SQL_PO_OST,
    ("po", "new"): _SQL_PO_NEW,
    ("po", "hst"): _SQL_PO_HST,
}


def resolve_view(scope: str, bucket: str) -> str | None:
    """Return a short COMAIN source label for a valid (scope, bucket), else None."""
    return _SOURCE_BY_KEY.get((scope, bucket))


def cache_key(scope: str, bucket: str) -> str:
    return f"{scope}:{bucket}"


def _sql_for(scope: str, bucket: str) -> str:
    return _SQL_BY_KEY[(scope, bucket)]


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
