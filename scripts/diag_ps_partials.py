#!/usr/bin/env python3
"""Diagnose planner partial/queue state for a process sheet (Supabase/Postgres)."""
from __future__ import annotations

import json
import sys

from planning.helpers import planner_db, one, rows
from planning.process_sheets import format_planner_ps_id, parse_planner_ps_id

PS_NEEDLE = (sys.argv[1] if len(sys.argv) > 1 else "NPS26-0222").strip().upper()


def main():
    base = PS_NEEDLE.split("::")[0]
    print(f"=== Diagnose PS base: {base} ===\n")

    with planner_db() as con:
        sheets = rows(
            con.execute(
                """
                SELECT planner_ps_id, source_ps_id, pp_partial_no, planner_status, status,
                       planned_qty, selected_bom_id
                FROM planner_process_sheet
                WHERE UPPER(source_ps_id) = UPPER(%s)
                   OR UPPER(planner_ps_id) LIKE UPPER(%s)
                ORDER BY pp_partial_no, planner_ps_id
                """,
                (base, f"{base}%"),
            )
        )
        print(f"planner_process_sheet rows: {len(sheets)}")
        for s in sheets:
            print(
                f"  partial={s.get('pp_partial_no')} planner_ps_id={s.get('planner_ps_id')!r} "
                f"source={s.get('source_ps_id')!r} bom={s.get('selected_bom_id')} qty={s.get('planned_qty')}"
            )

        ops = rows(
            con.execute(
                """
                SELECT o.operation_id, o.job_no, o.source_ps_id, o.source_op_no, o.source_op_seq_id,
                       o.operation_name, o.total_qty
                FROM planner_operation o
                WHERE UPPER(COALESCE(o.source_ps_id, '')) LIKE UPPER(%s)
                   OR UPPER(COALESCE(o.job_no, '')) LIKE UPPER(%s)
                ORDER BY o.operation_id
                """,
                (f"{base}%", f"{base}%"),
            )
        )
        print(f"\nplanner_operation rows: {len(ops)}")
        for o in ops:
            src = o.get("source_ps_id") or ""
            job = o.get("job_no") or ""
            _, p_src = parse_planner_ps_id(src)
            _, p_job = parse_planner_ps_id(job)
            flag = " *** MISMATCH" if p_src != p_job else ""
            print(
                f"  op_id={o['operation_id']} op={o.get('source_op_no')} "
                f"source_ps_id={src!r}(p{p_src}) job_no={job!r}(p{p_job}) qty={o.get('total_qty')}{flag}"
            )

        blocks = rows(
            con.execute(
                """
                SELECT b.block_id, b.machine_id, m.machine_no AS machine_code,
                       b.queue_position, b.scheduled_qty, b.active,
                       o.operation_id, o.job_no, o.source_ps_id, o.source_op_no
                FROM planner_run_block b
                JOIN planner_operation o ON o.operation_id = b.operation_id
                LEFT JOIN planner_machines m ON m.machine_id = b.machine_id
                WHERE UPPER(COALESCE(o.source_ps_id, '')) LIKE UPPER(%s)
                   OR UPPER(COALESCE(o.job_no, '')) LIKE UPPER(%s)
                ORDER BY b.machine_id, b.queue_position, b.block_id
                """,
                (f"{base}%", f"{base}%"),
            )
        )
        print(f"\nplanner_run_block (all): {len(blocks)}")
        for b in blocks:
            src = b.get("source_ps_id") or ""
            job = b.get("job_no") or ""
            _, p_src = parse_planner_ps_id(src)
            _, p_job = parse_planner_ps_id(job)
            active = b.get("active")
            flag = ""
            if p_src != p_job:
                flag += " ID_MISMATCH"
            if not active:
                flag += " INACTIVE"
            print(
                f"  block={b['block_id']} {b.get('machine_code')} q={b.get('queue_position')} "
                f"qty={b.get('scheduled_qty')} op={b.get('source_op_no')} "
                f"source={src!r}(p{p_src}) job={job!r}(p{p_job}){flag}"
            )

        # CNC 35 specifically if exists
        cnc35 = one(
            con.execute(
                "SELECT machine_id FROM planner_machines WHERE UPPER(machine_no) = 'CNC 35'"
            )
        )
        if cnc35:
            mid = int(cnc35["machine_id"])
            lane = rows(
                con.execute(
                    """
                    SELECT b.block_id, b.queue_position, b.scheduled_qty, b.active,
                           o.job_no, o.source_ps_id, o.source_op_no
                    FROM planner_run_block b
                    JOIN planner_operation o ON o.operation_id = b.operation_id
                    WHERE b.machine_id = %s
                      AND (UPPER(COALESCE(o.source_ps_id, '')) LIKE UPPER(%s)
                           OR UPPER(COALESCE(o.job_no, '')) LIKE UPPER(%s))
                    ORDER BY b.queue_position, b.block_id
                    """,
                    (mid, f"{base}%", f"{base}%"),
                )
            )
            print(f"\nCNC 35 lane blocks for {base}: {len(lane)}")
            for b in lane:
                print(
                    f"  #{b.get('queue_position')} block={b['block_id']} "
                    f"{b.get('source_op_no')} qty={b.get('scheduled_qty')} "
                    f"source={b.get('source_ps_id')!r} job={b.get('job_no')!r} active={b.get('active')}"
                )

        # ERP vouchers partials
        try:
            vouchers = rows(
                con.execute(
                    """
                    SELECT ps_id, pp_partial_no, partial_qty, total_qty, due_date
                    FROM pp_vouchers_cache
                    WHERE UPPER(ps_id) = UPPER(%s)
                    ORDER BY pp_partial_no
                    """,
                    (base,),
                )
            )
            print(f"\npp_vouchers_cache partials: {len(vouchers)}")
            for v in vouchers:
                print(
                    f"  partial={v.get('pp_partial_no')} qty={v.get('partial_qty')} "
                    f"total={v.get('total_qty')} due={v.get('due_date')}"
                )
        except Exception as e:
            print(f"\npp_vouchers_cache: skip ({e})")

    print("\n=== Canonical ids ===")
    for p in (1, 2):
        print(f"  partial {p}: {format_planner_ps_id(base, p)!r}")


if __name__ == "__main__":
    main()
