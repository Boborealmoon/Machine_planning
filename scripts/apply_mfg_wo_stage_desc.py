"""Apply stage_desc migration and run mfg_wo_status sync."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.helpers import planner_db, rows

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "add_mfg_wo_status_stage_desc.sql"


def main():
    print("1. Applying migration...")
    with planner_db() as con:
        con.execute("SET LOCAL statement_timeout = '600000'")
        con.execute(
            """
            ALTER TABLE public.mfg_wo_status
                ADD COLUMN IF NOT EXISTS stage_desc TEXT
            """
        )
    print("   OK: stage_desc column added (or already exists)")

    print("2. Running mfg_wo_status sync...")
    from sync import run_mfg_wo_status_sync

    result = run_mfg_wo_status_sync(force=True)
    print(f"   Sync result: {result}")

    print("3. Verifying sample rows...")
    with planner_db() as con:
        con.execute("SET LOCAL statement_timeout = '600000'")
        stats = rows(
            con.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(stage_desc) AS with_stage_desc
                FROM public.mfg_wo_status
                """
            )
        )[0]
        print(f"   Total rows: {stats['total']}, with stage_desc: {stats['with_stage_desc']}")

        samples = rows(
            con.execute(
                """
                SELECT source_mps_no, pp_partial_no, stage_no, stage_desc, execution_status
                FROM public.mfg_wo_status
                WHERE stage_desc IS NOT NULL
                ORDER BY source_mps_no, pp_partial_no, stage_no
                LIMIT 5
                """
            )
        )
        for row in samples:
            print(f"   {row}")


if __name__ == "__main__":
    main()
