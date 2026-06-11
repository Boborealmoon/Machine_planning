"""Cross-validate /auk-oee dashboard data against raw Auk Pareto API.

Usage:
  python scripts/validate_auk_oee.py
  python scripts/validate_auk_oee.py --from 2026-05-11T04:00:00.000Z --to 2026-05-11T16:00:00.000Z
  python scripts/validate_auk_oee.py --entity 383 --block 5462 --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from planning.auk_oee_service import auk_configured, validate_pareto_dashboard  # noqa: E402


def _print_report(report: dict) -> None:
    s = report["summary"]
    plant = report["plant_oee"]
    print("=" * 72)
    print("AUK OEE CROSS-VALIDATION")
    print("=" * 72)
    print(f"Pareto link : {report['pareto_url']}")
    print(f"Range       : {report['range']['from']} -> {report['range']['to']}")
    print(f"Entity      : {report['entity_id']}   Root block: {report['pareto_block_id']}")
    print()
    print("PLANT OEE (compare this to the Pareto page header)")
    print(f"  Auk Pareto root ({plant['pareto_root_label']}): {plant['auk_oee2']}%")
    if plant["app_oee2"] is not None:
        print(f"  Our app root card              : {plant['app_oee2']}%")
    else:
        print("  Our app root card              : MISSING (deduped out)")
    print(f"  Our frontend hero shows        : {plant['hero_label']} = {plant['hero_oee2']}%")
    if not plant["hero_matches_pareto_root"]:
        print("  WARNING: Hero block is not the Pareto root — numbers may look different at top.")
    print()
    print(
        f"Row match   : {s['matched_rows']}/{s['raw_nodes']} within tolerance "
        f"({s['mismatched_rows']} mismatches)"
    )
    if s["missing_in_app"]:
        print()
        print("Missing in app:")
        for row in s["missing_in_app"]:
            oee = row["metrics"]["final_effective"]["auk"]
            print(f"  - {row['label']} (block {row['block_id']}): Auk OEE2={oee}%")

    mismatches = [
        row
        for row in report["rows"]
        if not row["in_app"]
        or any(not m["ok"] for m in row["metrics"].values())
        or not row["uu"]["ok"]
    ]
    if mismatches:
        print()
        print("Mismatched rows:")
        for row in mismatches:
            oee = row["metrics"]["final_effective"]
            print(
                f"  - {row['label']} (block {row['block_id']}): "
                f"Auk={oee['auk']}% App={oee['app']}% delta={oee['delta']}"
            )

    print()
    print("Machine sample (first 8 with OEE):")
    shown = 0
    for row in report["rows"]:
        if not row["in_app"]:
            continue
        oee = row["metrics"]["final_effective"]
        uu = row["uu"]
        print(
            f"  {row['label']:<28} Auk {oee['auk']:>6}%  App {str(oee['app']):>6}%  "
            f"UU auk={uu['auk']} app={uu['app']}"
        )
        shown += 1
        if shown >= 8:
            break
    print("=" * 72)


def main() -> int:
    parser = argparse.ArgumentParser(description="Cross-validate Auk OEE dashboard vs Pareto API")
    parser.add_argument("--entity", type=int, default=383)
    parser.add_argument("--block", type=int, default=5462, help="Pareto root block id")
    parser.add_argument("--from", dest="lower", default="2026-05-11T04:00:00.000Z")
    parser.add_argument("--to", dest="upper", default="2026-05-11T16:00:00.000Z")
    parser.add_argument("--tolerance", type=float, default=0.05)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    report = validate_pareto_dashboard(
        entity_id=args.entity,
        pareto_block_id=args.block,
        lower=args.lower,
        upper=args.upper,
        tolerance=args.tolerance,
    )
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_report(report)
    return 0 if report["summary"]["mismatched_rows"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
