"""Stuck-work views — two tabs surfacing gaps in the S/O → PP → WO pipeline.

Tab "no-pp": open S/O lines with no PP voucher raised yet (anti-join of
    so_order_ost_det against mfg_pp_vch on source_voucher_no + source_line_item_no).
Tab "no-wo": PP vouchers with no work order raised yet (anti-join of mfg_pp_vch
    against mfg_mps_vch/mfg_wo_vch on source_pp_no).

Read live from COMAIN, cached in memory for 5 minutes (never stored in Supabase).
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .frame_agreement_service import (
    is_frame_agreement_part,
    load_frame_agreement_part_keys,
)
from .helpers import planner_db
from .staged_erp import live_query
from .utils import compact_text, shipped_quantity_completed

logger = logging.getLogger(__name__)

pending_pp_bp = Blueprint("pending_pp", __name__)

_CACHE_TTL_SEC = 300
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

_TABS = ("no-pp", "no-wo")

# ── Tab "no-pp": open S/O lines with no PP voucher raised against them ────────
_PENDING_PP_SQL = """
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
    det.required_shipment_date AS due_date,
    hdr.order_date AS order_date,
    hdr.customer_code AS customer_code,
    COALESCE(
        NULLIF(TRIM(hdr.customer_short_name), ''),
        NULLIF(TRIM(hdr.customer_name), '')
    ) AS customer_name,
    COALESCE(NULLIF(TRIM(hdr.customer_po_no), ''), '') AS customer_po_no,
    hdr.sales_person_name AS sales_person_name,
    hdr.sbu_desc AS sbu_desc,
    ost.status AS so_status
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr ost
       ON ost.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view hdr
       ON hdr.sales_order_no = det.sales_order_no
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = det.inventory_code
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = det.sales_order_no
      AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN public.mfg_pp_vch pp
       ON pp.source_voucher_no = det.sales_order_no
      AND regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(ost.status, '') <> 'V'
  AND pp.pp_voucher_no IS NULL
  AND GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) > 0.0001
ORDER BY det.required_shipment_date NULLS LAST, det.sales_order_no, det.line_item_no
"""

# ── Tab "no-wo": PP vouchers with no work order (mfg_wo_vch) raised yet ───────
_PENDING_WO_SQL = """
SELECT
    pp.pp_voucher_no,
    pp.source_voucher_no AS sales_order_no,
    regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    pp.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(pp.bom_desc), ''),
        NULLIF(TRIM(det.line_item_description), '')
    ) AS description,
    pp.pp_qty AS pp_qty,
    pp.proposed_edd AS proposed_edd,
    COALESCE(det.required_shipment_date, pp.source_rsd) AS due_date,
    hdr.order_date AS order_date,
    hdr.customer_code AS customer_code,
    COALESCE(
        NULLIF(TRIM(hdr.customer_short_name), ''),
        NULLIF(TRIM(hdr.customer_name), '')
    ) AS customer_name,
    COALESCE(NULLIF(TRIM(part.customer_po_no), ''), NULLIF(TRIM(hdr.customer_po_no), ''), '') AS customer_po_no,
    hdr.sales_person_name AS sales_person_name,
    hdr.sbu_desc AS sbu_desc,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped
FROM public.mfg_pp_vch pp
LEFT JOIN public.so_order_view hdr
       ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.so_order_ost_det det
       ON det.sales_order_no = pp.source_voucher_no
      AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = pp.inventory_code
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT pp_voucher_no, MAX(customer_po_no) AS customer_po_no
    FROM public.mfg_pp_partial_view
    GROUP BY pp_voucher_no
) part ON part.pp_voucher_no = pp.pp_voucher_no
WHERE pp.source_voucher_no LIKE 'SO/%%'
  AND NOT EXISTS (
      SELECT 1
      FROM public.mfg_mps_vch mps
      JOIN public.mfg_wo_vch wo ON wo.voucher_no = mps.wo_voucher_no
      WHERE mps.source_pp_no = pp.pp_voucher_no
  )
ORDER BY COALESCE(det.required_shipment_date, pp.source_rsd) NULLS LAST,
         pp.source_voucher_no, pp.pp_voucher_no
