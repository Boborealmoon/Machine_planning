"""Run PP staging sync (same as POST /api/pp-staging/sync).

Run from repo root:
  python -u scripts/run_pp_staging_sync.py
  python -u scripts/run_pp_staging_sync.py --steps pp_voucher,mfg_wo_status,cache
  python -u scripts/run_pp_staging_sync.py --skip-cache
  python -u scripts/run_pp_staging_sync.py --log-file logs/erp-sync-test.log

Uses WERKZEUG_RUN_MAIN=false so importing app does not start the Flask
auto-sync thread (that thread was racing this script and causing skips).
"""
import argparse
import os
import sys
from pathlib import Path

# Must be set before app import — app.py starts auto-sync otherwise.
os.environ.setdefault("WERKZEUG_RUN_MAIN", "false")

_REPO = Path(__file__).resolve().parents[1]
_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_REPO))
sys.path.insert(0, str(_SCRIPTS))

from app import app, _ensure_pp_staging_schema, _invalidate_pp_vouchers_with_ops_cache
from db import planner_get_conn, planner_release_conn
from sync_progress import ErpSyncProgress
from sync import (
    PP_STAGING_STEP_LABELS,
    PP_STAGING_STEP_ORDER,
    _STEP_RUNNERS,
    resolve_pp_staging_steps,
)


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
    parser.add_argument(
        "--log-file",
        type=Path,
        help="Append progress lines to this log file (in addition to stdout)",
    )
    parser.add_argument(
        "--json-log",
        type=Path,
        help="Write structured JSON summary for this run",
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
    progress = ErpSyncProgress(
        log_file=args.log_file,
        json_file=args.json_log,
    )

    with app.app_context():
        ordered = resolve_pp_staging_steps(steps)
        staging_only = [s for s in ordered if s != "pp_vouchers_cache"]
        total = len(ordered)
        progress.run_start(ordered, PP_STAGING_STEP_LABELS)

        if staging_only:
            _ensure_pp_staging_schema()
            progress.emit("  schema: staging views/tables verified")

        failed = False
        for index, step in enumerate(ordered, start=1):
            label = PP_STAGING_STEP_LABELS.get(step, step)
            progress.step_start(index, total, step, label)
            try:
                result = _STEP_RUNNERS[step](force=force)
            except Exception as exc:
                result = {"error": str(exc)}
            progress.step_end(index, total, step, label, result)
            if result.get("error"):
                failed = True
                break
            if result.get("skipped") and not result.get("row_count"):
                pass  # continue pipeline unless hard error

        if failed:
            progress.run_end(False)
            sys.exit(1)

        if "pp_vouchers_cache" in ordered or staging_only:
            _invalidate_pp_vouchers_with_ops_cache()

        conn = planner_get_conn()
        try:
            cur = conn.cursor()
            for tbl in ("pp_voucher", "pp_vouchers_cache", "so_detail"):
                cur.execute(f"SELECT COUNT(*) FROM {tbl}")
                count = cur.fetchone()[0]
                progress.emit(f"  table {tbl}: {count} rows")
            cur.execute("SELECT COUNT(*) FROM vw_pp_vouchers")
            progress.emit(f"  view vw_pp_vouchers: {cur.fetchone()[0]} rows")
        finally:
            planner_release_conn(conn)

        progress.run_end(True)


if __name__ == "__main__":
    main()
