"""Run PP staging sync (same as POST /api/pp-staging/sync).

Run from repo root:
  python -u scripts/run_pp_staging_sync.py
  python -u scripts/run_pp_staging_sync.py --steps pp_voucher,mfg_wo_status,cache
  python -u scripts/run_pp_staging_sync.py --skip-cache

Uses WERKZEUG_RUN_MAIN=false so importing app does not start the Flask
auto-sync thread (that thread was racing this script and causing skips).
"""
import argparse
import os
import sys
from pathlib import Path

# Must be set before app import — app.py starts auto-sync otherwise.
os.environ.setdefault("WERKZEUG_RUN_MAIN", "false")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app, _ensure_pp_staging_schema, _invalidate_pp_vouchers_with_ops_cache
from sync import (
    PP_STAGING_STEP_ORDER,
    resolve_pp_staging_steps,
    run_pp_staging_sync,
)
from db import planner_get_conn, planner_release_conn


def main():
    parser = argparse.ArgumentParser(description="Run PP staging sync pipeline")
    parser.add_argument(
        "--steps",
        help="Comma-separated steps (default: full pipeline). Aliases: cache, process_sheet",
    )
    parser.add_argument(
        "--skip-cache",
        action="store_true",
        help="Run all staging tables except pp_vouchers_cache",
    )
    parser.add_argument(
        "--no-force",
        action="store_true",
        help="Respect sync cooldown (default: force=True)",
    )
    args = parser.parse_args()

    if args.skip_cache and args.steps:
        parser.error("Use either --steps or --skip-cache, not both")

    if args.skip_cache:
        steps = [s for s in PP_STAGING_STEP_ORDER if s != "pp_vouchers_cache"]
    elif args.steps:
        steps = resolve_pp_staging_steps(
            [s.strip() for s in args.steps.split(",") if s.strip()]
        )
    else:
        steps = None

    force = not args.no_force

    with app.app_context():
        ordered = resolve_pp_staging_steps(steps)
        staging_only = [s for s in ordered if s != "pp_vouchers_cache"]
        if staging_only:
            _ensure_pp_staging_schema()
        results = run_pp_staging_sync(steps=steps, force=force)
        for name in ordered:
            result = results.get(name, {})
            print(f"--- {name} ---", flush=True)
            print(result, flush=True)
            if result.get("skipped"):
                print(f"WARNING: {name} was skipped: {result.get('reason')}", flush=True)
            if result.get("error"):
                print(f"ERROR: {name} failed", flush=True)
                sys.exit(1)
        if results.get("_failed_at"):
            sys.exit(1)
        if "pp_vouchers_cache" in ordered or staging_only:
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
