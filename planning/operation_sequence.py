"""Machine-lane queue sequence: planner_operation_sequence sync helpers."""
from __future__ import annotations

from .helpers import one, rows


def _planning_card_schedule_columns(con):
    """Return optional schedule mirror columns present on planner_planning_card."""
    found = rows(
        con.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'planner_planning_card'
              AND column_name = ANY(%s)
            """,
            (["operation_sequence_id", "machine_queue_index"],),
        )
    )
    return {row["column_name"] for row in found}


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


def sync_planning_cards_for_machine(con, machine_id):
    """Mirror the current machine-lane order onto planning-card rows."""
    machine_id = int(machine_id)
    if machine_id <= 0:
        return []

    schedule_columns = _planning_card_schedule_columns(con)
    card_rows = rows(
        con.execute(
            """
            SELECT pc.card_id, b.group_id, os.operation_sequence_id, os.sequence_no, b.queue_position, b.block_id
            FROM planner_planning_card pc
            JOIN planner_planning_card_operation pco ON pco.card_id = pc.card_id
            JOIN planner_operation o
              ON o.source_ps_id = pco.source_ps_id
             AND COALESCE(o.source_op_no, '') = COALESCE(pco.source_op_no, '')
             AND COALESCE(o.source_op_seq_id, 0) = COALESCE(pco.source_op_seq_id, 0)
            JOIN planner_run_block b ON b.operation_id = o.operation_id
            LEFT JOIN planner_operation_sequence os ON os.block_id = b.block_id
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
            ORDER BY pc.card_id, COALESCE(os.sequence_no, b.queue_position), b.block_id
            """,
            (machine_id,),
        )
    )

    cards = {}
    for row in card_rows:
        card_id = int(row["card_id"])
        cards.setdefault(
            card_id,
            {
                "card_id": card_id,
                "group_id": int(row["group_id"] or 0),
                "operation_sequence_id": int(row["operation_sequence_id"] or 0),
                "machine_queue_index": int(row["sequence_no"] or row["queue_position"] or 0),
            },
        )
        if row["group_id"] and not cards[card_id]["group_id"]:
            cards[card_id]["group_id"] = int(row["group_id"])

    synced = []
    for card in cards.values():
        set_parts = [
            "planning_status = 'SCHEDULED'",
            "machine_id = %s",
            "updated_at = NOW()",
        ]
        values = [machine_id]
        if card["group_id"]:
            set_parts.append("scheduled_block_group_id = %s")
            values.append(card["group_id"])
        if "operation_sequence_id" in schedule_columns:
            set_parts.append("operation_sequence_id = %s")
            values.append(card["operation_sequence_id"] or None)
        if "machine_queue_index" in schedule_columns:
            set_parts.append("machine_queue_index = %s")
            values.append(card["machine_queue_index"] or None)
        values.append(card["card_id"])

        con.execute(
            f"""
            UPDATE planner_planning_card
            SET {", ".join(set_parts)}
            WHERE card_id = %s
            """,
            values,
        )
        synced.append(card)
    return synced


def sync_planning_cards_for_machines(con, machine_ids):
    synced = {}
    for machine_id in sorted({int(mid) for mid in machine_ids if int(mid or 0) > 0}):
        for card in sync_planning_cards_for_machine(con, machine_id):
            synced[int(card["card_id"])] = card
    return synced


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


def compact_machine_lane_queue(con, machine_id, *, recalculate=False):
    """Renumber active blocks on a lane to 1..n in current queue order."""
    machine_id = int(machine_id)
    if machine_id <= 0:
        return {"affected_machine_ids": [], "sequences": {}}
    ordered_ids = [
        int(row["block_id"])
        for row in rows(
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
    ]
    if not ordered_ids:
        return {"affected_machine_ids": [], "sequences": {}}
    return apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=recalculate)


def compact_machine_lanes_with_gaps(con, machine_ids=None, *, recalculate=False):
    """Renumber lanes where queue_position leaves gaps (e.g. after auto-unschedule)."""
    params = []
    machine_clause = ""
    mids = sorted({int(mid) for mid in (machine_ids or []) if int(mid or 0) > 0})
    if mids:
        machine_clause = " AND machine_id = ANY(%s)"
        params.append(mids)
    gap_rows = rows(
        con.execute(
            f"""
            SELECT machine_id
            FROM planner_run_block
            WHERE COALESCE(active, TRUE) = TRUE
              AND machine_id IS NOT NULL
              {machine_clause}
            GROUP BY machine_id
            HAVING COALESCE(MAX(queue_position), 0) > COUNT(*)
            """,
            tuple(params),
        )
    )
    for row in gap_rows:
        compact_machine_lane_queue(con, int(row["machine_id"]), recalculate=recalculate)
    return [int(row["machine_id"]) for row in gap_rows]


def tail_recalc_start_index(existing_ids, ordered_ids):
    """
    First block index where the lane order diverges. Equal length + identical => no work.
    Prefix unchanged => only reschedule from the first changed slot (tail recalc).
    """
    existing_ids = [int(value) for value in (existing_ids or []) if int(value or 0) > 0]
    ordered_ids = [int(value) for value in (ordered_ids or []) if int(value or 0) > 0]
    if not ordered_ids:
        return 0
    prefix = 0
    for idx in range(min(len(existing_ids), len(ordered_ids))):
        if ordered_ids[idx] == existing_ids[idx]:
            prefix = idx + 1
        else:
            break
    if prefix >= len(ordered_ids) and len(ordered_ids) == len(existing_ids):
        return len(ordered_ids)
    return prefix


def apply_machine_queue_order(con, machine_id, ordered_ids, *, recalculate=True):
    """
    Set queue_position (and machine) for ordered block ids on a lane, sync operation
    sequences, optionally recalculate affected machines.
    """
    machine_id = int(machine_id)
    ordered_ids = [int(value) for value in ordered_ids if int(value or 0) > 0]
    if not ordered_ids:
        return {"affected_machine_ids": [], "sequences": {}}

    existing_lane_ids = [
        int(row["block_id"])
        for row in rows(
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
    ]
    tail_start_index = tail_recalc_start_index(existing_lane_ids, ordered_ids)
    tail_from_block_id = ordered_ids[tail_start_index] if tail_start_index < len(ordered_ids) else None

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
    sync_planning_cards_for_machines(con, affected_machine_ids)

    if recalculate:
        from .blocks import recalculate_machines
        from .scheduler_state import refresh_states_for_machine

        if tail_start_index < len(ordered_ids):
            tail_by_machine = {}
            if tail_from_block_id:
                tail_by_machine[int(machine_id)] = int(tail_from_block_id)
            recalculate_machines(con, sorted(affected_machine_ids), tail_by_machine=tail_by_machine)
        else:
            for affected_id in sorted(affected_machine_ids):
                sync_machine_operation_sequence(con, int(affected_id))
                refresh_states_for_machine(con, int(affected_id))

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


def apply_machine_queue_orders(con, lane_orders, *, recalculate=True):
    """
    Apply queue order for one or more lanes, then recalculate affected machines once.
    lane_orders: [{"machine_id": int, "ordered_ids": [int, ...]}, ...]
    """
    all_affected = set()
    merged_sequences = {}
    tail_by_machine = {}

    for entry in lane_orders or []:
        machine_id = int(entry.get("machine_id") or 0)
        ordered_ids = [int(value) for value in (entry.get("ordered_ids") or []) if int(value or 0) > 0]
        if not machine_id or not ordered_ids:
            continue
        existing_lane_ids = [
            int(row["block_id"])
            for row in rows(
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
        ]
        tail_start_index = tail_recalc_start_index(existing_lane_ids, ordered_ids)
        if tail_start_index < len(ordered_ids):
            tail_by_machine[machine_id] = int(ordered_ids[tail_start_index])
        result = apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=False)
        all_affected.update(result.get("affected_machine_ids") or [])
        merged_sequences.update(result.get("sequences") or {})

    if recalculate and all_affected:
        from .blocks import recalculate_machines

        recalculate_machines(con, sorted(all_affected), tail_by_machine=tail_by_machine)

    return {
        "affected_machine_ids": sorted(all_affected),
        "sequences": merged_sequences,
    }
