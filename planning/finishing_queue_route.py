"""Post-machining queue — partials at deburr / inspect / pack / engrave ERP stages."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .erp_wo_merge import (
    FINISHING_STAGE_DESCS,
    finishing_pack_stage_sql_match,
    finishing_stage_bucket,
    finishing_stage_sql_match,
    is_finishing_stage_desc,
)
from .helpers import planner_db, rows
from .utils import compact_text, shipped_quantity_completed

logger = logging.getLogger(__name__)

finishing_queue_bp = Blueprint("finishing_queue", __name__)

_CACHE_TTL_SEC = 60
_CACHE_VERSION = 4
_cache: tuple[float, int, list[dict[str, Any]]] | None = None
_RECENTLY_PACKED_CACHE_TTL_SEC = 300
_recently_packed_cache: tuple[float, int, list[dict[str, Any]]] | None = None

FINISHING_STAGES = tuple(FINISHING_STAGE_DESCS)

_FINISHING_QUEUE_SQL = f"""
WITH partial_base AS (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.ps_id,
        c.pp_partial_no,
        c.part_no,
        c.description AS part_desc,
        c.bom_code,
        c.source_voucher_no AS sales_order_no,
        c.source_line_item_no AS sales_order_line,
        c.due_date,
        COALESCE(NULLIF(c.partial_qty, 0), c.total_qty) AS qty,
        c.current_stage_no,
        c.current_stage_desc,
        c.current_stage_status,
        c.qty_shipped,
        c.so_det_qty,
        c.status AS pp_status
    FROM pp_vouchers_cache c
    WHERE COALESCE(c.current_stage_status, '') <> 'C'
      AND {finishing_stage_sql_match("c.current_stage_desc")}
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
),
with_stage_qty AS (
    SELECT
        b.*,
        w.wo_qty_required AS stage_qty_required,
        w.total_acc_qty_produced AS stage_qty_produced,
        w.total_rej_qty_produced AS stage_qty_rejected
    FROM partial_base b
    LEFT JOIN mfg_wo_status w
           ON w.source_mps_no = b.ps_id
          AND w.pp_partial_no = b.pp_partial_no
          AND TRIM(COALESCE(w.stage_desc, '')) = TRIM(COALESCE(b.current_stage_desc, ''))
)
SELECT *
FROM with_stage_qty
ORDER BY
    CASE
        WHEN TRIM(COALESCE(current_stage_desc, '')) = 'Deburring' THEN 1
        WHEN TRIM(COALESCE(current_stage_desc, '')) = 'Final Inspection' THEN 2
        WHEN TRIM(COALESCE(current_stage_desc, '')) = 'Packing' THEN 3
        WHEN current_stage_desc ILIKE 'Engraving%%Packing%%'
          OR current_stage_desc ILIKE 'Packing%%Engraving%%' THEN 4
        ELSE 5
    END,
    CASE current_stage_status
        WHEN 'I' THEN 0
        WHEN 'R' THEN 1
        WHEN 'P' THEN 2
        ELSE 3
    END,
    due_date NULLS LAST,
    ps_id,
    pp_partial_no
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


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


def _stage_bucket(stage_desc: str) -> str:
    return finishing_stage_bucket(stage_desc)


def _working_week_range(for_date: date | None = None, offset_weeks: int = 0) -> tuple[date, date]:
    """Mon–Sat working week (matches material inspection / new orders)."""
    anchor = for_date or date.today()
    js_day = (anchor.weekday() + 1) % 7  # JS getDay(): Sun=0, Mon=1, …
    monday_offset = -6 if js_day == 0 else 1 - js_day
    start = anchor + timedelta(days=monday_offset + offset_weeks * 7)
    end = start + timedelta(days=5)
    return start, end


def _recently_packed_week_bounds() -> tuple[date, date]:
    this_start, this_end = _working_week_range(date.today(), 0)
    last_start, _last_end = _working_week_range(date.today(), -1)
    return last_start, this_end


def _erp_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [_serialize_row(dict(row)) for row in cur.fetchall()]
    finally:
        release_conn(conn)


