"""Probe Auk OEE for CNC 35 (entity 383, asset 6503).

Usage:
  python scripts/test_auk_cnc35.py
  python scripts/test_auk_cnc35.py --from 2025-05-12T04:00:00Z --to 2025-05-12T16:00:00Z
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

from planning.auk_oee_service import (  # noqa: E402
    auk_configured,
    fetch_asset_detail,
    range_for_preset,
)

CNC35_ENTITY = 383
CNC35_ASSET = 6503
CNC35_CHARTS = {
    "Motor Spindle": 15960,
    "Main Incoming": 15961,
    "Green": 15965,
    "Yellow": 15966,
    "Red": 15967,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Test Auk OEE for CNC 35")
    parser.add_argument("--entity", type=int, default=CNC35_ENTITY)
    parser.add_argument("--asset", type=int, default=CNC35_ASSET)
    parser.add_argument("--from", dest="lower", default="")
    parser.add_argument("--to", dest="upper", default="")
    parser.add_argument("--preset", default="")
    args = parser.parse_args()

    if not auk_configured():
        print("ERROR: AUK_ACCESS_TOKEN is not set in .env")
        return 1

    if args.preset:
        lower, upper, preset = range_for_preset(args.preset)
    elif args.lower and args.upper:
        lower, upper, preset = args.lower, args.upper, "custom"
    else:
        # Screenshot range: May 12 12:00–00:00 SGT (12h)
        lower, upper, preset = "2025-05-12T04:00:00Z", "2025-05-12T16:00:00Z", "screenshot"

    print(f"Entity {args.entity} · Asset {args.asset} (CNC 35)")
    print(f"Range ({preset}): {lower} -> {upper}")
    print()

    try:
        detail = fetch_asset_detail(
            args.asset,
            lower=lower,
            upper=upper,
            entity_id=args.entity,
        )
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}")
        if "401" in str(exc):
            print("Token expired - copy a fresh JWT from ops.auk.industries (DevTools ->")
            print("Application -> Local Storage -> access_token), then update AUK_ACCESS_TOKEN in .env")
        return 1

    card = detail.get("card") or {}
    print(f"Asset: {detail.get('asset_name')}")
    print(f"OEE:   {card.get('oee_pct')}%")
    print(f"AVA:   {card.get('availability_pct')}%")
    print(f"PER:   {card.get('performance_pct')}%")
    print(f"QUA:   {card.get('quality_pct')}%")
    print(f"LOA:   {card.get('loading_pct')}%")
    print(f"Hourly slots: {len(detail.get('hourly_oee') or [])}")
    print(f"Std time: {detail.get('std_time')}")
    print()

    charts = {int(c["chart_id"]): c for c in (detail.get("charts") or [])}
    print("Charts:")
    for title, chart_id in CNC35_CHARTS.items():
        row = charts.get(chart_id)
        if row:
            print(
                f"  {title:14} id={chart_id}  points={row.get('data_points')}  "
                f"last={row.get('last_value')}"
            )
        else:
            print(f"  {title:14} id={chart_id}  MISSING from entity dashboard")

    errors = detail.get("chart_errors") or {}
    if errors:
        print()
        print("Chart errors:", json.dumps(errors, indent=2))

    print()
    print("Auk URLs:")
    print(f"  {detail.get('auk_oee_url')}")
    print(f"  {detail.get('auk_chart_data_url')}")

    # Screenshot reference values (May 12 example)
    if preset == "screenshot":
        print()
        print("Screenshot reference (May 12): OEE 25.5%, AVA 27.42%, PER 93%, QUA 100%")
        oee = card.get("oee_pct")
        if oee is not None and abs(float(oee) - 25.5) < 2:
            print("OK OEE roughly matches screenshot")
        elif oee is not None:
            print(f"NOTE OEE differs from screenshot ({oee}% vs 25.5%)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
