"""Simulate planner interval scheduling for a single block."""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta

STANDARD_WORK_START_MINUTE = 8 * 60 + 30
STANDARD_WORK_END_MINUTE = 20 * 60
WEEKDAY_LUNCH_START_MINUTE = 12 * 60
WEEKDAY_LUNCH_END_MINUTE = 12 * 60 + 45
WEEKDAY_COFFEE_START_MINUTE = 16 * 60
WEEKDAY_COFFEE_END_MINUTE = 16 * 60 + 15


def minute_to_dt(work_day: date, minute: int) -> datetime:
    return datetime.combine(work_day, datetime.min.time()) + timedelta(minutes=minute)


def intervals_for_day(work_day: date):
    if work_day.weekday() in (5, 6):
        return []
    return [
        (
            minute_to_dt(work_day, STANDARD_WORK_START_MINUTE),
            minute_to_dt(work_day, WEEKDAY_LUNCH_START_MINUTE),
        ),
        (
            minute_to_dt(work_day, WEEKDAY_LUNCH_END_MINUTE),
            minute_to_dt(work_day, WEEKDAY_COFFEE_START_MINUTE),
        ),
        (
            minute_to_dt(work_day, WEEKDAY_COFFEE_END_MINUTE),
            minute_to_dt(work_day, STANDARD_WORK_END_MINUTE),
        ),
    ]


def next_interval_after(current_dt: datetime):
    probe = current_dt.date()
    for _ in range(365):
        for start_dt, end_dt in intervals_for_day(probe):
            if end_dt <= current_dt:
                continue
            if start_dt >= current_dt:
                return start_dt, end_dt
            if start_dt <= current_dt < end_dt:
                return current_dt, end_dt
        probe += timedelta(days=1)
        current_dt = datetime.combine(probe, datetime.min.time())
    return None, None


def schedule_setup(start_dt: datetime, remaining_setup: float):
    current_dt = start_dt
    segments = []
    remaining = float(remaining_setup)
    while remaining > 0:
        interval_start, interval_end = next_interval_after(current_dt)
        if not interval_start:
            break
        if current_dt < interval_start:
            current_dt = interval_start
        available = max(0.0, (interval_end - current_dt).total_seconds() / 60.0)
        if available <= 0:
            current_dt = interval_end
            continue
        use = min(remaining, available)
        seg_end = current_dt + timedelta(minutes=use)
        segments.append(("setup", current_dt, seg_end, use))
        remaining -= use
        current_dt = seg_end
    return current_dt, segments


def schedule_prod(start_dt: datetime, remaining_qty: float, cycle_time: float):
    current_dt = start_dt
    segments = []
    remaining = float(remaining_qty)
    while remaining > 0:
        interval_start, interval_end = next_interval_after(current_dt)
        if not interval_start:
            break
        if current_dt < interval_start:
            current_dt = interval_start
        available = max(0.0, (interval_end - current_dt).total_seconds() / 60.0)
        if available <= 0:
            current_dt = interval_end
            continue
        qty = min(remaining, math.floor(available / cycle_time))
        if qty <= 0:
            current_dt = interval_end
            continue
        use = qty * cycle_time
        seg_end = current_dt + timedelta(minutes=use)
        segments.append(("production", current_dt, seg_end, qty, use))
        remaining -= qty
        current_dt = seg_end
    return current_dt, segments


def main():
    start = datetime(2026, 6, 11, 15, 30)
    setup_end, setup_segments = schedule_setup(start, 180)
    block_end, prod_segments = schedule_prod(setup_end, 55, 20)

    print(f"Queued (assumed): {start}")
    print(f"Setup ends:       {setup_end}")
    print(f"Block ends:       {block_end}")
    print()
    print("Setup segments:")
    for row in setup_segments:
        print(f"  {row[1]} -> {row[2]} ({row[3]:.0f} min)")
    print("Production segments:")
    total_prod_min = 0
    total_qty = 0
    for row in prod_segments:
        total_prod_min += row[4]
        total_qty += row[3]
        print(f"  {row[1]} -> {row[2]} qty={row[3]:.0f} ({row[4]:.0f} min)")
    print(f"Total qty scheduled: {total_qty}, minutes: {total_prod_min}")

    thu = date(2026, 6, 11)
    thu_mins = 0
    for s, e in intervals_for_day(thu):
        seg_start = max(s, start)
        if e > seg_start:
            thu_mins += (e - seg_start).total_seconds() / 60
    print(f"\nThu productive minutes from 15:30: {thu_mins:.0f}")
    print(f"Fri productive minutes: {sum((e-s).total_seconds()/60 for s,e in intervals_for_day(date(2026,6,12))):.0f}")

    # naive user model
    remaining = 1280 - thu_mins - 630
    mon_end_naive = datetime(2026, 6, 15, 8, 30) + timedelta(minutes=remaining)
    print(f"\nUser-style naive end (no interval/qty floor): {mon_end_naive}")


if __name__ == "__main__":
    main()
