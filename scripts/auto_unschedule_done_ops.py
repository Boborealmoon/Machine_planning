"""Return DONE machine-lane blocks to the catalog (anchor preserved on planning cards).

Runs automatically on full scheduler page reload (GET /api/trial/schedule).
Optional: background thread in app.py or scripts/install_auto_unschedule_scheduler.ps1

Opt out: DISABLE_AUTO_UNSCHEDULE_DONE_OPS=1

Usage:
  python scripts/auto_unschedule_done_ops.py
  python scripts/auto_unschedule_done_ops.py --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.auto_unschedule import auto_unschedule_enabled, run_auto_unschedule_sweep
from planning.helpers import planner_db


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List block ids that would be unscheduled without writing changes",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run even when DISABLE_AUTO_UNSCHEDULE_DONE_OPS is set",
    )
    args = parser.parse_args()

    if not args.force and not auto_unschedule_enabled():
        print("Auto-unschedule is disabled (DISABLE_AUTO_UNSCHEDULE_DONE_OPS). Pass --force to run anyway.")
        return 1

    from planning.auto_unschedule import ensure_saved_anchor_column

    with planner_db() as con:
        ensure_saved_anchor_column(con)
        summary = run_auto_unschedule_sweep(con, dry_run=args.dry_run)

    if summary.get("dry_run"):
        ids = summary.get("candidates") or []
        print(f"Dry run: {len(ids)} block(s) would be unscheduled.")
        for block_id in ids:
            print(f"  block_id={block_id}")
        return 0

    print(
        f"Unscheduled {summary.get('unscheduled', 0)} of "
        f"{summary.get('candidates', 0)} candidate block(s)."
    )
    for item in summary.get("results") or []:
        if not item.get("ok"):
            print(f"  skip block_ids={item.get('block_ids')} reason={item.get('reason')}")
            continue
        print(
            f"  ok block_ids={item.get('block_ids')} "
            f"machines={item.get('machine_ids')} anchor_saved={item.get('saved_anchor')}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