def _enrich_recently_packed_from_cache(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not items:
        return items
    ps_ids = sorted({compact_text(item.get("ps_id")) for item in items if compact_text(item.get("ps_id"))})
    if not ps_ids:
        return items

    cache_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    with planner_db() as con:
        cache_rows = rows(
            con.execute(
                """
                SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
                    c.ps_id,
                    c.pp_partial_no,
                    c.part_no,
                    c.description AS part_desc,
                    c.bom_code,
                    c.source_line_item_no AS sales_order_line,
                    COALESCE(NULLIF(c.partial_qty, 0), c.total_qty) AS qty,
                    c.qty_shipped,
                    c.so_det_qty,
                    c.status AS pp_status
                FROM pp_vouchers_cache c
                WHERE c.ps_id = ANY(%s)
                ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
                """,
                (ps_ids,),
            )
        )
    for row in cache_rows:
        key = (compact_text(row.get("ps_id")), int(row.get("pp_partial_no") or 1))
        cache_by_key[key] = row

    enriched: list[dict[str, Any]] = []
    for item in items:
        key = (compact_text(item.get("ps_id")), int(item.get("pp_partial_no") or 1))
        cache_row = cache_by_key.get(key) or {}
        merged = dict(item)
        for field in (
            "part_no",
            "part_desc",
            "bom_code",
            "sales_order_line",
            "qty",
            "qty_shipped",
            "so_det_qty",
            "pp_status",
        ):
            if merged.get(field) in (None, "") and cache_row.get(field) not in (None, ""):
                merged[field] = _serialize_value(cache_row.get(field))
        merged["stage_bucket"] = _stage_bucket(merged.get("current_stage_desc") or "")
        merged["current_stage_status"] = "C"
        enriched.append(merged)
    return enriched


def _fetch_recently_packed(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _recently_packed_cache
    from sync import _pp_ps_id_prefix_params, _pp_ps_id_prefix_sql

    now = time.time()
    if (
        not refresh
        and _recently_packed_cache
        and now - _recently_packed_cache[0] < _RECENTLY_PACKED_CACHE_TTL_SEC
    ):
        return _recently_packed_cache[1]

    week_start, week_end = _recently_packed_week_bounds()
    prefix_sql = _pp_ps_id_prefix_sql("t2.source_pp_no")
    prefix_params = _pp_ps_id_prefix_params()
    sql = f"""
WITH pp_partials AS (
    SELECT DISTINCT ON (pp_voucher_no, partial_qty)
        pp_voucher_no,
        partial_qty,
        pp_partial_no
    FROM public.mfg_pp_partial
    WHERE pp_voucher_no IS NOT NULL
    ORDER BY pp_voucher_no, partial_qty, pp_partial_no
),
packed_rows AS (
    SELECT
        t2.source_pp_no AS ps_id,
        COALESCE(NULLIF(t2.source_pp_partial_no, 0), pp.pp_partial_no, 1) AS pp_partial_no,
        TRIM(COALESCE(t3.stage_desc, '')) AS current_stage_desc,
        t3.actual_end_date::date AS packed_on,
        t2.inventory_code AS part_no,
        t2.origin_voucher_no AS sales_order_no,
        t2.origin_rsd::date AS due_date,
        t3.wo_qty_required AS stage_qty_required,
        t3.total_acc_qty_produced AS stage_qty_produced
    FROM mfg_mps_vch t2
    JOIN mfg_wo_vch t3
      ON t2.wo_voucher_no = t3.voucher_no
     AND t2.stage_no = t3.stage_no
    LEFT JOIN pp_partials pp
      ON pp.pp_voucher_no = t2.source_pp_no
     AND pp.partial_qty = t3.wo_qty_required
     AND COALESCE(t2.source_pp_partial_no, 0) = 0
    WHERE t2.source_pp_no IS NOT NULL
      AND {prefix_sql}
      AND {finishing_pack_stage_sql_match("t3.stage_desc")}
      AND t3.execution_status = 'C'
      AND t3.actual_end_date IS NOT NULL
      AND t3.actual_end_date::date >= %s
      AND t3.actual_end_date::date <= %s
)
SELECT DISTINCT ON (ps_id, pp_partial_no, current_stage_desc)
    ps_id,
    pp_partial_no,
    current_stage_desc,
    packed_on,
    part_no,
    sales_order_no,
    due_date,
    stage_qty_required,
    stage_qty_produced
FROM packed_rows
ORDER BY ps_id, pp_partial_no, current_stage_desc, packed_on DESC
"""
    params = prefix_params + (week_start.isoformat(), week_end.isoformat())
    raw_rows = _erp_query(sql, params)
    items = _enrich_recently_packed_from_cache(raw_rows)
    items.sort(
        key=lambda item: (
            compact_text(item.get("packed_on")),
            compact_text(item.get("ps_id")),
            int(item.get("pp_partial_no") or 0),
        ),
        reverse=True,
    )
    _recently_packed_cache = (now, items)
    return items


def invalidate_finishing_queue_cache() -> None:
    global _cache, _recently_packed_cache
    _cache = None
    _recently_packed_cache = None


def _fetch_finishing_queue(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _cache
    now = time.time()
    if (
        not refresh
        and _cache
        and _cache[1] == _CACHE_VERSION
        and now - _cache[0] < _CACHE_TTL_SEC
    ):
        return _cache[2]

    with planner_db() as con:
        raw_rows = rows(
            con.execute(
                _FINISHING_QUEUE_SQL,
                (list(FINISHING_STAGE_DESCS),),
            )
        )

    items: list[dict[str, Any]] = []
    for row in raw_rows:
        stage_desc = compact_text(row.get("current_stage_desc"))
        if not is_finishing_stage_desc(stage_desc):
            continue
        so_qty = row.get("so_det_qty")
        shipped = float(row.get("qty_shipped") or 0)
        if so_qty is not None and shipped_quantity_completed(so_qty, shipped):
            continue

        item = _serialize_row(row)
        item["stage_bucket"] = _stage_bucket(item.get("current_stage_desc") or "")
        qty = float(item.get("qty") or 0)
        stage_req = float(item.get("stage_qty_required") or qty or 0)
        stage_prod = float(item.get("stage_qty_produced") or 0)
        item["stage_qty_remaining"] = max(0.0, stage_req - stage_prod) if stage_req > 0 else None
        items.append(item)

    _cache = (now, _CACHE_VERSION, items)
    return items


@finishing_queue_bp.get("/finishing-queue")
def finishing_queue_page():
    return render_template("finishing_queue.html", active="finishing_queue")


@finishing_queue_bp.get("/api/finishing-queue")
def api_finishing_queue():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        items = _fetch_finishing_queue(refresh=refresh)
    except Exception as exc:
        logger.exception("post-machining queue query failed")
        return jsonify({"error": str(exc)}), 500

    try:
        recently_packed = _fetch_recently_packed(refresh=refresh)
    except Exception as exc:
        logger.exception("recently packed query failed")
        return jsonify({"error": f"Recently packed query failed: {exc}"}), 502

    counts = {stage: 0 for stage in ("deburring", "final_inspection", "packing", "engraving_packing")}
    status_counts = {"I": 0, "R": 0, "P": 0}
    for item in items:
        bucket = item.get("stage_bucket") or ""
        if bucket in counts:
            counts[bucket] += 1
        status = compact_text(item.get("current_stage_status")).upper()
        if status in status_counts:
            status_counts[status] += 1

    this_start, this_end = _working_week_range(date.today(), 0)
    last_start, last_end = _working_week_range(date.today(), -1)
    packed_this_week = 0
    packed_last_week = 0
    for item in recently_packed:
        packed_on = compact_text(item.get("packed_on"))
        if not packed_on:
            continue
        try:
            packed_date = date.fromisoformat(packed_on[:10])
        except ValueError:
            continue
        if this_start <= packed_date <= this_end:
            packed_this_week += 1
        elif last_start <= packed_date <= last_end:
            packed_last_week += 1

    cached_at = _cache[0] if _cache else time.time()
    packed_cached_at = _recently_packed_cache[0] if _recently_packed_cache else cached_at
    return jsonify(
        {
            "ok": True,
            "items": items,
            "recently_packed": recently_packed,
            "count": len(items),
            "recently_packed_count": len(recently_packed),
            "packed_this_week_count": packed_this_week,
            "packed_last_week_count": packed_last_week,
            "stage_counts": counts,
            "status_counts": status_counts,
            "week_ranges": {
                "this_week": {"start": this_start.isoformat(), "end": this_end.isoformat()},
                "last_week": {"start": last_start.isoformat(), "end": last_end.isoformat()},
            },
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "packed_cached_at": datetime.fromtimestamp(packed_cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "packed_cache_ttl_sec": _RECENTLY_PACKED_CACHE_TTL_SEC,
        }
    )
