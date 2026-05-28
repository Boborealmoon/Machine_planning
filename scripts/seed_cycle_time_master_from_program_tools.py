"""
One-time seed: planner_cycle_time_master from planner_program_tools (Supabase).

Uses SUPA_DB_URL (direct Postgres). Enriches BOM/stage fields from bom_op_stage when
operation_no matches ERP op_no or stage_no (same rules as stg_cycle_time_comparison).

Usage (from repo root):
    python scripts/seed_cycle_time_master_from_program_tools.py
    python scripts/seed_cycle_time_master_from_program_tools.py --truncate
    python scripts/seed_cycle_time_master_from_program_tools.py --force   # alias for --truncate

Skips insert when the master table already has rows unless --truncate is passed.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

MIGRATION_SQL = ROOT / "migrations" / "seed_planner_cycle_time_master_from_program_tools.sql"

from planning.cycle_time_master_import import CANDIDATES_CTE  # noqa: E402

INSERT_SQL = f"""
WITH {CANDIDATES_CTE}
INSERT INTO public.planner_cycle_time_master (
    bom_code,
    part_no,
    part_description,
    stage_no,
    stage_name,
    op_no,
    op_type,
    program_no,
    program_file,
    tool_list_file,
    cycle_time,
    set_up_time
)
SELECT
    bom_code,
    part_no,
    part_description,
    stage_no,
    stage_name,
    op_no,
    op_type,
    program_no,
    program_file,
    tool_list_file,
    cycle_time,
    set_up_time
FROM candidates
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--truncate",
        "--force",
        action="store_true",
        dest="truncate",
        help="Clear planner_cycle_time_master and reload from planner_program_tools",
    )
    args = parser.parse_args()

    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")

    from sync import PLANNER_STATEMENT_TIMEOUT_MS, _planner_db_available
    from planning.helpers import planner_db, rows

    if not _planner_db_available():
        print("ERROR: SUPA_DB_URL is not set in .env (direct Supabase Postgres required).")
        return 1

    with planner_db() as con:
        con.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")

        src = rows(
            con.execute(
                """
                SELECT COUNT(*) AS n
                FROM public.planner_program_tools
                WHERE NULLIF(trim(part_no_erp), '') IS NOT NULL
                """
            )
        )[0]["n"]
        print(f"Source rows (planner_program_tools with part_no_erp): {src}")

        existing = rows(
            con.execute("SELECT COUNT(*) AS n FROM public.planner_cycle_time_master")
        )[0]["n"]
        print(f"Existing rows (planner_cycle_time_master): {existing}")

        if existing and not args.truncate:
            print("Skip: master table is not empty. Pass --truncate to replace all rows.")
            return 0

        if args.truncate:
            print("Truncating planner_cycle_time_master …")
            con.execute("TRUNCATE public.planner_cycle_time_master RESTART IDENTITY")

        print("Inserting from planner_program_tools …")
        cur = con.execute(INSERT_SQL)
        inserted = int(cur.rowcount or 0)

        total = rows(
            con.execute("SELECT COUNT(*) AS n FROM public.planner_cycle_time_master")
        )[0]["n"]
        with_bom = rows(
            con.execute(
                """
                SELECT COUNT(*) AS n
                FROM public.planner_cycle_time_master
                WHERE NULLIF(trim(bom_code), '') IS NOT NULL
                """
            )
        )[0]["n"]
        with_cycle = rows(
            con.execute(
                """
                SELECT COUNT(*) AS n
                FROM public.planner_cycle_time_master
                WHERE cycle_time > 0
                """
            )
        )[0]["n"]

    print(f"Inserted: {inserted} row(s)")
    print(f"Master table total: {total} (with bom_code: {with_bom}, with cycle_time > 0: {with_cycle})")
    print("Done. Review at Planning Data -> Master cycle times.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
