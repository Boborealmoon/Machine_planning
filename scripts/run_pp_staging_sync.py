"""Run full PP staging sync (same as POST /api/pp-staging/sync).

Run from repo root:
  python -u scripts/run_pp_staging_sync.py

Uses WERKZEUG_RUN_MAIN=false so importing app does not start the Flask
auto-sync thread (that thread was racing this script and causing skips).
"""
import os
import sys
from pathlib import Path

# Must be set before app import — app.py starts auto-sync otherwise.
os.environ.setdefault("WERKZEUG_RUN_MAIN", "false")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app, _ensure_pp_staging_schema, _invalidate_pp_vouchers_with_ops_cache
from sync import (
    run_pp_voucher_sync,
    run_process_sheet_sync,
    run_workorder_status_sync,
    run_part_desc_sync,
    run_pp_partial_sync,
    run_mfg_wo_status_sync,
    run_qty_shipped_sync,
    run_so_detail_sync,
    run_sync,
)
from db import planner_get_conn, planner_release_conn


def main():
    with app.app_context():
        _ensure_pp_staging_schema()
        steps = [
            ("pp_voucher", run_pp_voucher_sync),
            ("mfg_process_sheet_info", run_process_sheet_sync),
            ("workorder_status", run_workorder_status_sync),
            ("qty_shipped", run_qty_shipped_sync),
            ("so_detail", run_so_detail_sync),
            ("part_desc", run_part_desc_sync),
            ("pp_partial", run_pp_partial_sync),
            ("mfg_wo_status", run_mfg_wo_status_sync),
            ("pp_vouchers_cache", run_sync),
        ]
        for name, fn in steps:
            print(f"--- {name} ---", flush=True)
            result = fn(force=True)
            print(result, flush=True)
            if result.get("skipped"):
                print(f"WARNING: {name} was skipped: {result.get('reason')}", flush=True)
        _invalidate_pp_vouchers_with_ops_cache()

        conn = planner_get_conn()
        try:
            cur = conn.cursor()
            for tbl in ("pp_voucher", "pp_vouchers_cache", "so_detail"):
                cur.execute(f"SELECT COUNT(*) FROM {tbl}")
                print(f"{tbl}:", cur.fetchone()[0])
            cur.execute("SELECT COUNT(*) FROM vw_pp_vouchers")
            print("vw_pp_vouchers:", cur.fetchone()[0])
        finally:
            planner_release_conn(conn)


if __name__ == "__main__":
    main()
