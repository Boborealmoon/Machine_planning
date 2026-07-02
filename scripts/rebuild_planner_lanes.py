#!/usr/bin/env python3
"""Rebuild planner machine lanes from SCHEDULED planning cards.

Recovery script after accidental queue deletion. Uses planner_planning_card rows
(machine_id + machine_queue_index) as the source of truth for lane contents.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from planning.auto_unschedule import apply_saved_anchor_to_new_block
from planning.blocks import recalculate_machine
from planning.helpers import one, planner_db, rows
from planning.machines import fetch_mpp_planner_machine_ids
from planning.operation_sequence import apply_machine_queue_order
from planning.process_sheets import ensure_planner_process_sheet, parse_planner_ps_id
from planning.utils import compact_text, parse_number


def _card_key(machine_id: int, ps_id: str, op_no: str) -> tuple:
    return (int(machine_id), compact_text(ps_id), compact_text(op_no))


def _block_key(machine_id: int, ps_id: str, op_no: str) -> tuple:
    return _card_key(machine_id, ps_id, op_no)


def _load_scheduled_cards(con):
    return rows(
        con.execute(
            """
            SELECT pc.card_id, pc.planner_ps_id, pc.operation_label, pc.machine_id,
                   pc.target_qty, pc.machine_queue_index,
                   pco.source_ps_id, pco.source_op_seq_id, pco.source_op_no,
                   pco.setup_minutes, pco.cycle_minutes_per_qty, pco.target_qty AS op_target_qty
            FROM planner_planning_card pc
            JOIN planner_planning_card_operation pco ON pco.card_id = pc.card_id
            WHERE pc.planning_status = 'SCHEDULED'
              AND COALESCE(pc.machine_id, 0) > 0
              AND COALESCE(pc.card_type, 'SINGLE') = 'SINGLE'
            ORDER BY pc.machine_id,
                     COALESCE(pc.machine_queue_index, 999999),
                     pc.card_id
            """
        )
    )


def _load_active_blocks(con):
    return rows(
        con.execute(
            """
            SELECT b.block_id, b.machine_id, b.queue_position,
                   o.source_ps_id, o.job_no, o.source_op_no, o.source_op_seq_id,
                   o.total_qty, o.setup_minutes, o.cycle_minutes_per_qty
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE COALESCE(b.active, TRUE) = TRUE
            ORDER BY b.machine_id, b.queue_position, b.block_id
            """
        )
    )


def _ps_identity(row) -> tuple[str, int]:
    raw = compact_text(row.get("source_ps_id") or row.get("job_no") or row.get("planner_ps_id"))
    base, partial = parse_planner_ps_id(raw)
    return base, int(partial or 1)


def _create_block_for_card(con, card, queue_position: float) -> int:
    from planning.cycle_time_service import resolve_schedule_times

    machine_id = int(card["machine_id"])
    ps_id = compact_text(card.get("source_ps_id") or card.get("planner_ps_id"))
    op_no = compact_text(card.get("source_op_no") or card.get("operation_label"))
    op_seq_id = int(card.get("source_op_seq_id") or 0)
    target_qty = float(card.get("op_target_qty") or card.get("target_qty") or 0)

    ensure_planner_process_sheet(con, ps_id)
    resolved = resolve_schedule_times(
        con,
        source_ps_id=ps_id,
        source_op_seq_id=op_seq_id,
        source_op_no=op_no,
        cycle_minutes_per_qty=parse_number(card.get("cycle_minutes_per_qty"), 0),
        setup_minutes=parse_number(card.get("setup_minutes"), 0),
    )
    cycle_minutes = float(resolved.get("cycle_minutes_per_qty") or 0)
    setup_minutes = float(resolved.get("setup_minutes") or 0)
    operation_name = op_no or f"Op {op_seq_id}" if op_seq_id else "Operation"

    machine = one(
        con.execute(
            "SELECT machine_category FROM planner_machines WHERE machine_id = %s",
            (machine_id,),
        )
    )
    compatible = compact_text((machine or {}).get("machine_category") or "UNKNOWN")

    op_cur = con.execute(
        """
        INSERT INTO planner_operation (
          job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty,
          compatible_machine_group, source_ps_id, source_op_seq_id, source_op_no,
          status, remarks, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'ACTIVE', '', NOW())
        RETURNING operation_id
        """,
        (
            ps_id,
            operation_name,
            target_qty,
            setup_minutes,
            cycle_minutes,
            compatible,
            ps_id,
            op_seq_id,
            op_no,
        ),
    )
    operation_id = int(one(op_cur)["operation_id"])

    block_cur = con.execute(
        """
        INSERT INTO planner_run_block (
          operation_id, machine_id, queue_position, scheduled_qty, include_setup,
          status, planning_status, execution_status,
          anchor_datetime, calculated_start_datetime, calculated_end_datetime,
          actual_good_qty, actual_reject_qty, remarks, updated_at
        ) VALUES (%s, %s, %s, %s, TRUE, 'NOT_STARTED', 'PLANNED', 'NOT_STARTED',
                  NULL, NULL, NULL, 0, 0, '', NOW())
        RETURNING block_id
        """,
        (operation_id, machine_id, float(queue_position), target_qty),
    )
    block_id = int(one(block_cur)["block_id"])
    apply_saved_anchor_to_new_block(con, block_id, ps_id, op_no)
    return block_id


def rebuild_lanes(*, dry_run: bool = False) -> dict:
    stats = {
        "created": 0,
        "matched": 0,
        "machines_recalculated": 0,
        "errors": [],
    }

    with planner_db() as con:
        mpp_ids = set(fetch_mpp_planner_machine_ids(con))
        cards = _load_scheduled_cards(con)
        blocks = _load_active_blocks(con)

        blocks_by_machine: dict[int, list[dict]] = defaultdict(list)
        for block in blocks:
            blocks_by_machine[int(block["machine_id"])].append(dict(block))

        cards_by_machine: dict[int, list[dict]] = defaultdict(list)
        for card in cards:
            cards_by_machine[int(card["machine_id"])].append(dict(card))

        all_machine_ids = sorted(
            mid for mid in (set(blocks_by_machine) | set(cards_by_machine)) if mid not in mpp_ids
        )

        for machine_id in all_machine_ids:
            machine_cards = cards_by_machine.get(machine_id, [])
            machine_blocks = blocks_by_machine.get(machine_id, [])
            available_blocks = list(machine_blocks)
            ordered_block_ids: list[int] = []
            created_here = 0

            for card in machine_cards:
                ps_id = compact_text(card.get("source_ps_id") or card.get("planner_ps_id"))
                op_no = compact_text(card.get("source_op_no") or card.get("operation_label"))
                card_base, card_partial = _ps_identity(card)

                matched_idx = None
                for idx, block in enumerate(available_blocks):
                    block_base, block_partial = _ps_identity(block)
                    if block_base != card_base or block_partial != card_partial:
                        continue
                    if compact_text(block.get("source_op_no")) != op_no:
                        continue
                    matched_idx = idx
                    break

                if matched_idx is not None:
                    block = available_blocks.pop(matched_idx)
                    ordered_block_ids.append(int(block["block_id"]))
                    stats["matched"] += 1
                    continue

                queue_position = float(card.get("machine_queue_index") or len(ordered_block_ids) + 1)
                if dry_run:
                    created_here += 1
                    ordered_block_ids.append(-int(card["card_id"]))
                    continue

                try:
                    block_id = _create_block_for_card(con, card, queue_position)
                    ordered_block_ids.append(block_id)
                    created_here += 1
                    stats["created"] += 1
                except Exception as exc:
                    stats["errors"].append(
                        {
                            "machine_id": machine_id,
                            "card_id": int(card["card_id"]),
                            "ps_id": ps_id,
                            "op_no": op_no,
                            "error": str(exc),
                        }
                    )

            if not ordered_block_ids:
                continue

            if dry_run:
                print(
                    f"machine {machine_id}: would order {len(ordered_block_ids)} blocks "
                    f"(create {created_here}, matched {len(machine_cards) - created_here})"
                )
                continue

            apply_machine_queue_order(con, machine_id, ordered_block_ids, recalculate=False)
            recalculate_machine(con, machine_id, reason="LANE_REBUILD")
            stats["machines_recalculated"] += 1
            print(
                f"machine {machine_id}: rebuilt {len(ordered_block_ids)} blocks "
                f"(created {created_here})"
            )

    return stats


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("DRY RUN — no writes")
    stats = rebuild_lanes(dry_run=dry_run)
    print("DONE", stats)
    return 1 if stats["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
