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
_CACHE_VERSION = 6
_cache: tuple[float, int, list[dict[str, Any]]] | None = None

# Link chain:
#   qc_quality_inspection.source_job_assignment_seq -> qc_job_assignment.job_assignment_seq_no
#   qc_job_assignment.work_order_no -> mfg_wo_vch.voucher_no
#   qc_job_assignment_alloc.source_voucher_no -> mfg_wo_vch.source_mps_no (when alloc exists)
#   mfg_mps_vch.wo_voucher_no + stage_no -> mfg_wo_vch; source_pp_no -> process sheet / PP
#   mfg_process_sheet_info_v1_view.pp_voucher_no -> process_sheet_no (when distinct from PP)
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
    w.voucher_no AS wo_voucher_no,
    w.source_mps_no AS mps_no,
    w.inventory_code AS wo_part_no,
    w.stage_desc AS wo_stage_desc,
    w.stage_no AS wo_stage_no,
    w.execution_status AS wo_execution_status,
    w.origin_voucher_no AS so_no,
    w.segment_1_code AS wo_segment_code,
    w.wo_qty_required,
    w.plan_start_date AS wo_plan_start_date,
    w.plan_end_date AS wo_plan_end_date,
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
    COALESCE(psi.process_sheet_no, mps.source_pp_no) AS process_sheet_no
FROM public.qc_quality_inspection h
LEFT JOIN public.qc_job_assignment ja
  ON ja.job_assignment_seq_no = h.source_job_assignment_seq
LEFT JOIN public.mfg_wo_vch w
  ON w.voucher_no = ja.work_order_no
LEFT JOIN public.qc_job_assignment_alloc a
  ON a.job_assignment_seq_no = ja.job_assignment_seq_no
 AND a.source_allocation_type = 'W'
 AND a.source_voucher_no IS NOT NULL
 AND BTRIM(a.source_voucher_no) <> ''
LEFT JOIN public.mfg_wo_vch w_alloc
  ON w_alloc.source_mps_no = a.source_voucher_no
LEFT JOIN public.qc_job_assignment_lot jl
  ON jl.job_assignment_seq_no = ja.job_assignment_seq_no
LEFT JOIN LATERAL (
    SELECT m.source_pp_no
    FROM public.mfg_mps_vch m
    WHERE (
            w.voucher_no IS NOT NULL
        AND m.wo_voucher_no = w.voucher_no
        AND (w.stage_no IS NULL OR m.stage_no = w.stage_no)
    ) OR (
            w.source_mps_no IS NOT NULL
        AND BTRIM(w.source_mps_no) <> ''
        AND m.voucher_no = w.source_mps_no
    ) OR (
            w_alloc.voucher_no IS NOT NULL
        AND m.wo_voucher_no = w_alloc.voucher_no
        AND (w_alloc.stage_no IS NULL OR m.stage_no = w_alloc.stage_no)
    ) OR (
            a.source_voucher_no IS NOT NULL
        AND BTRIM(a.source_voucher_no) <> ''
        AND m.voucher_no = a.source_voucher_no
    )
    ORDER BY
      CASE
        WHEN w.voucher_no IS NOT NULL
         AND m.wo_voucher_no = w.voucher_no
         AND m.stage_no IS NOT DISTINCT FROM w.stage_no THEN 0
        WHEN w.source_mps_no IS NOT NULL
         AND m.voucher_no = w.source_mps_no THEN 1
        WHEN w_alloc.voucher_no IS NOT NULL
         AND m.wo_voucher_no = w_alloc.voucher_no THEN 2
        ELSE 3
      END,
      m.stage_no NULLS LAST
    LIMIT 1
) mps ON TRUE
LEFT JOIN LATERAL (
    SELECT p.process_sheet_no
    FROM public.mfg_process_sheet_info_v1_view p
    WHERE mps.source_pp_no IS NOT NULL
      AND BTRIM(mps.source_pp_no) <> ''
      AND (
           p.pp_voucher_no = mps.source_pp_no
        OR p.process_sheet_no = mps.source_pp_no
      )
    ORDER BY p.process_sheet_no
    LIMIT 1
) psi ON TRUE
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
