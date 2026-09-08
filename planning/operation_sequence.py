"""Machine-lane queue sequence: planner_operation_sequence sync helpers."""
from __future__ import annotations

from .helpers import one, rows


def _main_planner_lane_clause(alias: str = "b") -> str:
    from .machines import scheduler_blocks_exclude_mpp_planner_clause

    return scheduler_blocks_exclude_mpp_planner_clause(alias)


def main_planner_lane_block_ids(con, machine_id):
    """Active lane blocks in queue order (MPP machines include mirrored MPP-tab cycles)."""
    machine_id = int(machine_id or 0)
    if machine_id <= 0:
        return []
    from .machines import is_mpp_planner_machine_id

    if is_mpp_planner_machine_id(con, machine_id):
        return [
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
    clause = _main_planner_lane_clause("b")
    return [
        int(row["block_id"])
        for row in rows(
            con.execute(
                f"""
                SELECT block_id
                FROM planner_run_block b
                WHERE b.machine_id = %s
                  AND COALESCE(b.active, TRUE) = TRUE
                  AND {clause}
                ORDER BY b.queue_position, b.block_id
                """,
                (machine_id,),
            )
        )
    ]


def main_planner_lane_max_queue_position(con, machine_id) -> float:
    machine_id = int(machine_id or 0)
    if machine_id <= 0:
        return 0.0
    from .machines import is_mpp_planner_machine_id

    if is_mpp_planner_machine_id(con, machine_id):
        row = one(
            con.execute(
                """
                SELECT COALESCE(MAX(queue_position), 0) AS mx
                FROM planner_run_block
                WHERE machine_id = %s
                  AND COALESCE(active, TRUE) = TRUE
                """,
                (machine_id,),
            )
        )
        return float((row or {}).get("mx") or 0)
    clause = _main_planner_lane_clause("b")
    row = one(
        con.execute(
            f"""
            SELECT COALESCE(MAX(b.queue_position), 0) AS mx
            FROM planner_run_block b
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
              AND {clause}
            """,
            (machine_id,),
        )
    )
    return float((row or {}).get("mx") or 0)


def compact_main_planner_lane_queue(con, machine_id, *, recalculate=False):
    """Renumber main-planner lane blocks to 1..n and sync operation sequences."""
    ordered_ids = main_planner_lane_block_ids(con, machine_id)
    if not ordered_ids:
        return {"affected_machine_ids": [], "sequences": {}}
    return apply_machine_queue_order(con, int(machine_id), ordered_ids, recalculate=recalculate)


_PLANNING_CARD_SCHEDULE_COLUMNS = None


def _planning_card_schedule_columns(con):
    """Return optional schedule mirror columns present on planner_planning_card."""
    global _PLANNING_CARD_SCHEDULE_COLUMNS
    if _PLANNING_CARD_SCHEDULE_COLUMNS is not None:
        return _PLANNING_CARD_SCHEDULE_COLUMNS
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
    _PLANNING_CARD_SCHEDULE_COLUMNS = {row["column_name"] for row in found}
    return _PLANNING_CARD_SCHEDULE_COLUMNS


def sync_machine_operation_sequence(con, machine_id):
    """Rebuild sequence rows for one machine from planner_run_block.queue_position."""
    machine_id = int(machine_id)
    active_block_ids = main_planner_lane_block_ids(con, machine_id)

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
    values = [(machine_id, int(block_id), sequence_no) for sequence_no, block_id in enumerate(active_block_ids, 1)]
    execute_values = getattr(con, "execute_values", None)
    if execute_values:
        execute_values(
            """
            INSERT INTO planner_operation_sequence (
              machine_id, block_id, sequence_no, created_at, updated_at
            ) VALUES %s
            ON CONFLICT (block_id) DO UPDATE SET
              machine_id = EXCLUDED.machine_id,
              sequence_no = EXCLUDED.sequence_no,
              updated_at = NOW()
            """,
            values,
            template="(%s, %s, %s, NOW(), NOW())",
        )
    else:
        for machine_id_value, block_id, sequence_no in values:
            con.execute(
                """
                INSERT INTO planner_operation_sequence (
                  machine_id, block_id, sequence_no, created_at, updated_at
                ) VALUES (%s, %s, %s, NOW(), NOW())
                ON CONFLICT (block_id) DO UPDATE SET
                  machine_id = EXCLUDED.machine_id,
                  sequence_no = EXCLUDED.sequence_no,
                  updated_at = NOW()
                """,
                (machine_id_value, block_id, sequence_no),
            )
    con.execute(
        """
        UPDATE planner_run_block b
        SET operation_sequence_id = s.operation_sequence_id,
            updated_at = NOW()
        FROM planner_operation_sequence s
        WHERE s.block_id = b.block_id
          AND s.machine_id = %s
          AND b.block_id = ANY(%s)
        """,
        (machine_id, active_block_ids),
    )
    for row in rows(
        con.execute(
            """
            SELECT operation_sequence_id, block_id, machine_id, sequence_no
            FROM planner_operation_sequence
            WHERE machine_id = %s
              AND block_id = ANY(%s)
            ORDER BY sequence_no, block_id
            """,
            (machine_id, active_block_ids),
        )
    ):
        result.append(dict(row))
    return result


def append_block_operation_sequence(con, machine_id, block_id):
    """Append one block to a lane without rebuilding every sequence row on the machine."""
    machine_id = int(machine_id)
    block_id = int(block_id)
    if machine_id <= 0 or block_id <= 0:
        return None
    ordered_ids = main_planner_lane_block_ids(con, machine_id)
    if block_id in ordered_ids:
        next_seq = ordered_ids.index(int(block_id)) + 1
    else:
        next_seq = len(ordered_ids) + 1
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
            (machine_id, block_id, next_seq),
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
    return dict(row)


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
    ordered_ids = main_planner_lane_block_ids(con, machine_id)
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
    lane_clause = _main_planner_lane_clause("b")
    gap_rows = rows(
        con.execute(
            f"""
            SELECT b.machine_id
            FROM planner_run_block b
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND b.machine_id IS NOT NULL
              AND {lane_clause}
              {machine_clause.replace("machine_id", "b.machine_id") if machine_clause else ""}
            GROUP BY b.machine_id
            HAVING COALESCE(MAX(b.queue_position), 0) > COUNT(*)
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


def lane_tail_recalc_block_after_remove(con, machine_id, removed_block_ids):
    """First surviving lane block that may need new schedule times after a removal."""
    machine_id = int(machine_id)
    removed = {int(bid) for bid in (removed_block_ids or []) if int(bid or 0) > 0}
    if machine_id <= 0 or not removed:
        return None
    ordered = rows(
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
    first_removed_idx = None
    for idx, row in enumerate(ordered):
        if int(row["block_id"]) in removed:
            first_removed_idx = idx
            break
    if first_removed_idx is None:
        return None
    for idx in range(first_removed_idx, len(ordered)):
        bid = int(ordered[idx]["block_id"])
        if bid not in removed:
            return bid
    return None


def resync_machine_lane_after_remove(con, machine_id, *, tail_block_id=None, recalculate=False):
    """Compact queue positions after a removal.

    Recalc is off by default so DELETE stays as fast as add/reorder. Schedule
    times stay stale until the client posts /api/trial/queue/recalculate.
    """
    from .blocks import recalculate_machine

    machine_id = int(machine_id)
    if machine_id <= 0:
        return {"tail_from_block_id": None, "recalculated": False}
    compact_result = compact_machine_lane_queue(con, machine_id, recalculate=False)
    tail = int(tail_block_id or 0) or compact_result.get("tail_from_block_id")
    did_recalc = False
    if recalculate and tail:
        recalculate_machine(
            con,
            machine_id,
            tail_from_block_id=int(tail),
            reason="QUEUE_DELETE",
        )
        did_recalc = True
    return {
        "tail_from_block_id": int(tail) if tail else None,
        "recalculated": did_recalc,
        "affected_machine_ids": compact_result.get("affected_machine_ids") or [],
    }


def infer_tail_by_machine(con, machine_ids):
    """
    Infer tail recalc start per machine by comparing current queue order to the order
    implied by persisted calculated_start_datetime (last schedule). Used when the client
    defers recalc after reordering.
    """
    tail_by_machine = {}
    clause = _main_planner_lane_clause("b")
    for machine_id in sorted({int(mid) for mid in (machine_ids or []) if int(mid or 0) > 0}):
        blocks = rows(
            con.execute(
                f"""
                SELECT block_id, queue_position, calculated_start_datetime
                FROM planner_run_block b
                WHERE b.machine_id = %s
                  AND COALESCE(b.active, TRUE) = TRUE
                  AND {clause}
                ORDER BY b.queue_position, b.block_id
                """,
                (int(machine_id),),
            )
        )
        if not blocks:
            continue
        queue_order = [int(row["block_id"]) for row in blocks]
        scheduled = [row for row in blocks if row.get("calculated_start_datetime")]
        if len(scheduled) < len(blocks):
            continue
        time_order = sorted(
            scheduled,
            key=lambda row: (
                row["calculated_start_datetime"],
                float(row["queue_position"] or 0),
                int(row["block_id"]),
            ),
        )
        time_order_ids = [int(row["block_id"]) for row in time_order]
        if time_order_ids == queue_order:
            continue
        tail_start = tail_recalc_start_index(time_order_ids, queue_order)
        if tail_start < len(queue_order):
            tail_by_machine[int(machine_id)] = int(queue_order[tail_start])
    return tail_by_machine


def apply_machine_queue_order(con, machine_id, ordered_ids, *, recalculate=True, allow_mpp_planner=False):
    """
    Set queue_position (and machine) for ordered block ids on a lane, sync operation
    sequences, optionally recalculate affected machines.

    recalculate=False persists lane order only. Schedule times stay stale until the
    caller posts /api/trial/queue/recalculate (or passes recalculate=True).
    """
    machine_id = int(machine_id)
    ordered_ids = [int(value) for value in ordered_ids if int(value or 0) > 0]
    if not ordered_ids:
        return {"affected_machine_ids": [], "sequences": {}}

    existing_lane_ids = main_planner_lane_block_ids(con, machine_id)
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
    moved_block_ids = [
        int(row["block_id"])
        for row in existing_blocks
        if int(row["machine_id"] or 0) != machine_id
    ]

    con.execute(
        """
        UPDATE planner_run_block AS b
        SET machine_id = %s,
            queue_position = v.pos,
            updated_at = NOW()
        FROM unnest(%s::int[], %s::float8[]) AS v(block_id, pos)
        WHERE b.block_id = v.block_id
        """,
        (machine_id, ordered_ids, [float(idx) for idx in range(1, len(ordered_ids) + 1)]),
    )

    if moved_block_ids:
        for block_id in moved_block_ids:
            update_planning_card_machine_for_block(con, block_id, machine_id)
        from .preferred_machines_service import sync_preferred_machines_for_blocks

        sync_preferred_machines_for_blocks(con, moved_block_ids, source="QUEUE_REORDER")
        try:
            from .preferred_machines_route import invalidate_preferred_machines_cache

            invalidate_preferred_machines_cache()
        except Exception:
            pass

    sequence_map = sync_operation_sequences_for_machines(con, affected_machine_ids)
    sync_planning_cards_for_machines(con, affected_machine_ids)

    tail_recalculated = False
    if recalculate:
        from .blocks import recalculate_machines
        from .scheduler_state import refresh_states_for_machine

        if tail_start_index < len(ordered_ids):
            tail_by_machine = {}
            if tail_from_block_id:
                tail_by_machine[int(machine_id)] = int(tail_from_block_id)
            recalculate_machines(con, sorted(affected_machine_ids), tail_by_machine=tail_by_machine)
            tail_recalculated = True
        else:
            for affected_id in sorted(affected_machine_ids):
                sync_machine_operation_sequence(con, int(affected_id))
                refresh_states_for_machine(con, int(affected_id))

    return {
        "affected_machine_ids": sorted(affected_machine_ids),
        "recalculated": bool(recalculate),
        "tail_recalculated": tail_recalculated,
        "tail_from_block_id": int(tail_from_block_id) if tail_from_block_id else None,
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
        existing_lane_ids = main_planner_lane_block_ids(con, machine_id)
        tail_start_index = tail_recalc_start_index(existing_lane_ids, ordered_ids)
        if tail_start_index < len(ordered_ids):
            tail_by_machine[machine_id] = int(ordered_ids[tail_start_index])
        result = apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=False)
        all_affected.update(result.get("affected_machine_ids") or [])
        merged_sequences.update(result.get("sequences") or {})

    tail_recalculated = False
    if recalculate and all_affected:
        from .blocks import recalculate_machines

        recalculate_machines(con, sorted(all_affected), tail_by_machine=tail_by_machine)
        tail_recalculated = True

    return {
        "affected_machine_ids": sorted(all_affected),
        "sequences": merged_sequences,
        "recalculated": bool(recalculate),
        "tail_recalculated": tail_recalculated,
        "tail_by_machine": {str(key): int(value) for key, value in tail_by_machine.items()},
    }
