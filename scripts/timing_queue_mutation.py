#!/usr/bin/env python3
"""Rough timing for queue mutation: lite refresh vs full recalc."""
from __future__ import annotations

import sys
import time
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

    from app import app
    from planning.helpers import planner_db, rows

    client = app.test_client()

    with planner_db() as con:
        machine_row = rows(
            con.execute(
                """
                SELECT machine_id, COUNT(*) AS cnt
                FROM planner_run_block
                WHERE COALESCE(active, TRUE) = TRUE
                GROUP BY machine_id
                HAVING COUNT(*) >= 2
                ORDER BY COUNT(*) DESC
                LIMIT 1
                """
            )
        )
        if not machine_row:
            print("SKIP: need a machine with 2+ blocks")
            return 0
        machine_id = int(machine_row[0]["machine_id"])
        block_ids = [
            int(r["block_id"])
            for r in rows(
                con.execute(
                    """
                    SELECT block_id FROM planner_run_block
                    WHERE machine_id = %s AND COALESCE(active, TRUE) = TRUE
                    ORDER BY queue_position, block_id
                    """,
                    (machine_id,),
                )
            )
        ]

    reversed_order = list(reversed(block_ids))
    anchor = reversed_order[0]

    t0 = time.perf_counter()
    res = client.post(
        "/api/trial/queue/reorder-batch",
        json={"lanes": [{"machine_id": machine_id, "ordered_ids": reversed_order}], "recalculate": False},
    )
    defer_ms = (time.perf_counter() - t0) * 1000
    print(f"reorder defer recalc: {defer_ms:.0f}ms status={res.status_code}")

    t0 = time.perf_counter()
    res2 = client.post(
        "/api/trial/queue/recalculate",
        json={"machine_ids": [machine_id]},
    )
    recalc_ms = (time.perf_counter() - t0) * 1000
    print(f"explicit recalc: {recalc_ms:.0f}ms status={res2.status_code}")

    t0 = time.perf_counter()
    res3 = client.post(
        f"/api/trial/blocks/{anchor}/reorder",
        json={"machine_id": machine_id, "ordered_ids": block_ids, "recalculate": True},
    )
    inline_ms = (time.perf_counter() - t0) * 1000
    print(f"reorder + inline recalc: {inline_ms:.0f}ms status={res3.status_code}")
    if res3.status_code == 200:
        payload = res3.get_json() or {}
        refresh = payload.get("machine_refresh") or {}
        print(f"  lite={refresh.get('lite')} blocks={len(refresh.get('blocks') or [])}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
