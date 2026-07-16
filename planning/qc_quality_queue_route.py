"""Manufacturing QC queue — live ERP qc_quality_inspection (type M) + WO enrichment."""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, request

from .staged_erp import fetch_rows
from .utils import compact_text

logger = logging.getLogger(__name__)

qc_quality_queue_bp = Blueprint("qc_quality_queue", __name__)

_CACHE_TTL_SEC = 300
_CACHE_VERSION = 8
_cache: tuple[float, int, list[dict[str, Any]]] | None = None

# Link chain:
#   qc_quality_inspection.source_job_assignment_seq -> qc_job_assignment.job_assignment_seq_no
#   qc_job_assignment.work_order_no -> mfg_wo_vch.voucher_no
#   qc_job_assignment_alloc.source_voucher_no -> mfg_wo_vch.source_mps_no (when alloc exists)
#   mfg_mps_vch.wo_voucher_no + stage_no -> source_pp_no (process sheet / PP / APS)
#   Avoid per-row LATERAL on mfg_mps_vch — hash joins stay fast across ~16k inspections.
_QC_QUALITY_QUEUE_SQL = """
SELECT
    h.inspection_voucher_no,
    h.source_job_assignment_seq,
    h.actual_start_date,
    h.actual_end_date,
    h.document_completed,
    h.accepted_qty,
    h.rejected_qty,
    h.status,
    h.type,
    h.generate_ncr,
    h.internal_remarks,
    h.external_remarks,
    h.accepted_no_of_pack,
    h.ncr_voucher_no,
    h.inspector_code,
    h.scheduled_start_date,
    h.last_inspection,
    h.inspection_qty,
    h.source_seq_partial_no,
    h.alloc_ncr,
    h.reference_no,
    h.work_order_no AS header_work_order_no,
    h.pk_no_bom,
    h.pk_no_stage,
    h.inventory_code,
    h.generated_from_rework,
    h.rework_no,
    h.created_by,
    h.created_datetime,
    h.last_updated_by,
    h.last_updated_datetime,
    h.sample_qty,
    h.actual_production_qty,
    h.new_rework_no,
    h.last_scanned_pk_trace_no,
    h.lot_prefix,
    ja.work_order_no,
    ja.qty_assigned AS job_qty_assigned,
    ja.inspector_code AS job_inspector_code,
    COALESCE(w.voucher_no, w_alloc.voucher_no) AS wo_voucher_no,
    COALESCE(w.source_mps_no, a.source_voucher_no) AS mps_no,
    COALESCE(w.inventory_code, w_alloc.inventory_code) AS wo_part_no,
    COALESCE(w.stage_desc, w_alloc.stage_desc) AS wo_stage_desc,
    COALESCE(w.stage_no, w_alloc.stage_no) AS wo_stage_no,
    COALESCE(w.execution_status, w_alloc.execution_status) AS wo_execution_status,
    COALESCE(w.origin_voucher_no, w_alloc.origin_voucher_no) AS so_no,
    COALESCE(w.segment_1_code, w_alloc.segment_1_code) AS wo_segment_code,
    COALESCE(w.wo_qty_required, w_alloc.wo_qty_required) AS wo_qty_required,
    COALESCE(w.plan_start_date, w_alloc.plan_start_date) AS wo_plan_start_date,
    COALESCE(w.plan_end_date, w_alloc.plan_end_date) AS wo_plan_end_date,
    a.source_voucher_no AS alloc_source_mps_no,
    a.receiving_alloc_qty AS alloc_receiving_qty,
    a.source_allocation_type AS alloc_source_type,
    w_alloc.voucher_no AS alloc_wo_voucher_no,
    w_alloc.inventory_code AS alloc_wo_part_no,
    w_alloc.stage_desc AS alloc_wo_stage_desc,
    jl.lot_seq_no AS job_lot_seq_no,
    jl.inventory_code AS job_lot_part_no,
    jl.source_location_code AS job_lot_location,
    jl.lot_no AS job_lot_no,
    jl.accepted_qty AS job_lot_accepted_qty,
    COALESCE(mps_by_wo.source_pp_no, mps_by_no.source_pp_no) AS process_sheet_no
FROM public.qc_quality_inspection h
LEFT JOIN public.qc_job_assignment ja
  ON ja.job_assignment_seq_no = h.source_job_assignment_seq
LEFT JOIN public.mfg_wo_vch w
  ON w.voucher_no = ja.work_order_no
LEFT JOIN public.qc_job_assignment_alloc a
  ON a.job_assignment_seq_no = ja.job_assignment_seq_no
 AND a.source_allocation_type = 'W'
 AND NULLIF(BTRIM(a.source_voucher_no), '') IS NOT NULL
LEFT JOIN LATERAL (
    SELECT w2.voucher_no, w2.inventory_code, w2.stage_desc, w2.stage_no,
           w2.execution_status, w2.origin_voucher_no, w2.segment_1_code,
           w2.wo_qty_required, w2.plan_start_date, w2.plan_end_date
    FROM public.mfg_wo_vch w2
    WHERE w.voucher_no IS NULL
      AND w2.source_mps_no = a.source_voucher_no
    ORDER BY w2.voucher_no
    LIMIT 1
) w_alloc ON TRUE
LEFT JOIN public.qc_job_assignment_lot jl
  ON jl.job_assignment_seq_no = ja.job_assignment_seq_no
LEFT JOIN (
    SELECT DISTINCT ON (wo_voucher_no, stage_no)
           wo_voucher_no, stage_no, source_pp_no
    FROM public.mfg_mps_vch
    WHERE NULLIF(BTRIM(wo_voucher_no), '') IS NOT NULL
    ORDER BY wo_voucher_no, stage_no, source_pp_no
) mps_by_wo
  ON mps_by_wo.wo_voucher_no = COALESCE(w.voucher_no, w_alloc.voucher_no)
 AND (
       COALESCE(w.stage_no, w_alloc.stage_no) IS NULL
    OR mps_by_wo.stage_no IS NOT DISTINCT FROM COALESCE(w.stage_no, w_alloc.stage_no)
 )
LEFT JOIN (
    SELECT DISTINCT ON (mps_voucher_no)
           mps_voucher_no, source_pp_no
    FROM public.mfg_mps_vch
    WHERE NULLIF(BTRIM(mps_voucher_no), '') IS NOT NULL
    ORDER BY mps_voucher_no, stage_no NULLS LAST, source_pp_no
) mps_by_no
  ON mps_by_wo.source_pp_no IS NULL
 AND mps_by_no.mps_voucher_no = COALESCE(
       NULLIF(BTRIM(COALESCE(w.source_mps_no, '')), ''),
       NULLIF(BTRIM(COALESCE(a.source_voucher_no, '')), '')
     )
WHERE h.type = 'M'
ORDER BY h.inspection_voucher_no ASC, jl.lot_seq_no ASC NULLS LAST, a.allocation_no ASC NULLS LAST
"""


