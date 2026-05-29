"""
planning/machines.py — machine capacity helpers (PostgreSQL port of Vanessa's machines.py).

Key differences from the SQLite original:
  - Table names are planner_* prefixed.
  - machine_code column renamed to machine_no; SELECTs alias it as machine_code
    so downstream code that does row["machine_code"] keeps working.
  - active = TRUE instead of active = 1.
  - %s placeholders (SQLite ? auto-converted by PlannerCon, but we write %s
    directly here for clarity since it's a new file).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from .helpers import one, rows
from .scheduler_state import active_calendar_windows_for_machine_day
from .utils import compact_text


STANDARD_WORK_START_MINUTE = 8 * 60 + 30
STANDARD_WORK_END_MINUTE = 20 * 60
SATURDAY_WORK_END_MINUTE = 16 * 60 + 15
WEEKDAY_LUNCH_START_MINUTE = 12 * 60
WEEKDAY_LUNCH_END_MINUTE = 12 * 60 + 45
WEEKDAY_COFFEE_START_MINUTE = 16 * 60
WEEKDAY_COFFEE_END_MINUTE = 16 * 60 + 15
DAY_END_MINUTE = 24 * 60
BLOCKING_WINDOW_TYPES = {"DOWN", "MAINTENANCE", "HOLIDAY", "BLOCKED"}
ADDING_WINDOW_TYPES = {"OVERTIME", "AVAILABLE"}


def default_profile_for_weekday(weekday, shift_profile="STANDARD"):
    if weekday == 6:
        return "OFF"
    if weekday == 5:
        # Business rule: exclude Saturdays from default planning.
        return "OFF"
    if compact_text(shift_profile).upper() == "24HR":
        return "FULL_24H"
    return "NORMAL_DAY_NIGHT"


def minutes_to_time_text(minutes):
    value = max(0, min(DAY_END_MINUTE, int(round(float(minutes or 0)))))
    if value == DAY_END_MINUTE:
        return "24:00"
    return f"{value // 60:02d}:{value % 60:02d}"


def datetime_for_date_minute(date_iso, minute):
    work_day = date.fromisoformat(str(date_iso))
    minute_value = max(0, min(DAY_END_MINUTE, int(round(float(minute or 0)))))
    return datetime.combine(work_day, datetime.min.time()) + timedelta(minutes=minute_value)


def _machine_shift_profile(con, machine_id):
    row = one(
        con.execute(
            "SELECT machine_id, shift_profile FROM planner_machines WHERE machine_id = %s",
            (int(machine_id),),
        )
    )
    return compact_text(row["shift_profile"]) if row else ""


def machine_capacity_details_for_date(con, machine_id, work_date):
    work_day = work_date
    row = one(
        con.execute(
            """
            SELECT d.day_id, d.machine_id, d.work_date, d.profile_id,
                   d.capacity_minutes, d.start_minute, d.note, p.profile_name
            FROM planner_machine_capacity_day d
            JOIN planner_capacity_profile p ON p.profile_id = d.profile_id
            WHERE d.machine_id = %s AND d.work_date = %s
            """,
            (int(machine_id), work_day.strftime("%Y-%m-%d")),
        )
    )
    if row:
        return {
            "profile_name": row["profile_name"],
            "capacity_minutes": int(row["capacity_minutes"] or 0),
            "start_minute": int(row["start_minute"] or 0),
            "note": row["note"] or "",
            "has_capacity_day_override": True,
        }

    if work_day.weekday() == 6 or is_public_holiday(con, work_day):
        profile = one(
            con.execute(
                "SELECT * FROM planner_capacity_profile WHERE profile_name = %s",
                ("OFF",),
            )
        )
        if profile:
            return {
                "profile_name": profile["profile_name"],
                "capacity_minutes": int(profile["capacity_minutes"] or 0),
                "start_minute": int(profile["start_minute"] or 0),
                "note": profile["note"] or "",
                "has_capacity_day_override": False,
            }
        return {"profile_name": "OFF", "capacity_minutes": 0, "start_minute": 0, "note": "", "has_capacity_day_override": False}

    machine_shift_profile = _machine_shift_profile(con, machine_id) or "STANDARD"
    profile_name = default_profile_for_weekday(work_day.weekday(), machine_shift_profile)
    profile = one(
        con.execute(
            "SELECT * FROM planner_capacity_profile WHERE profile_name = %s",
            (profile_name,),
        )
    )
    if not profile:
        profile = one(con.execute("SELECT * FROM planner_capacity_profile ORDER BY profile_id LIMIT 1"))
    if not profile:
        return {"profile_name": profile_name, "capacity_minutes": 0, "start_minute": 0, "note": "", "has_capacity_day_override": False}
    return {
        "profile_name": profile["profile_name"],
        "capacity_minutes": int(profile["capacity_minutes"] or 0),
        "start_minute": int(profile["start_minute"] or 0),
        "note": profile["note"] or "",
        "has_capacity_day_override": False,
    }


def machine_capacity_for_date(con, machine_id, work_date):
    return machine_capacity_details_for_date(con, machine_id, work_date)


def is_public_holiday(con, work_date):
    row = one(
        con.execute(
            "SELECT holiday_date FROM planner_public_holiday WHERE holiday_date = %s",
            (work_date.strftime("%Y-%m-%d"),),
        )
    )
    return row is not None


def _minute_to_datetime(work_day, minute):
    minute_value = max(0, min(DAY_END_MINUTE, int(round(float(minute or 0)))))
    return datetime.combine(work_day, datetime.min.time()) + timedelta(minutes=minute_value)


def _intervals_to_minutes(intervals):
    total = 0.0
    for start_dt, end_dt in intervals:
        if start_dt and end_dt and end_dt > start_dt:
            total += (end_dt - start_dt).total_seconds() / 60.0
    return total


def _merge_intervals(intervals):
    cleaned = sorted(
        [(s, e) for s, e in intervals if s and e and e > s],
        key=lambda item: item[0],
    )
    if not cleaned:
        return []
    merged = [cleaned[0]]
    for start, end in cleaned[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _subtract_interval(base_intervals, cut_start, cut_end):
    if not cut_start or not cut_end or cut_end <= cut_start:
        return list(base_intervals)
    result = []
    for start, end in base_intervals:
        if end <= cut_start or start >= cut_end:
            result.append((start, end))
            continue
        if start < cut_start:
            result.append((start, min(cut_start, end)))
        if end > cut_end:
            result.append((max(cut_end, start), end))
    return _merge_intervals(result)


def _add_interval(base_intervals, add_start, add_end):
    if not add_start or not add_end or add_end <= add_start:
        return list(base_intervals)
    return _merge_intervals([*base_intervals, (add_start, add_end)])


def machine_work_intervals_for_day(con, machine_id, work_date):
    work_day = work_date if isinstance(work_date, date) else date.fromisoformat(str(work_date))
    machine = (
        one(
            con.execute(
                "SELECT machine_id, shift_profile FROM planner_machines WHERE machine_id = %s",
                (int(machine_id),),
            )
        )
        if machine_id
        else None
    )
    machine_shift_profile = compact_text(machine["shift_profile"]) if machine else ""
    cap = machine_capacity_details_for_date(con, machine_id, work_day)
    base_intervals = []
    if cap and bool(cap.get("has_capacity_day_override")):
        if int(cap.get("capacity_minutes") or 0) > 0:
            start_minute = int(cap.get("start_minute") or 0)
            end_minute = min(DAY_END_MINUTE, start_minute + int(cap.get("capacity_minutes") or 0))
            base_intervals = [(_minute_to_datetime(work_day, start_minute), _minute_to_datetime(work_day, end_minute))]
        else:
            base_intervals = []
    elif cap and int(cap.get("capacity_minutes") or 0) > 0:
        start_minute = int(cap.get("start_minute") or 0)
        end_minute = min(DAY_END_MINUTE, start_minute + int(cap.get("capacity_minutes") or 0))
        base_intervals = [(_minute_to_datetime(work_day, start_minute), _minute_to_datetime(work_day, end_minute))]
    elif work_day.weekday() == 6 or is_public_holiday(con, work_day):
        base_intervals = []
    elif work_day.weekday() == 5 and compact_text((cap or {}).get("profile_name")).upper() == "SATURDAY":
        base_intervals = [
            (_minute_to_datetime(work_day, STANDARD_WORK_START_MINUTE), _minute_to_datetime(work_day, WEEKDAY_LUNCH_START_MINUTE)),
            (_minute_to_datetime(work_day, WEEKDAY_LUNCH_END_MINUTE), _minute_to_datetime(work_day, SATURDAY_WORK_END_MINUTE)),
        ]
    elif work_day.weekday() == 5:
        # Default planning skips Saturday; explicit SATURDAY capacity profile enables catch-up only.
        base_intervals = []
    elif machine_shift_profile.upper() == "24HR":
        base_intervals = [(_minute_to_datetime(work_day, 0), _minute_to_datetime(work_day, DAY_END_MINUTE))]
    else:
        base_intervals = [
            (_minute_to_datetime(work_day, STANDARD_WORK_START_MINUTE), _minute_to_datetime(work_day, WEEKDAY_LUNCH_START_MINUTE)),
            (_minute_to_datetime(work_day, WEEKDAY_LUNCH_END_MINUTE), _minute_to_datetime(work_day, WEEKDAY_COFFEE_START_MINUTE)),
            (_minute_to_datetime(work_day, WEEKDAY_COFFEE_END_MINUTE), _minute_to_datetime(work_day, STANDARD_WORK_END_MINUTE)),
        ]

    calendar_windows = (
        list(active_calendar_windows_for_machine_day(con, machine_id, work_day))
        if con and machine_id
        else []
    )
    for window in calendar_windows:
        window_type = compact_text(window["window_type"]).upper()
        start_dt = datetime.fromisoformat(str(window["start_at"]).replace("T", " "))
        end_dt = datetime.fromisoformat(str(window["end_at"]).replace("T", " "))
        if window_type in BLOCKING_WINDOW_TYPES:
            base_intervals = _subtract_interval(base_intervals, start_dt, end_dt)
        elif window_type in ADDING_WINDOW_TYPES:
            base_intervals = _add_interval(base_intervals, start_dt, end_dt)

    return _merge_intervals(base_intervals)


def capacity_minutes_for_machine_day(con, machine_id, work_date):
    cap = machine_capacity_for_date(con, machine_id, work_date)
    intervals = machine_work_intervals_for_day(con, machine_id, work_date)
    return {
        "profile_name": cap["profile_name"],
        "capacity_minutes": int(round(_intervals_to_minutes(intervals))),
        "start_minute": int(cap["start_minute"] or 0),
        "note": cap.get("note", ""),
        "has_capacity_day_override": bool(cap.get("has_capacity_day_override")),
    }


def fetch_machines(con):
    """Return all active machines. Aliases machine_no as machine_code for compatibility."""
    return rows(
        con.execute(
            """
            SELECT machine_id, machine_no AS machine_code, machine_no,
                   machine_category, shift_profile, active
            FROM planner_machines
            WHERE active = TRUE
            ORDER BY machine_id
            """
        )
    )


def fetch_profiles(con):
    return rows(
        con.execute(
            "SELECT profile_id, profile_name, capacity_minutes, start_minute, note FROM planner_capacity_profile ORDER BY profile_id"
        )
    )


def shift_windows_for_machine_day(machine, date_iso, con=None):
    work_day = date.fromisoformat(str(date_iso))
    machine = machine or {}
    shift_profile = compact_text(machine.get("shift_profile") or "")
    machine_id = int(machine.get("machine_id") or 0)
    cap = machine_capacity_details_for_date(con, machine_id, work_day) if con and machine_id else None
    if cap and bool(cap.get("has_capacity_day_override")):
        if int(cap.get("capacity_minutes") or 0) > 0:
            start_minute = int(cap.get("start_minute") or 0)
            end_minute = min(DAY_END_MINUTE, start_minute + int(cap.get("capacity_minutes") or 0))
            if end_minute > start_minute:
                return [
                    {
                        "kind": "override",
                        "start_minute": start_minute,
                        "end_minute": end_minute,
                        "start_datetime": datetime_for_date_minute(date_iso, start_minute).strftime("%Y-%m-%d %H:%M:%S"),
                        "end_datetime": datetime_for_date_minute(date_iso, end_minute).strftime("%Y-%m-%d %H:%M:%S"),
                        "reason": "Capacity override",
                    }
                ]
        return []

    if work_day.weekday() == 6:
        return []
    if work_day.weekday() == 5 and compact_text((cap or {}).get("profile_name")).upper() == "SATURDAY":
        return [
            {
                "kind": "standard",
                "start_minute": STANDARD_WORK_START_MINUTE,
                "end_minute": WEEKDAY_LUNCH_START_MINUTE,
                "start_datetime": datetime_for_date_minute(date_iso, STANDARD_WORK_START_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                "end_datetime": datetime_for_date_minute(date_iso, WEEKDAY_LUNCH_START_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                "reason": "Saturday shift",
            },
            {
                "kind": "standard",
                "start_minute": WEEKDAY_LUNCH_END_MINUTE,
                "end_minute": SATURDAY_WORK_END_MINUTE,
                "start_datetime": datetime_for_date_minute(date_iso, WEEKDAY_LUNCH_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                "end_datetime": datetime_for_date_minute(date_iso, SATURDAY_WORK_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                "reason": "Saturday shift",
            },
        ]
    if work_day.weekday() == 5:
        return []
    if shift_profile == "24HR":
        return [
            {
                "kind": "full",
                "start_minute": 0,
                "end_minute": DAY_END_MINUTE,
                "start_datetime": datetime_for_date_minute(date_iso, 0).strftime("%Y-%m-%d %H:%M:%S"),
                "end_datetime": datetime_for_date_minute(date_iso, DAY_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                "reason": "24HR shift",
            }
        ]
    return [
        {
            "kind": "standard",
            "start_minute": STANDARD_WORK_START_MINUTE,
            "end_minute": WEEKDAY_LUNCH_START_MINUTE,
            "start_datetime": datetime_for_date_minute(date_iso, STANDARD_WORK_START_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
            "end_datetime": datetime_for_date_minute(date_iso, WEEKDAY_LUNCH_START_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
            "reason": "Weekday shift",
        },
        {
            "kind": "standard",
            "start_minute": WEEKDAY_LUNCH_END_MINUTE,
            "end_minute": WEEKDAY_COFFEE_START_MINUTE,
            "start_datetime": datetime_for_date_minute(date_iso, WEEKDAY_LUNCH_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
            "end_datetime": datetime_for_date_minute(date_iso, WEEKDAY_COFFEE_START_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
            "reason": "Weekday shift",
        },
        {
            "kind": "standard",
            "start_minute": WEEKDAY_COFFEE_END_MINUTE,
            "end_minute": STANDARD_WORK_END_MINUTE,
            "start_datetime": datetime_for_date_minute(date_iso, WEEKDAY_COFFEE_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
            "end_datetime": datetime_for_date_minute(date_iso, STANDARD_WORK_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
            "reason": "Weekday shift",
        },
    ]


def gantt_off_time_blocks(machines, dates, con=None):
    blocks = []
    for machine in machines or []:
        machine_id = int(machine.get("machine_id") or 0)
        if not machine_id:
            continue
        machine_code = compact_text(machine.get("machine_no") or machine.get("machine_code") or "")
        for work_date_text in dates or []:
            work_day = date.fromisoformat(str(work_date_text))
            for window in _off_windows_for_machine_day(machine, work_date_text, con):
                blocks.append(
                    {
                        "machine_id": machine_id,
                        "machine_code": machine_code,
                        "date": work_date_text,
                        "start_min": int(window.get("start_minute") or 0),
                        "end_min": int(window.get("end_minute") or 0),
                        "start_datetime": window.get("start_datetime") or "",
                        "end_datetime": window.get("end_datetime") or "",
                        "reason": window.get("reason") or "",
                        "kind": window.get("kind") or "",
                        "title": window.get("title") or "",
                    }
                )
    return blocks


def _off_windows_for_machine_day(machine, date_iso, con=None):
    work_day = date.fromisoformat(str(date_iso))
    machine = machine or {}
    shift_profile = compact_text(machine.get("shift_profile") or "")
    machine_id = int(machine.get("machine_id") or 0)
    cap = machine_capacity_details_for_date(con, machine_id, work_day) if con and machine_id else None

    if cap and bool(cap.get("has_capacity_day_override")) and int(cap.get("capacity_minutes") or 0) <= 0:
        return [{"kind": "override", "start_minute": 0, "end_minute": DAY_END_MINUTE,
                 "start_datetime": datetime_for_date_minute(date_iso, 0).strftime("%Y-%m-%d %H:%M:%S"),
                 "end_datetime": datetime_for_date_minute(date_iso, DAY_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                 "reason": "Capacity override off", "title": "Capacity override off"}]

    if cap and int(cap.get("capacity_minutes") or 0) <= 0:
        kind = "sunday" if work_day.weekday() == 6 else "override"
        reason = "Sunday off" if kind == "sunday" else "Capacity override off"
        return [{"kind": kind, "start_minute": 0, "end_minute": DAY_END_MINUTE,
                 "start_datetime": datetime_for_date_minute(date_iso, 0).strftime("%Y-%m-%d %H:%M:%S"),
                 "end_datetime": datetime_for_date_minute(date_iso, DAY_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                 "reason": reason, "title": reason}]

    if work_day.weekday() == 6 and not (cap and bool(cap.get("has_capacity_day_override"))):
        return [{"kind": "sunday", "start_minute": 0, "end_minute": DAY_END_MINUTE,
                 "start_datetime": datetime_for_date_minute(date_iso, 0).strftime("%Y-%m-%d %H:%M:%S"),
                 "end_datetime": datetime_for_date_minute(date_iso, DAY_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                 "reason": "Sunday off", "title": "Sunday off"}]

    work_windows = shift_windows_for_machine_day(machine, date_iso, con)
    if not work_windows:
        return [{"kind": "sunday", "start_minute": 0, "end_minute": DAY_END_MINUTE,
                 "start_datetime": datetime_for_date_minute(date_iso, 0).strftime("%Y-%m-%d %H:%M:%S"),
                 "end_datetime": datetime_for_date_minute(date_iso, DAY_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                 "reason": "Sunday off", "title": "Sunday off"}]

    blocks = []
    work_start = min(int(w["start_minute"]) for w in work_windows)
    work_end = max(int(w["end_minute"]) for w in work_windows)
    if work_start > 0:
        blocks.append({"kind": "off_shift", "start_minute": 0, "end_minute": work_start,
                        "start_datetime": datetime_for_date_minute(date_iso, 0).strftime("%Y-%m-%d %H:%M:%S"),
                        "end_datetime": datetime_for_date_minute(date_iso, work_start).strftime("%Y-%m-%d %H:%M:%S"),
                        "reason": "Before shift", "title": f"Off shift: 00:00-{minutes_to_time_text(work_start)}"})

    if shift_profile != "24HR":
        for bstart, bend, reason, kind in [
            (WEEKDAY_LUNCH_START_MINUTE, WEEKDAY_LUNCH_END_MINUTE, "Lunch break", "lunch"),
            (WEEKDAY_COFFEE_START_MINUTE, WEEKDAY_COFFEE_END_MINUTE, "Coffee break", "coffee"),
        ]:
            if bend > work_start and bstart < work_end and work_day.weekday() != 5 or (
                kind == "lunch" and work_day.weekday() == 5
            ):
                if bend > work_start and bstart < work_end:
                    blocks.append({"kind": kind, "start_minute": bstart, "end_minute": bend,
                                   "start_datetime": datetime_for_date_minute(date_iso, bstart).strftime("%Y-%m-%d %H:%M:%S"),
                                   "end_datetime": datetime_for_date_minute(date_iso, bend).strftime("%Y-%m-%d %H:%M:%S"),
                                   "reason": reason, "title": f"{reason}: {minutes_to_time_text(bstart)}-{minutes_to_time_text(bend)}"})

    if work_end < DAY_END_MINUTE:
        blocks.append({"kind": "off_shift", "start_minute": work_end, "end_minute": DAY_END_MINUTE,
                        "start_datetime": datetime_for_date_minute(date_iso, work_end).strftime("%Y-%m-%d %H:%M:%S"),
                        "end_datetime": datetime_for_date_minute(date_iso, DAY_END_MINUTE).strftime("%Y-%m-%d %H:%M:%S"),
                        "reason": "After shift", "title": f"Off shift: {minutes_to_time_text(work_end)}-24:00"})
    return blocks
