"""Finishing queue — partials at post-machining ERP stages (deburr, inspect, pack, engrave)."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .erp_wo_merge import FINISHING_STAGE_DESCS, finishing_stage_bucket, is_finishing_stage_desc
from .helpers import planner_db, rows
from .utils import compact_text, shipped_quantity_completed

logger = logging.getLogger(__name__)

finishing_queue_bp = Blueprint("finishing_queue", __name__)

_CACHE_TTL_SEC = 60
_CACHE_VERSION = 2
_cache: tuple[float, int, list[dict[str, Any]]] | None = None

FINISHING_STAGES = tuple(FINISHING_STAGE_DESCS)

_FINISHING_QUEUE_SQL = """
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
      AND (
            c.current_stage_desc = ANY(%s)
         OR c.current_stage_desc ILIKE 'Engraving%%Packing%%'
      )
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
        WHEN current_stage_desc ILIKE 'Engraving%%Packing%%' THEN 4
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


def invalidate_finishing_queue_cache() -> None:
    global _cache
    _cache = None


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
        raw_rows = rows(con.execute(_FINISHING_QUEUE_SQL, (list(FINISHING_STAGES),)))

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
        logger.exception("finishing queue query failed")
        return jsonify({"error": str(exc)}), 500

    counts = {stage: 0 for stage in ("deburring", "final_inspection", "packing", "engraving_packing")}
    status_counts = {"I": 0, "R": 0, "P": 0}
    for item in items:
        bucket = item.get("stage_bucket") or ""
        if bucket in counts:
            counts[bucket] += 1
        status = compact_text(item.get("current_stage_status")).upper()
        if status in status_counts:
            status_counts[status] += 1

    cached_at = _cache[0] if _cache else time.time()
    return jsonify(
        {
            "ok": True,
            "items": items,
            "count": len(items),
            "stage_counts": counts,
            "status_counts": status_counts,
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
        }
    )
