#!/usr/bin/env python3
"""
DESTRUCTIVE admin-only rebuild (not normal sync).

Wipes planner_program_tools and replaces ALL planner_cycle_time_master rows.
For day-to-day use, use POST /api/planner/cycle-times/sync or the UI "Sync from sheet" instead.

Requires ALLOW_MASTER_TRUNCATE=1 in .env for the master truncate step.

Usage (from repo root):
  set ALLOW_MASTER_TRUNCATE=1
  python scripts/refresh_master_cycle_times_full.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")

    import os

    from planning.cycle_time_master_import import reload_master_from_program_tools
    from planning.program_tool_list_route import (
        sync_program_tool_list_to_supabase,
        sync_tool_list_sheet_to_sqlite,
    )

    if os.getenv("ALLOW_MASTER_TRUNCATE", "").strip().lower() not in {"1", "true", "yes", "on"}:
        print("ERROR: Set ALLOW_MASTER_TRUNCATE=1 in .env for destructive rebuild.")
        print("Normal sync: POST /api/planner/cycle-times/sync or UI 'Sync from sheet'.")
        return 1

    print("DESTRUCTIVE rebuild. 1/2 Program tools: Sheet -> SQLite -> Supabase (full wipe) ...")
    try:
        sheet = sync_tool_list_sheet_to_sqlite()
        print(json.dumps(sheet, indent=2))
    except Exception as e:
        print(f"Sheet sync failed: {e}")
        return 1

    ppt = sync_program_tool_list_to_supabase(full_refresh=True)
    print(json.dumps(ppt, indent=2))
    if ppt.get("error"):
        return 1

    print("2/2 Master cycle times: TRUNCATE + reload from program tools ...")
    master = reload_master_from_program_tools()
    print(json.dumps(master, indent=2))
    if master.get("error"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