def invalidate_qc_quality_queue_cache() -> None:
    global _cache
    _cache = None
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("qc_quality_queue:")


def _fetch_qc_quality_queue(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _cache
    now = time.time()
    if (
        not refresh
        and _cache
        and _cache[1] == _CACHE_VERSION
        and now - _cache[0] < _CACHE_TTL_SEC
    ):
        return _cache[2]

    rows = fetch_rows(_QC_QUALITY_QUEUE_SQL, domain="qc_quality_queue")
    _cache = (now, _CACHE_VERSION, rows)
    return rows


def _split_by_status(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    outstanding: list[dict[str, Any]] = []
    historical: list[dict[str, Any]] = []
    for row in rows:
        code = compact_text(row.get("status")).upper()
        if code == "H":
            historical.append(row)
        elif code == "O":
            outstanding.append(row)
    return {"outstanding": outstanding, "historical": historical}


@qc_quality_queue_bp.get("/api/qc-quality-queue")
def api_qc_quality_queue():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        rows = _fetch_qc_quality_queue(refresh=refresh)
    except Exception as exc:
        logger.exception("qc quality queue ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    buckets = _split_by_status(rows)
    cached_at = _cache[0] if _cache else time.time()

    return jsonify(
        {
            "ok": True,
            "count": len(rows),
            "outstanding_count": len(buckets["outstanding"]),
            "historical_count": len(buckets["historical"]),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "outstanding": buckets["outstanding"],
            "historical": buckets["historical"],
            "rows": rows,
        }
    )
