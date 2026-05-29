#!/usr/bin/env python3
"""Import / refresh Singapore public holidays from data.gov.sg into planner_public_holiday.

Examples:
  python scripts/import_sg_public_holidays.py
  python scripts/import_sg_public_holidays.py --from-year 2024 --to-year 2027
  python scripts/import_sg_public_holidays.py --dry-run
  python scripts/import_sg_public_holidays.py --no-recalc
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh SG public holidays (data.gov.sg → planner_public_holiday)")
    parser.add_argument("--from-year", type=int, default=None, help="First year to sync (default: current year - 1)")
    parser.add_argument("--to-year", type=int, default=None, help="Last year to sync (default: current year + 1)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch only; do not write to the database")
    parser.add_argument("--no-recalc", action="store_true", help="Skip recalculate_all after sync")
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from planning.sg_public_holidays import fetch_sg_public_holidays, sync_sg_public_holidays_to_db

    today = date.today()
    from_year = int(args.from_year if args.from_year is not None else today.year - 1)
    to_year = int(args.to_year if args.to_year is not None else today.year + 1)
    range_start = date(from_year, 1, 1)
    range_end = date(to_year, 12, 31)

    print(f"Fetching SG public holidays {from_year}–{to_year} from data.gov.sg …")
    holidays = fetch_sg_public_holidays(from_date=range_start, to_date=range_end)
    print(f"Fetched {len(holidays)} holiday date(s).")
    for row in holidays:
        day = f" ({row['day']})" if row.get("day") else ""
        print(f"  {row['holiday_date']}{day}: {row['note']}")

    if args.dry_run:
        print("Dry run — no database changes.")
        return 0

    from planning.blocks import recalculate_all
    from planning.helpers import planner_db

    with planner_db() as con:
        result = sync_sg_public_holidays_to_db(con, from_year=from_year, to_year=to_year)
        if not args.no_recalc:
            recalculate_all(con)

    print(
        f"Synced: upserted={result['upserted_count']}, "
        f"removed_old_sg_mom={result['deleted_sg_mom_count']}, "
        f"fetched_at={result['fetched_at']}"
    )
    if not args.no_recalc:
        print("Machine schedules recalculated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
