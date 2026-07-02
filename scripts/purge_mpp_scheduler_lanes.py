#!/usr/bin/env python3
"""Remove legacy scheduler-queue blocks on MPP planner machines (CNC 35/36/41).

The MPP planner owns those lanes via planner_mpp_cycle / planner_mpp_cycle_op.
This script deletes active planner_run_block rows on those machines that are not
linked from planner_mpp_cycle_op.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from planning.helpers import planner_db, rows
from planning.machines import fetch_mpp_planner_machine_ids
from planning.mpp_planner_queue_service import purge_legacy_mpp_scheduler_blocks


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    with planner_db() as con:
        machine_ids = fetch_mpp_planner_machine_ids(con)
        print("MPP planner machines:", machine_ids)
        preview = rows(
            con.execute(
                """
                SELECT b.block_id, m.machine_no, o.source_ps_id, o.source_op_no, b.scheduled_qty
                FROM planner_run_block b
                JOIN planner_machines m ON m.machine_id = b.machine_id
                LEFT JOIN planner_operation o ON o.operation_id = b.operation_id
                WHERE b.machine_id = ANY(%s)
                  AND COALESCE(b.active, TRUE) = TRUE
                  AND NOT EXISTS (
                    SELECT 1
                    FROM planner_mpp_cycle_op co
                    WHERE co.block_id = b.block_id
                      AND COALESCE(co.block_id, 0) > 0
                  )
                ORDER BY m.machine_no, b.queue_position, b.block_id
                """,
                (machine_ids,),
            )
        )
        if not preview:
            print("Nothing to purge.")
            return 0
        print(f"Legacy blocks to remove: {len(preview)}")
        for row in preview:
            print(
                f"  block {row['block_id']} · {row['machine_no']} · "
                f"{row.get('source_ps_id')} OP{row.get('source_op_no')} · qty {row.get('scheduled_qty')}"
            )
        if dry_run:
            print("DRY RUN — no deletes")
            return 0
        removed = purge_legacy_mpp_scheduler_blocks(con)
        print(f"Removed {len(removed)} block(s): {removed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
