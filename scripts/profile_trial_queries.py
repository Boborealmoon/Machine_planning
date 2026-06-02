"""Profile SQL hotspots for trial schedule endpoints.

Usage:
  python scripts/profile_trial_queries.py
"""
from __future__ import annotations

import re
import sys
import time
from collections import defaultdict
from contextlib import contextmanager

sys.path.insert(0, ".")

from flask import Flask

from planning.helpers import PlannerCon, planner_db, rows
from planning.planner_routes import _api_trial_schedule_db


def _normalize_sql(sql: str) -> str:
    text = " ".join((sql or "").strip().split())
    text = re.sub(r"\s+", " ", text)
    return text[:500]


@contextmanager
def capture_query_timings():
    stats = defaultdict(lambda: {"count": 0, "total_ms": 0.0, "max_ms": 0.0, "sql": ""})
    original_execute = PlannerCon.execute

    def timed_execute(self, sql, params=None):
        t0 = time.perf_counter()
        try:
            return original_execute(self, sql, params)
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            key = _normalize_sql(sql)
            entry = stats[key]
            entry["count"] += 1
            entry["total_ms"] += elapsed_ms
            entry["max_ms"] = max(entry["max_ms"], elapsed_ms)
            entry["sql"] = key

    PlannerCon.execute = timed_execute
    try:
        yield stats
    finally:
        PlannerCon.execute = original_execute


def print_top(stats, label, n=15):
    ordered = sorted(stats.values(), key=lambda x: x["total_ms"], reverse=True)
    print(f"\n=== {label} | Top {n} by total_ms ===")
    for row in ordered[:n]:
        avg = row["total_ms"] / max(1, row["count"])
        print(
            f"- total={row['total_ms']:.2f}ms count={row['count']} avg={avg:.2f}ms max={row['max_ms']:.2f}ms\n"
            f"  {row['sql']}"
        )


def run_profile(path: str, label: str):
    app = Flask(__name__)
    with capture_query_timings() as stats:
        with app.test_request_context(path):
            t0 = time.perf_counter()
            resp = _api_trial_schedule_db()
            elapsed = (time.perf_counter() - t0) * 1000.0
            payload = resp.get_json() or {}
    print(
        f"\n{label}: {elapsed:.2f}ms | blocks={len(payload.get('blocks', []))} "
        f"segments={len(payload.get('segments', []))} actuals={len(payload.get('actuals', []))}"
    )
    print_top(stats, label)


def first_machine_id() -> int:
    with planner_db() as con:
        items = rows(con.execute("SELECT machine_id FROM planner_machines WHERE active = TRUE ORDER BY machine_id LIMIT 1"))
        return int(items[0]["machine_id"]) if items else 0


def main():
    mid = first_machine_id()
    run_profile("/api/trial/schedule?lite=1", "board lite")
    if mid:
        run_profile(f"/api/trial/schedule?lite=1&machine_ids={mid}", "machine scoped lite")
    run_profile("/api/trial/schedule?lite=1&include=actual_daily", "board lite + actual_daily")


if __name__ == "__main__":
    main()
