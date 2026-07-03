"""Kobelco MPS sales archive — synced ERP report staging."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .utils import compact_text

logger = logging.getLogger(__name__)

kobelco_mps_archive_bp = Blueprint("kobelco_mps_archive", __name__)

_CACHE_TTL_SEC = 300
_cache: tuple[float, list[dict[str, Any]]] | None = None

_STAGED_KOBELCO_SQL = """
SELECT
    pk_so,
    posted_date,
    sales_quotation_no,
    customer_code,
    line_item_no,
    dwg_pn,
    description,
    sn,
    customer_po_no,
    qty,
    due_date,
    NULL::text AS blank1,
    NULL::text AS blank2,
    inspection_report_no,
    coc_no,
    ps_number,
    line_item_description,
    segment_1_code
FROM public.stg_kobelco_mps_archive
ORDER BY ps_number DESC NULLS LAST
"""

_LIVE_KOBELCO_MPS_ARCHIVE_SQL = """
SELECT
    so.sales_order_no          AS pk_so,
    so.order_date               AS posted_date,
    so.reference_no              AS sales_quotation_no,
    so.customer_code,
    so.line_item_no,
    so.inventory_code            AS dwg_pn,
    so.main_desc                 AS description,
    COALESCE(mafs.sn_remarks, 'N/A') AS sn,
    so.customer_po_no,
    so.qty,
    shm.requested_shipment_date  AS due_date,
    NULL::text AS blank1,
    NULL::text AS blank2,
    'IR-' || mafs.pk_key_pp_voucher_no   AS inspection_report_no,
    'COC-' || mafs.pk_key_pp_voucher_no  AS coc_no,
    mafs.pk_key_pp_voucher_no    AS ps_number,
    so.line_item_description,
    so.segment_1_code
FROM public.so_order_kobelco_view so
LEFT JOIN public.so_shm_detail shm
    ON shm.sales_order_no = so.sales_order_no
   AND shm.line_item_no   = so.line_item_no
LEFT JOIN public.mfg_arc_format_sourcing_v1_view mafs
    ON mafs.pk_key_sales_order_no      = so.sales_order_no
   AND mafs.pk_key_sales_line_item_no  = so.line_item_no
WHERE so.segment_1_code = 'MPS'
  AND so.order_date > DATE '2025-01-01'
ORDER BY mafs.pk_key_pp_voucher_no DESC NULLS LAST
"""


from .staged_erp import fetch_rows


def invalidate_kobelco_mps_archive_cache() -> None:
    global _cache
    _cache = None
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("kobelco_mps:")


def _fetch_kobelco_mps_archive(*, refresh: bool = False) -> dict[str, Any]:
    global _cache
    now = time.time()
    if not refresh and _cache and now - _cache[0] < _CACHE_TTL_SEC:
        rows = _cache[1]
        cached_at = _cache[0]
    else:
        rows = fetch_rows(_STAGED_KOBELCO_SQL, live_sql=_LIVE_KOBELCO_MPS_ARCHIVE_SQL)
        _cache = (now, rows)
        cached_at = now

    return {
        "ok": True,
        "count": len(rows),
        "rows": rows,
        "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
        "cache_ttl_sec": _CACHE_TTL_SEC,
    }


@kobelco_mps_archive_bp.get("/kobelco-mps-archive")
def kobelco_mps_archive_page():
    return render_template(
        "kobelco_mps_archive.html",
        active="kobelco_mps_archive",
    )


@kobelco_mps_archive_bp.get("/api/kobelco-mps-archive")
def api_kobelco_mps_archive():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    try:
        return jsonify(_fetch_kobelco_mps_archive(refresh=refresh))
    except Exception as exc:
        logger.exception("kobelco MPS archive ERP query failed")
        return jsonify({"ok": False, "error": str(exc)}), 502
