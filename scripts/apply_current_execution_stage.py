"""Apply current execution stage columns, refresh view, sync mfg_wo_status, rebuild cache."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.helpers import planner_db, rows


def main():
    print("1. Applying cache column migration...")
    with planner_db() as con:
        con.execute("SET LOCAL statement_timeout = '600000'")
        for stmt in (
            "ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS current_stage_no INTEGER",
            "ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS current_stage_desc TEXT",
            "ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS current_stage_status TEXT",
        ):
            con.execute(stmt)
    print("   OK")

    print("2. Updating vw_pp_vouchers (sql/vw_pp_vouchers.sql)...")
    from app import _ensure_pp_staging_schema

    _ensure_pp_staging_schema(apply_view=True)
    print("   OK")

    print("3. Syncing mfg_wo_status from COMAIN...")
    from sync import run_mfg_wo_status_sync

    print(f"   {run_mfg_wo_status_sync(force=True)}")

    print("4. Rebuilding pp_vouchers_cache...")
    from sync import run_sync

    print(f"   {run_sync(force=True)}")

    print("5. Verifying samples...")
    with planner_db() as con:
        stats = rows(
            con.execute(
                """
                SELECT
                    COUNT(*) AS total_rows,
                    COUNT(DISTINCT (ps_id, pp_partial_no)) AS partials,
                    COUNT(DISTINCT (ps_id, pp_partial_no))
                        FILTER (WHERE current_stage_desc IS NOT NULL) AS partials_with_stage
                FROM public.pp_vouchers_cache
                """
            )
        )[0]
        print(f"   Cache: {stats}")

        samples = rows(
            con.execute(
                """
                SELECT DISTINCT ON (ps_id, pp_partial_no)
                    ps_id, pp_partial_no, current_stage_no, current_stage_desc, current_stage_status
                FROM public.pp_vouchers_cache
                WHERE current_stage_desc IS NOT NULL
                ORDER BY ps_id, pp_partial_no, current_stage_no DESC
                LIMIT 5
                """
            )
        )
        for row in samples:
            print(f"   {row}")


if __name__ == "__main__":
    main()
