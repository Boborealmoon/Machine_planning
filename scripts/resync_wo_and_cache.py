"""Re-sync mfg_wo_status + rebuild pp_vouchers_cache."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import _invalidate_pp_vouchers_with_ops_cache
from planning.helpers import planner_db, rows
from sync import run_mfg_wo_status_sync, run_pp_staging_sync

PS = "NPS25-0279"


def main():
    print("WO sync:", run_mfg_wo_status_sync(force=True))
    print("cache:", run_pp_staging_sync(steps=["pp_vouchers_cache"], force=True))
    _invalidate_pp_vouchers_with_ops_cache()

    with planner_db() as con:
        for partial in (2, 3, 4, 5):
            wo = rows(
                con.execute(
                    """
                    SELECT pp_partial_no, stage_no, stage_desc,
                           total_acc_qty_produced, execution_status
                    FROM mfg_wo_status
                    WHERE source_mps_no = %s AND pp_partial_no = %s
                    ORDER BY stage_no
                    """,
                    (PS, partial),
                )
            )
            print(f"\npartial {partial} mfg_wo_status ({len(wo)} stages):")
            for row in wo:
                print(dict(row))

        from app import _fetch_pp_vouchers_cache_rows

        cache = [
            r
            for r in _fetch_pp_vouchers_cache_rows(False)
            if r.get("ps_id") == PS and int(r.get("pp_partial_no") or 0) == 3
        ]
        print("\npartial 3 merged cache read:")
        for row in cache:
            print(
                dict(
                    (k, row[k])
                    for k in ("stage_no", "stage_desc", "wo_qty_produced", "execution_status")
                )
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
