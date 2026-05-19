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
from sync import run_full_pp_staging_sync
from db import planner_get_conn, planner_release_conn


def main():
    with app.app_context():
        _ensure_pp_staging_schema()
        results = run_full_pp_staging_sync(force=True)
        for name, result in results.items():
            print(f"--- {name} ---", flush=True)
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
