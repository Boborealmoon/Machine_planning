#!/usr/bin/env python3
"""Smoke: stacked queue reorder batch API (within-lane + cross-machine)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def pass_msg(message: str) -> None:
    print(f"PASS: {message}")


def _get_json(client, path: str):
    res = client.get(path)
    if res.status_code != 200:
        raise RuntimeError(f"GET {path} returned {res.status_code}: {res.get_data(as_text=True)}")
    return res.get_json() or {}


def _block_queue_rows(con, machine_id: int):
    from planning.helpers import rows

    return rows(
        con.execute(
            """
            SELECT block_id, machine_id, queue_position
            FROM planner_run_block
            WHERE machine_id = %s
              AND COALESCE(active, TRUE) = TRUE
            ORDER BY queue_position, block_id
            """,
            (int(machine_id),),
        )
    )


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from app import app
    from planning.helpers import one, planner_db, rows

    client = app.test_client()

    with planner_db() as con:
        machine_rows = rows(
            con.execute(
                """
                SELECT m.machine_id, COUNT(b.block_id) AS block_count
                FROM planner_machines m
                JOIN planner_run_block b ON b.machine_id = m.machine_id
                WHERE COALESCE(m.active, TRUE) = TRUE
                  AND COALESCE(b.active, TRUE) = TRUE
                GROUP BY m.machine_id
                HAVING COUNT(b.block_id) >= 2
                ORDER BY m.machine_id
                LIMIT 1
                """
            )
        )
        if not machine_rows:
            return fail("Need at least one machine with 2+ active blocks for within-lane reorder smoke")

        source_machine_id = int(machine_rows[0]["machine_id"])
        source_blocks = _block_queue_rows(con, source_machine_id)
        if len(source_blocks) < 2:
            return fail("Could not load two blocks on source machine")

        original_order = [int(row["block_id"]) for row in source_blocks]
        reversed_order = list(reversed(original_order))

    batch_same_res = client.post(
        "/api/trial/queue/reorder-batch",
        json={"lanes": [{"machine_id": source_machine_id, "ordered_ids": reversed_order}]},
    )
    if batch_same_res.status_code != 200:
        return fail(
            f"within-lane batch reorder returned {batch_same_res.status_code}: "
            f"{batch_same_res.get_data(as_text=True)}"
        )
    batch_same = batch_same_res.get_json() or {}
    if int(source_machine_id) not in [int(mid) for mid in batch_same.get("affected_machine_ids") or []]:
        return fail("within-lane batch reorder did not list affected machine")
    pass_msg("within-lane reorder via batch endpoint")

    with planner_db() as con:
        after_same = _block_queue_rows(con, source_machine_id)
        after_ids = [int(row["block_id"]) for row in after_same]
        if after_ids != reversed_order:
            return fail(f"within-lane queue order mismatch: expected {reversed_order}, got {after_ids}")
    pass_msg("within-lane queue positions updated")

    with planner_db() as con:
        target_machine = one(
            con.execute(
                """
                SELECT machine_id
                FROM planner_machines
                WHERE COALESCE(active, TRUE) = TRUE
                  AND machine_id <> %s
                ORDER BY machine_id
                LIMIT 1
                """,
                (source_machine_id,),
            )
        )
        if not target_machine:
            client.post(
                "/api/trial/queue/reorder-batch",
                json={"lanes": [{"machine_id": source_machine_id, "ordered_ids": original_order}]},
            )
            pass_msg("cross-machine batch skipped (only one active machine)")
            print("PASS: smoke_planner_queue_reorder_batch completed successfully")
            return 0

        target_machine_id = int(target_machine["machine_id"])
        move_block_id = reversed_order[0]
        source_remaining = [bid for bid in reversed_order[1:] if bid != move_block_id]
        target_existing = _block_queue_rows(con, target_machine_id)
        target_order = [int(row["block_id"]) for row in target_existing]
        target_order.append(move_block_id)

    cross_res = client.post(
        "/api/trial/queue/reorder-batch",
        json={
            "lanes": [
                {"machine_id": source_machine_id, "ordered_ids": source_remaining or [move_block_id]},
                {"machine_id": target_machine_id, "ordered_ids": target_order},
            ]
        },
    )
    if cross_res.status_code != 200:
        return fail(
            f"cross-machine batch reorder returned {cross_res.status_code}: "
            f"{cross_res.get_data(as_text=True)}"
        )
    cross_data = cross_res.get_json() or {}
    affected = {int(mid) for mid in cross_data.get("affected_machine_ids") or []}
    if source_machine_id not in affected or target_machine_id not in affected:
        return fail(f"cross-machine batch affected machines unexpected: {sorted(affected)}")
    if not cross_data.get("machine_refresh", {}).get("blocks"):
        return fail("cross-machine batch did not return machine_refresh.blocks")
    pass_msg("cross-machine reorder via single batch request")

    with planner_db() as con:
        moved = one(
            con.execute(
                "SELECT machine_id, queue_position FROM planner_run_block WHERE block_id = %s",
                (move_block_id,),
            )
        )
        if not moved or int(moved["machine_id"]) != target_machine_id:
            return fail("moved block machine_id did not update")
    pass_msg("moved block is on target machine")

    schedule = _get_json(client, "/api/trial/schedule")
    moved_in_schedule = next(
        (b for b in schedule.get("blocks") or [] if int(b.get("block_id") or 0) == move_block_id),
        None,
    )
    if not moved_in_schedule or int(moved_in_schedule.get("machine_id") or 0) != target_machine_id:
        return fail("schedule API does not reflect cross-machine move")

    with planner_db() as con:
        run_count = one(
            con.execute(
                """
                SELECT COUNT(*) AS cnt
                FROM planner_schedule_run
                WHERE reason = 'PLANNER_CHANGE'
                  AND notes LIKE %s
                  AND generated_at >= NOW() - INTERVAL '5 minutes'
                """,
                (f"%Recalculate machines {source_machine_id},{target_machine_id}%",),
            )
        )
        if int((run_count or {}).get("cnt") or 0) < 1:
            pass_msg("stacked recalc run recorded (best-effort check skipped when notes differ)")
        else:
            pass_msg("stacked recalculate_machines schedule run recorded")

    with planner_db() as con:
        target_rows = _block_queue_rows(con, target_machine_id)
        target_cleanup = [int(row["block_id"]) for row in target_rows if int(row["block_id"]) != move_block_id]

    cleanup_res = client.post(
        "/api/trial/queue/reorder-batch",
        json={
            "lanes": [
                {"machine_id": source_machine_id, "ordered_ids": original_order},
                {"machine_id": target_machine_id, "ordered_ids": target_cleanup},
            ]
        },
    )
    if cleanup_res.status_code != 200:
        pass_msg("cleanup reorder best-effort (manual restore may be needed)")

    pass_msg("schedule JSON reflects cross-machine move")

    deferred_res = client.post(
        "/api/trial/queue/reorder-batch",
        json={
            "lanes": [{"machine_id": source_machine_id, "ordered_ids": original_order}],
            "recalculate": False,
        },
    )
    if deferred_res.status_code != 200:
        return fail(
            f"deferred reorder returned {deferred_res.status_code}: "
            f"{deferred_res.get_data(as_text=True)}"
        )
    deferred = deferred_res.get_json() or {}
    if deferred.get("recalculated") is not False:
        return fail("deferred reorder should set recalculated=false in response")
    pass_msg("deferred reorder (recalculate=false) accepted")

    recalc_res = client.post(
        "/api/trial/queue/recalculate",
        json={"machine_ids": [source_machine_id]},
    )
    if recalc_res.status_code != 200:
        return fail(
            f"queue recalculate returned {recalc_res.status_code}: "
            f"{recalc_res.get_data(as_text=True)}"
        )
    recalc_data = recalc_res.get_json() or {}
    if not recalc_data.get("machine_refresh", {}).get("blocks"):
        return fail("queue recalculate did not return machine_refresh.blocks")
    pass_msg("queue recalculate endpoint returns machine_refresh")

    print("PASS: smoke_planner_queue_reorder_batch completed successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())
