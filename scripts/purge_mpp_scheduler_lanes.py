#!/usr/bin/env python3
"""Detach legacy MPP-planner blocks from main scheduler lanes (CNC 35/36/41).

The MPP planner tab stores cycles in planner_mpp_* tables. This script removes
any planner_run_block rows still linked from planner_mpp_cycle_op.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from planning.helpers import planner_db, rows
from planning.mpp_planner_queue_service import detach_mpp_planner_scheduler_blocks


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    with planner_db() as con:
        preview = rows(
            con.execute(
                """
                SELECT b.block_id, m.machine_no, o.source_ps_id, o.source_op_no, b.scheduled_qty
                FROM planner_run_block b
                JOIN planner_machines m ON m.machine_id = b.machine_id
                LEFT JOIN planner_operation o ON o.operation_id = b.operation_id
                JOIN planner_mpp_cycle_op co ON co.block_id = b.block_id
                WHERE COALESCE(co.block_id, 0) > 0
                  AND COALESCE(b.active, TRUE) = TRUE
                ORDER BY m.machine_no, b.queue_position, b.block_id
                """
            )
        )
        if not preview:
            print("Nothing to detach.")
            return 0
        print(f"MPP-linked scheduler blocks to detach: {len(preview)}")
        for row in preview:
            print(
                f"  block {row['block_id']} · {row['machine_no']} · "
                f"{row.get('source_ps_id')} OP{row.get('source_op_no')} · qty {row.get('scheduled_qty')}"
            )
        if dry_run:
            print("DRY RUN — no deletes")
            return 0
        removed = detach_mpp_planner_scheduler_blocks(con)
        print(f"Detached {len(removed)} block(s): {removed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
