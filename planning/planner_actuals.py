"""planning/planner_actuals.py — actual start/end summaries for planner blocks (PostgreSQL)."""
from __future__ import annotations

from .helpers import parse_dt_text, rows
from .utils import compact_text


def _active_actual_rows_for_block(con, block_id):
    return rows(
        con.execute(
            """
            SELECT a.actual_id, a.segment_id, a.block_id, a.output_qty, a.reject_qty,
                   a.reported_at, a.status,
                   COALESCE(a.report_date::text, s.start_datetime::text, a.reported_at::text, '') AS actual_start_at,
                   COALESCE(a.report_date::text, s.end_datetime::text, a.reported_at::text, '') AS actual_end_at
            FROM planner_production_actual a
            LEFT JOIN planner_run_block_segment s ON s.segment_id = a.segment_id
            WHERE a.block_id = %s
              AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
              AND (a.output_qty IS NOT NULL OR a.reject_qty IS NOT NULL)
            ORDER BY COALESCE(a.report_date, s.start_datetime::date, a.reported_at::date) ASC,
                     COALESCE(a.report_date, s.end_datetime::date, a.reported_at::date) ASC,
                     a.actual_id ASC
            """,
            (int(block_id),),
        )
    )


def actual_summary_for_block_row(con, block_row, planned_qty=None):
    if not block_row:
        return {
            "actual_start_at": "",
            "actual_end_at": "",
            "actual_good_qty": 0.0,
            "actual_row_count": 0,
            "planned_qty": float(planned_qty or 0),
        }

    block_id = int(block_row["block_id"])
    planned_qty_value = planned_qty
    if planned_qty_value is None:
        planned_qty_value = block_row.get("planned_qty")
        if planned_qty_value in (None, ""):
            planned_qty_value = block_row.get("scheduled_qty")
    planned_qty_value = max(0.0, float(planned_qty_value or 0))

    actual_rows = _active_actual_rows_for_block(con, block_id)
    if not actual_rows:
        return {
            "actual_start_at": "",
            "actual_end_at": "",
            "actual_good_qty": 0.0,
            "actual_row_count": 0,
            "planned_qty": planned_qty_value,
        }

    actual_start_at = ""
    actual_end_at = ""
    cumulative_good_qty = 0.0
    actual_row_count = 0
    for row in actual_rows:
        start_text = compact_text(row["actual_start_at"] or row["reported_at"] or "")
        end_text = compact_text(row["actual_end_at"] or row["reported_at"] or "")
        start_dt = parse_dt_text(start_text)
        end_dt = parse_dt_text(end_text)
        good_qty = max(0.0, float(row["output_qty"] or 0) - float(row["reject_qty"] or 0))
        if good_qty <= 0 and not start_dt and not end_dt:
            continue
        actual_row_count += 1
        if not actual_start_at:
            actual_start_at = start_dt.strftime("%Y-%m-%d %H:%M:%S") if start_dt else start_text
        cumulative_good_qty += good_qty
        if not actual_end_at and planned_qty_value > 0 and cumulative_good_qty + 1e-9 >= planned_qty_value:
            chosen_dt = end_dt or start_dt
            actual_end_at = chosen_dt.strftime("%Y-%m-%d %H:%M:%S") if chosen_dt else end_text

    return {
        "actual_start_at": actual_start_at,
        "actual_end_at": actual_end_at,
        "actual_good_qty": cumulative_good_qty,
        "actual_row_count": actual_row_count,
        "planned_qty": planned_qty_value,
    }


def actual_summaries_for_block_rows(con, block_rows, planned_qty_by_block=None):
    block_rows = [row for row in block_rows if row]
    if not block_rows:
        return {}

    planned_qty_by_block = planned_qty_by_block or {}
    block_ids = [int(row["block_id"]) for row in block_rows if row.get("block_id") is not None]
    if not block_ids:
        return {}

    actual_rows = rows(
        con.execute(
            """
            SELECT a.actual_id, a.segment_id, a.block_id, a.output_qty, a.reject_qty,
                   a.reported_at, a.status,
                   COALESCE(a.report_date::text, s.start_datetime::text, a.reported_at::text, '') AS actual_start_at,
                   COALESCE(a.report_date::text, s.end_datetime::text, a.reported_at::text, '') AS actual_end_at
            FROM planner_production_actual a
            LEFT JOIN planner_run_block_segment s ON s.segment_id = a.segment_id
            WHERE a.block_id = ANY(%s)
              AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
              AND (a.output_qty IS NOT NULL OR a.reject_qty IS NOT NULL)
            ORDER BY a.block_id,
                     COALESCE(a.report_date, s.start_datetime::date, a.reported_at::date) ASC,
                     COALESCE(a.report_date, s.end_datetime::date, a.reported_at::date) ASC,
                     a.actual_id ASC
            """,
            (block_ids,),
        )
    )

    actual_rows_by_block = {}
    for row in actual_rows:
        block_id = int(row["block_id"] or 0)
        actual_rows_by_block.setdefault(block_id, []).append(row)

    summaries = {}
    for block_row in block_rows:
        block_id = int(block_row["block_id"])
        planned_qty_value = planned_qty_by_block.get(block_id)
        if planned_qty_value is None:
            planned_qty_value = block_row.get("planned_qty")
            if planned_qty_value in (None, ""):
                planned_qty_value = block_row.get("scheduled_qty")
        planned_qty_value = max(0.0, float(planned_qty_value or 0))
        rows_for_block = actual_rows_by_block.get(block_id, [])
        if not rows_for_block:
            summaries[block_id] = {
                "actual_start_at": "",
                "actual_end_at": "",
                "actual_good_qty": 0.0,
                "actual_row_count": 0,
                "planned_qty": planned_qty_value,
            }
            continue

        actual_start_at = ""
        actual_end_at = ""
        cumulative_good_qty = 0.0
        actual_row_count = 0
        for row in rows_for_block:
            start_text = compact_text(row["actual_start_at"] or row["reported_at"] or "")
            end_text = compact_text(row["actual_end_at"] or row["reported_at"] or "")
            start_dt = parse_dt_text(start_text)
            end_dt = parse_dt_text(end_text)
            good_qty = max(0.0, float(row["output_qty"] or 0) - float(row["reject_qty"] or 0))
            if good_qty <= 0 and not start_dt and not end_dt:
                continue
            actual_row_count += 1
            if not actual_start_at:
                actual_start_at = start_dt.strftime("%Y-%m-%d %H:%M:%S") if start_dt else start_text
            cumulative_good_qty += good_qty
            if not actual_end_at and planned_qty_value > 0 and cumulative_good_qty + 1e-9 >= planned_qty_value:
                chosen_dt = end_dt or start_dt
                actual_end_at = chosen_dt.strftime("%Y-%m-%d %H:%M:%S") if chosen_dt else end_text

        summaries[block_id] = {
            "actual_start_at": actual_start_at,
            "actual_end_at": actual_end_at,
            "actual_good_qty": cumulative_good_qty,
            "actual_row_count": actual_row_count,
            "planned_qty": planned_qty_value,
        }

    return summaries