"""

_SQL_BY_TAB = {"no-pp": _PENDING_PP_SQL, "no-wo": _PENDING_WO_SQL}


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


def _coerce_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = compact_text(str(value))
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _load_fa_keys() -> set[str]:
    try:
        with planner_db() as con:
            return load_frame_agreement_part_keys(con)
    except Exception as exc:
        logger.warning("frame agreement key load skipped: %s", exc)
        return set()


def _load_ps_count_by_part() -> dict[str, int]:
    """part_no (upper) -> number of distinct process sheets ever raised for it.

    A part with no history (or only the current PS) is treated as a new part.
    Reuses the New Orders repeat lookup so the definition stays consistent.
    """
    try:
        from .new_orders_route import _fetch_repeat_groups_by_part

        groups = _fetch_repeat_groups_by_part()
    except Exception as exc:
        logger.warning("new-part history load skipped: %s", exc)
        return {}

    out: dict[str, int] = {}
    for part_no, entries in groups.items():
        key = compact_text(part_no).upper()
        if not key:
            continue
        distinct_ps = {compact_text(ps).upper() for ps, _ in entries if compact_text(ps)}
        out[key] = len(distinct_ps)
    return out


def _is_new_part(part_no: Any, ps_count_by_part: dict[str, int], *, has_own_ps: bool) -> bool:
    key = compact_text(part_no).upper()
    if not key:
        return False
    count = ps_count_by_part.get(key, 0)
    # no-wo rows already own one PS in the history count; no-pp rows own none.
    return count <= (1 if has_own_ps else 0)


def _fetch(tab: str, *, refresh: bool = False) -> list[dict[str, Any]]:
    now = time.time()
    cached = _cache.get(tab)
    if not refresh and cached and (now - cached[0]) < _CACHE_TTL_SEC:
        return cached[1]

    fetched = live_query(_SQL_BY_TAB[tab])
    fa_keys = _load_fa_keys()
    ps_count_by_part = _load_ps_count_by_part()
    has_own_ps = tab == "no-wo"
    today = date.today()
    rows: list[dict[str, Any]] = []
    for raw in fetched:
        # For the no-wo tab, drop fully-shipped lines (no work left to raise a WO for).
        if tab == "no-wo" and shipped_quantity_completed(
            raw.get("so_det_qty"), raw.get("qty_shipped")
        ):
            continue
        row = {key: _serialize_value(val) for key, val in raw.items()}
        order_dt = _coerce_date(raw.get("order_date"))
        due_dt = _coerce_date(raw.get("due_date"))
        row["age_days"] = (today - order_dt).days if order_dt else None
        row["days_to_due"] = (due_dt - today).days if due_dt else None
        row["overdue"] = bool(due_dt and due_dt < today)
        row["is_frame_agreement"] = is_frame_agreement_part(
            raw.get("inventory_code"), fa_keys
        )
        row["is_new_part"] = _is_new_part(
            raw.get("inventory_code"), ps_count_by_part, has_own_ps=has_own_ps
        )
        rows.append(row)

    _cache[tab] = (now, rows)
    return rows


def invalidate_pending_pp_cache() -> None:
    _cache.clear()


@pending_pp_bp.get("/pending-pp")
def pending_pp_page():
    return render_template("pending_pp.html", active="pending_pp")


@pending_pp_bp.get("/api/pending-pp")
def api_pending_pp():
    tab = compact_text(request.args.get("tab")).lower() or "no-pp"
    if tab not in _TABS:
        return jsonify({"error": f"unknown tab '{tab}'"}), 400
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        rows = _fetch(tab, refresh=refresh)
    except Exception as exc:
        logger.exception("pending %s ERP query failed", tab)
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _cache.get(tab)
    cached_at = cached[0] if cached else time.time()
    so_count = len({compact_text(r.get("sales_order_no")) for r in rows})
    overdue_count = sum(1 for r in rows if r.get("overdue"))
    source = (
        "so_order_ost_det (live COMAIN)"
        if tab == "no-pp"
        else "mfg_pp_vch (live COMAIN)"
    )

    return jsonify(
        {
            "ok": True,
            "tab": tab,
            "source": source,
            "count": len(rows),
            "so_count": so_count,
            "overdue_count": overdue_count,
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
