"""planning/actuals.py — production actual helpers (PostgreSQL port of Vanessa's actuals.py).

Table changes vs SQLite original:
  production_actual → planner_production_actual
  run_block         → planner_run_block
"""
from __future__ import annotations

from .helpers import one, rows

_EMPTY_TOTALS = {
    "output_qty": 0.0,
    "reject_qty": 0.0,
    "good_qty": 0.0,
    "output_reports": 0,
    "reject_reports": 0,
}


def _totals_from_row(row):
    if not row:
        return dict(_EMPTY_TOTALS)
    return {
        "output_qty": float(row["output_qty"] or 0),
        "reject_qty": float(row["reject_qty"] or 0),
        "good_qty": float(row["good_qty"] or 0),
        "output_reports": int(row["output_reports"] or 0),
        "reject_reports": int(row["reject_reports"] or 0),
    }


def actual_totals_for_block(con, block_id):
    return actual_totals_for_block_ids(con, [int(block_id)]).get(int(block_id), dict(_EMPTY_TOTALS))


def operation_split_siblings(con, block_row):
    """Active run blocks for the same operation, in queue order."""
    operation_id = int((block_row or {}).get("operation_id") or 0)
    if not con or not operation_id:
        block_id = int((block_row or {}).get("block_id") or 0)
        return [{"block_id": block_id, "scheduled_qty": float((block_row or {}).get("scheduled_qty") or 0)}] if block_id else []
    return rows(
        con.execute(
            """
            SELECT block_id, scheduled_qty, queue_position, split_from_block_id
            FROM planner_run_block
            WHERE operation_id = %s
              AND COALESCE(active, TRUE) = TRUE
            ORDER BY queue_position, block_id
            """,
            (operation_id,),
        )
    )


def allocate_qty_across_operation_splits(con, block_row, total_qty):
    """Spread operation-level output across split queue blocks (first pieces absorb done qty)."""
    total = max(0.0, float(total_qty or 0))
    block_id = int((block_row or {}).get("block_id") or 0)
    siblings = operation_split_siblings(con, block_row)
    if len(siblings) <= 1:
        scheduled_qty = max(0.0, float((block_row or {}).get("scheduled_qty") or 0))
        return min(total, scheduled_qty) if scheduled_qty > 0 else total

    remaining = total
    for sibling in siblings:
        scheduled_qty = max(0.0, float(sibling.get("scheduled_qty") or 0))
        allocated = min(scheduled_qty, remaining)
        if int(sibling.get("block_id") or 0) == block_id:
            return allocated
        remaining -= allocated
    return 0.0


def actual_totals_for_block_ids(con, block_ids):
    ids = sorted({int(block_id) for block_id in (block_ids or []) if int(block_id) > 0})
    if not con or not ids:
        return {}
    totals = {block_id: dict(_EMPTY_TOTALS) for block_id in ids}
    for row in rows(
        con.execute(
            """
            SELECT block_id,
              COALESCE(SUM(COALESCE(output_qty, 0)), 0) AS output_qty,
              COALESCE(SUM(COALESCE(reject_qty, 0)), 0) AS reject_qty,
              COALESCE(SUM(COALESCE(output_qty, 0) - COALESCE(reject_qty, 0)), 0) AS good_qty,
              SUM(CASE WHEN output_qty IS NOT NULL THEN 1 ELSE 0 END) AS output_reports,
              SUM(CASE WHEN reject_qty IS NOT NULL THEN 1 ELSE 0 END) AS reject_reports
            FROM planner_production_actual
            WHERE block_id = ANY(%s)
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            GROUP BY block_id
            """,
            (ids,),
        )
    ):
        totals[int(row.get("block_id") or 0)] = _totals_from_row(row)
    return totals


def refresh_block_actual_status(con, block_id, *, auto_unschedule: bool = True):
    block = one(
        con.execute(
            "SELECT * FROM planner_run_block WHERE block_id = %s",
            (int(block_id),),
        )
    )
    if not block:
        return

    totals = actual_totals_for_block(con, block_id)
    good_qty = totals["good_qty"]
    reject_qty = totals["reject_qty"]
    scheduled_qty = float(block["scheduled_qty"] or 0)

    if totals["output_reports"] <= 0 and totals["reject_reports"] <= 0:
        status = "NOT_STARTED"
    elif good_qty >= scheduled_qty and scheduled_qty > 0:
        status = "DONE"
    else:
        status = "IN_PROGRESS"

    con.execute(
        """
        UPDATE planner_run_block
        SET actual_good_qty = %s, actual_reject_qty = %s,
            execution_status = %s, status = %s, updated_at = NOW()
        WHERE block_id = %s
        """,
        (good_qty, reject_qty, status, status, int(block_id)),
    )
    if auto_unschedule and status == "DONE":
        from .auto_unschedule import maybe_auto_unschedule_block

        maybe_auto_unschedule_block(con, int(block_id))
