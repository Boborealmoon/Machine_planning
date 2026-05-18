"""Machine-lane queue sequence: planner_operation_sequence sync helpers."""
from __future__ import annotations

from .helpers import one, rows


def sync_machine_operation_sequence(con, machine_id):
    """Rebuild sequence rows for one machine from planner_run_block.queue_position."""
    machine_id = int(machine_id)
    block_rows = rows(
        con.execute(
            """
            SELECT block_id
            FROM planner_run_block
            WHERE machine_id = %s
              AND COALESCE(active, TRUE) = TRUE
            ORDER BY queue_position, block_id
            """,
            (machine_id,),
        )
    )
    active_block_ids = [int(row["block_id"]) for row in block_rows]

    if active_block_ids:
        con.execute(
            """
            DELETE FROM planner_operation_sequence
            WHERE machine_id = %s
              AND NOT (block_id = ANY(%s))
            """,
            (machine_id, active_block_ids),
        )
    else:
        con.execute(
            "DELETE FROM planner_operation_sequence WHERE machine_id = %s",
            (machine_id,),
        )
        return []

    result = []
    for sequence_no, block_id in enumerate(active_block_ids, 1):
        row = one(
            con.execute(
                """
                INSERT INTO planner_operation_sequence (
                  machine_id, block_id, sequence_no, created_at, updated_at
                ) VALUES (%s, %s, %s, NOW(), NOW())
                ON CONFLICT (block_id) DO UPDATE SET
                  machine_id = EXCLUDED.machine_id,
                  sequence_no = EXCLUDED.sequence_no,
                  updated_at = NOW()
                RETURNING operation_sequence_id, block_id, machine_id, sequence_no
                """,
                (machine_id, block_id, sequence_no),
            )
        )
        operation_sequence_id = int(row["operation_sequence_id"])
        con.execute(
            """
            UPDATE planner_run_block
            SET operation_sequence_id = %s, updated_at = NOW()
            WHERE block_id = %s
            """,
            (operation_sequence_id, block_id),
        )
        result.append(dict(row))
    return result


def sync_operation_sequences_for_machines(con, machine_ids):
    """Sync planner_operation_sequence for each machine id; return block_id -> row map."""
    merged = {}
    for machine_id in sorted({int(mid) for mid in machine_ids if int(mid or 0) > 0}):
        for row in sync_machine_operation_sequence(con, machine_id):
            merged[int(row["block_id"])] = dict(row)
    return merged


def update_planning_card_machine_for_block(con, block_id, machine_id):
    """Keep planning_card.machine_id aligned when a block moves lanes."""
    con.execute(
        """
        UPDATE planner_planning_card pc
        SET machine_id = %s, updated_at = NOW()
        WHERE pc.card_id IN (
            SELECT pco.card_id
            FROM planner_planning_card_operation pco
            JOIN planner_operation o
              ON o.source_ps_id = pco.source_ps_id
             AND COALESCE(o.source_op_no, '') = COALESCE(pco.source_op_no, '')
             AND COALESCE(o.source_op_seq_id, 0) = COALESCE(pco.source_op_seq_id, 0)
            JOIN planner_run_block b ON b.operation_id = o.operation_id
            WHERE b.block_id = %s
        )
        """,
        (int(machine_id), int(block_id)),
    )


def apply_machine_queue_order(con, machine_id, ordered_ids, *, recalculate=True):
    """
    Set queue_position (and machine) for ordered block ids on a lane, sync operation
    sequences, optionally recalculate affected machines.
    """
    machine_id = int(machine_id)
    ordered_ids = [int(value) for value in ordered_ids if int(value or 0) > 0]
    if not ordered_ids:
        return {"affected_machine_ids": [], "sequences": {}}

    existing_blocks = rows(
        con.execute(
            "SELECT block_id, machine_id FROM planner_run_block WHERE block_id = ANY(%s)",
            (ordered_ids,),
        )
    )
    affected_machine_ids = {machine_id}
    affected_machine_ids.update(int(row["machine_id"]) for row in existing_blocks)

    for idx, block_id in enumerate(ordered_ids, 1):
        con.execute(
            """
            UPDATE planner_run_block
            SET machine_id = %s, queue_position = %s, updated_at = NOW()
            WHERE block_id = %s
            """,
            (machine_id, float(idx), block_id),
        )
        update_planning_card_machine_for_block(con, block_id, machine_id)

    sequence_map = sync_operation_sequences_for_machines(con, affected_machine_ids)

    if recalculate:
        from .blocks import recalculate_machine

        for affected_id in sorted(affected_machine_ids):
            recalculate_machine(con, affected_id)

    return {
        "affected_machine_ids": sorted(affected_machine_ids),
        "sequences": {
            str(block_id): {
                "operation_sequence_id": int(row["operation_sequence_id"]),
                "sequence_no": int(row["sequence_no"]),
                "machine_id": int(row["machine_id"]),
            }
            for block_id, row in sequence_map.items()
        },
    }
