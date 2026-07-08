#!/usr/bin/env python3
"""Reset MPP planner + main scheduler lanes for selected CNC machines (default: CNC 35 & 36)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from planning.helpers import planner_db, rows
    from planning.mpp_planner_queue_service import reset_mpp_planner_lanes

    args = [a for a in sys.argv[1:] if a not in ("--dry-run",)]
    dry_run = "--dry-run" in sys.argv
    slugs = args if args else ["cnc35", "cnc36"]

    with planner_db() as con:
        preview = rows(
            con.execute(
                """
                SELECT m.machine_no, COUNT(DISTINCT c.cycle_id) AS cycles,
                       COUNT(DISTINCT b.block_id) AS blocks
                FROM planner_machines m
                LEFT JOIN planner_mpp_cycle c ON c.machine_id = m.machine_id
                LEFT JOIN planner_run_block b
                  ON b.machine_id = m.machine_id AND COALESCE(b.active, TRUE) = TRUE
                WHERE LOWER(REPLACE(m.machine_no, ' ', '')) = ANY(%s)
                GROUP BY m.machine_id, m.machine_no
                ORDER BY m.machine_no
                """,
                ([s.lower().replace(" ", "") for s in slugs],),
            )
        )
        if not preview:
            print(f"No machines matched slugs: {slugs}")
            return 1
        print("Lanes to reset:")
        for row in preview:
            print(f"  {row['machine_no']}: {row['cycles']} cycles, {row['blocks']} scheduler blocks")
        if dry_run:
            print("DRY RUN — no changes")
            return 0
        result = reset_mpp_planner_lanes(con, slugs=slugs)
        con.commit()
        print(f"Reset complete: {result.get('reset')}")
        saved = result.get("saved") or {}
        if saved.get("warnings"):
            for w in saved["warnings"]:
                print(f"  warning: {w}")
    print("Reload MPP Planner and Main Planner (hard refresh) to see empty lanes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
