#!/usr/bin/env python3
"""
One-time refresh: Google Sheet → tool_list.db → Supabase planner_program_tools.

1. Pulls the program/tool Google Sheet into local SQLite.
2. Truncates planner_program_tools on Supabase, then upserts only valid rows
   (non-empty program_file + tool_list_files + part_no_erp).

Requires:
  - tool_list_secret_key in .env
  - Supabase URL + service role key
  - migrations/add_planner_program_tools_upsert_unique_key.sql applied in Supabase

Usage (from repo root):
  python scripts/refresh_planner_program_tools.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from planning.program_tool_list_route import (
        sync_program_tool_list_to_supabase,
        sync_tool_list_sheet_to_sqlite,
    )

    print("Syncing Google Sheet → tool_list.db …")
    sheet = sync_tool_list_sheet_to_sqlite()
    print(json.dumps(sheet, indent=2))

    print("Full refresh → Supabase (DELETE + upsert valid rows) …")
    result = sync_program_tool_list_to_supabase(full_refresh=True)
    print(json.dumps(result, indent=2))

    if result.get("error"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
