"""planning/scheduler_state.py — calendar-window helpers (PostgreSQL port)."""
from __future__ import annotations

from datetime import timedelta

from .helpers import rows


def active_calendar_windows_for_machine_day(con, machine_id, work_day):
    """Return all active calendar-window rows that overlap the given work_day."""
    day_text = work_day.strftime("%Y-%m-%d")
    next_day_text = (work_day + timedelta(days=1)).strftime("%Y-%m-%d")
    return rows(
        con.execute(
            """
            SELECT *
            FROM planner_machine_calendar_window
            WHERE machine_id = %s
              AND active = TRUE
              AND start_at < %s
              AND end_at > %s
            ORDER BY start_at, window_id
            """,
            (int(machine_id), next_day_text, day_text),
        )
    )
