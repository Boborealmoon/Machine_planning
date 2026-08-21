"""Detect ERP accepted-qty scans on a 5-minute shop-hours cadence.

Does not run a full ERP sync. Queries COMAIN WO qty only, then posts
increases to planner_erp_qty_jump.

Usage:
  python scripts/run_erp_qty_tracer.py
  python scripts/run_erp_qty_tracer.py --force
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.erp_wo_qty_tracer import erp_qty_tracer_enabled, run_erp_wo_qty_tracer


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run even outside shop hours or when DISABLE_ERP_QTY_TRACER is set",
    )
    args = parser.parse_args()

    if not args.force and not erp_qty_tracer_enabled():
        print("WO qty tracer is disabled (DISABLE_ERP_QTY_TRACER). Pass --force to run anyway.")
        return 1

    summary = run_erp_wo_qty_tracer(force=args.force)
    print(json.dumps(summary, default=str))
    if summary.get("skipped"):
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
