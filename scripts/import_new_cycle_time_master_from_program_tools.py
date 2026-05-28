"""
Insert-only import: new rows from planner_program_tools into planner_cycle_time_master.

Never updates or overwrites existing master rows. Skips rows that already match on:
  part_no, bom_code, stage_no, program_no, program_file, tool_list_file

Usage (from repo root):
    python scripts/import_new_cycle_time_master_from_program_tools.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")

    from planning.cycle_time_master_import import import_new_from_program_tools

    result = import_new_from_program_tools()
    if result.get("error"):
        print(f"ERROR: {result['error']}")
        return 1

    print(f"Source rows (program tools): {result.get('source_count', 0)}")
    print(f"Inserted (new only):         {result.get('inserted', 0)}")
    print(f"Skipped (already in master): {result.get('skipped_existing', 0)}")
    print(result.get("message", "Done."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
