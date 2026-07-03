#!/usr/bin/env python3
"""Diagnose MPP planner queue consistency for CNC 35/36/41."""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from planning.helpers import one, planner_db, rows
    from planning.machines import fetch_mpp_planner_machine_ids
    from planning.mpp_planner_queue_service import load_mpp_planner_queue
    from planning.mpp_planner_service import fetch_mpp_planner_machines

    issues: list[str] = []

    with planner_db() as con:
        mpp_ids = fetch_mpp_planner_machine_ids(con)
        print("MPP machine IDs:", mpp_ids)
        machines = fetch_mpp_planner_machines(con)
        for m in machines:
            mid = int(m.get("machineId") or 0)
            blocks = rows(
                con.execute(
                    """
                    SELECT b.block_id, b.queue_position, b.group_id, g.group_type, g.group_label,
                           o.source_ps_id, o.source_op_no, b.scheduled_qty, b.planning_status
                    FROM planner_run_block b
                    LEFT JOIN planner_run_block_group g ON g.group_id = b.group_id
                    LEFT JOIN planner_operation o ON o.operation_id = b.operation_id
                    WHERE b.machine_id = %s AND COALESCE(b.active, TRUE) = TRUE
                    ORDER BY b.queue_position, b.block_id
                    """,
                    (mid,),
                )
            )
            cycles = rows(
                con.execute(
                    """
                    SELECT cycle_id, client_cycle_id, queue_index, shift, group_id
                    FROM planner_mpp_cycle
                    WHERE machine_id = %s
                    ORDER BY queue_index, cycle_id
                    """,
                    (mid,),
                )
            )
            print(f"\n=== {m['code']} (id={mid}, slug={m['id']}) ===")
            print(f"  MPP cycles in DB: {len(cycles)}")
            linked_block_ids: set[int] = set()
            for c in cycles:
                ops = rows(
                    con.execute(
                        """
                        SELECT cycle_op_id, client_op_id, block_id, job_id
                        FROM planner_mpp_cycle_op
                        WHERE cycle_id = %s
                        ORDER BY cycle_op_id
                        """,
                        (c["cycle_id"],),
                    )
                )
                print(
                    f"    cycle {c['client_cycle_id'][:24]}.. idx={c['queue_index']} "
                    f"ops={len(ops)} group={c['group_id']}"
                )
                for op in ops:
                    bid = int(op.get("block_id") or 0)
                    if bid > 0:
                        linked_block_ids.add(bid)
                    blk = (
                        one(
                            con.execute(
                                "SELECT queue_position, active FROM planner_run_block WHERE block_id = %s",
                                (bid,),
                            )
                        )
                        if bid
                        else None
                    )
                    print(
                        f"      op {str(op['job_id'])[:36]} block={bid} "
                        f"qp={blk and blk.get('queue_position')} active={blk and blk.get('active')}"
                    )
            print(f"  Scheduler blocks: {len(blocks)}")
            block_ids = {int(b["block_id"]) for b in blocks}
            orphan_blocks = block_ids - linked_block_ids
            missing_blocks = linked_block_ids - block_ids
            if orphan_blocks:
                msg = f"{m['code']}: orphan scheduler blocks {orphan_blocks}"
                issues.append(msg)
                print(f"  WARNING {msg}")
            if missing_blocks:
                msg = f"{m['code']}: linked blocks missing from scheduler {missing_blocks}"
                issues.append(msg)
                print(f"  WARNING {msg}")

            by_group: dict[int, list] = defaultdict(list)
            for b in blocks:
                by_group[int(b.get("group_id") or 0)].append(b)
            for gid, members in by_group.items():
                if len(members) > 1:
                    qps = [float(m["queue_position"]) for m in members]
                    if len(set(qps)) < len(qps):
                        print(
                            f"  NOTE group {gid} duplicate queue_positions: "
                            f"{[(m['block_id'], m['queue_position']) for m in members]}"
                        )

        print("\n--- load_mpp_planner_queue ---")
        q = load_mpp_planner_queue(con)
        for slug, lane in (q.get("machines") or {}).items():
            db_cycles = len(lane.get("cycles") or [])
            print(f"  {slug}: anchor={lane.get('laneAnchor')!r} cycles={db_cycles}")

    if issues:
        print(f"\nFAIL: {len(issues)} issue(s)")
        return 1
    print("\nPASS: no critical linkage issues detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
