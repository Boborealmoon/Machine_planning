"""Material Tracking - inbound shipment QC checklist from COMAIN lg_in_shm.

COMAIN does not expose a table named lg_shipments_in. Inbound logistics
shipments are lg_in_shm_ost_* (outstanding) and lg_in_shm_hst_* (posted).

This checklist reads outstanding inbound lines:

  ready_qc     - GRN already generated (shipment_stage G / grn_no present)
  awaiting_grn - qty received (or actual arrival) but GRN not yet posted
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

material_tracking_inspection_bp = Blueprint("material_tracking_inspection", __name__)

_CACHE_TTL_SEC = 300
_rows_cache: tuple[float, list[dict[str, Any]]] | None = None

_BUCKETS = ("ready_qc", "awaiting_grn")

_SQL = """
SELECT
    h.shipment_voucher_no,
    h.source_voucher_no AS po_no,
    h.party_code AS supplier_code,
    p.party_name AS supplier_name,
    h.grn_no,
    h.shipment_stage,
    h.arrival_date,
    h.arrival_date_actual,
    h.goods_receipt_date,
    h.supplier_do_no,
    h.supplier_do_date,
    h.receiving_location_code,
    h.created_datetime,
    d.line_item_no,
    d.dt_type,
    d.inventory_code,
    d.service_code,
    COALESCE(
        NULLIF(BTRIM(d.inventory_code), ''),
        NULLIF(BTRIM(d.service_code), '')
    ) AS item_code,
    d.line_item_description,
    d.qty,
    d.qty_received,
    d.uom_code,
    COALESCE(q_ship.inspection_voucher_no, q_grn.inspection_voucher_no) AS qi_voucher_no,
    COALESCE(q_ship.status, q_grn.status) AS qi_status
FROM public.lg_in_shm_ost_hdr h
JOIN public.lg_in_shm_ost_det d
  ON d.shipment_voucher_no = h.shipment_voucher_no
LEFT JOIN public.mt_party p
  ON p.party_code = h.party_code
LEFT JOIN (
    SELECT DISTINCT ON (source_voucher_no)
        source_voucher_no,
        inspection_voucher_no,
        status
    FROM public.zz_jasper_th5_quality_inspection_control_header
    WHERE inspection_voucher_no ~ '^QI[0-9]+$'
      AND source_voucher_no IS NOT NULL
      AND BTRIM(source_voucher_no) <> ''
    ORDER BY source_voucher_no, created_datetime DESC NULLS LAST
) q_ship ON q_ship.source_voucher_no = h.shipment_voucher_no
LEFT JOIN (
    SELECT DISTINCT ON (grn_no)
        grn_no,
        inspection_voucher_no,
        status
    FROM public.zz_jasper_th5_quality_inspection_control_header
    WHERE inspection_voucher_no ~ '^QI[0-9]+$'
      AND grn_no IS NOT NULL
      AND BTRIM(grn_no) <> ''
    ORDER BY grn_no, created_datetime DESC NULLS LAST
) q_grn ON q_grn.grn_no = h.grn_no
WHERE
    NULLIF(BTRIM(h.grn_no), '') IS NOT NULL
    OR (
        NULLIF(BTRIM(h.grn_no), '') IS NULL
        AND (
            COALESCE(d.qty_received, 0) > 0
            OR h.arrival_date_actual IS NOT NULL
        )
    )
ORDER BY
    COALESCE(h.goods_receipt_date, h.arrival_date_actual, h.created_datetime) DESC NULLS LAST,
    h.shipment_voucher_no,
    d.line_item_no
"""


def invalidate_material_tracking_inspection_cache() -> None:
    global _rows_cache
    _rows_cache = None


def classify_bucket(row: dict[str, Any]) -> str:
    if compact_text(row.get("grn_no")):
        return "ready_qc"
    return "awaiting_grn"


def split_buckets(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = {key: [] for key in _BUCKETS}
    for row in rows:
        buckets[classify_bucket(row)].append(row)
    return buckets


def _fetch_rows(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _rows_cache
    now = time.time()
    if not refresh and _rows_cache and (now - _rows_cache[0]) < _CACHE_TTL_SEC:
        return _rows_cache[1]

    fetched = live_query(_SQL, timeout_ms=60000)
    _rows_cache = (now, fetched)
    return fetched


@material_tracking_inspection_bp.get("/api/material-tracking/qc-checklist")
def api_material_tracking_qc_checklist():
    bucket = compact_text(request.args.get("bucket")).lower() or "ready_qc"
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}

    if bucket not in _BUCKETS:
        return jsonify({"error": f"invalid bucket '{bucket}'"}), 400

    try:
        all_rows = _fetch_rows(refresh=refresh)
    except Exception as exc:
        logger.exception("material tracking qc checklist ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    buckets = split_buckets(all_rows)
    rows = buckets[bucket]
    cached_at = _rows_cache[0] if _rows_cache else time.time()

    return jsonify(
        {
            "ok": True,
            "bucket": bucket,
            "source": "lg_in_shm_ost_hdr + lg_in_shm_ost_det (live COMAIN)",
            "count": len(rows),
            "counts": {key: len(value) for key, value in buckets.items()},
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
