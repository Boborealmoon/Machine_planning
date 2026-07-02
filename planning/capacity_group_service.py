"""Machine capacity sheet — group matrix by capacity planning basis."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta

from .capacity_monthly_service import _block_filter_sql, _pct
from .helpers import rows
from .machines import fetch_machines, is_public_holiday
from .utils import compact_text, planner_today

CAPACITY_BASIS_MODES = ("rest_of_month", "calendar_month", "rolling_period")

CAPACITY_GROUP_DEFS: tuple[dict, ...] = (
    {
        "key": "cnc41",
        "label": "CNC 41",
        "subtitle": "I-800",
        "categories": (),
        "machine_codes": ("CNC 41",),
        "display_order": 5,
    },
    {
        "key": "mpp",
        "label": "MPP",
        "subtitle": None,
        "categories": ("MPP",),
        "machine_codes": (),
        "display_order": 1,
    },
    {
        "key": "multiaxis",
        "label": "Multi-Axis",
        "subtitle": None,
        "categories": ("TURNMILL",),
        "machine_codes": (),
        "display_order": 2,
    },
    {
        "key": "turning",
        "label": "CNC TN",
        "subtitle": None,
        "categories": ("TURNING",),
        "machine_codes": (),
        "exclude_machine_codes": ("CNC 41",),
        "display_order": 3,
    },
    {
        "key": "milling",
        "label": "CNC ML",
        "subtitle": None,
        "categories": ("MILLING",),
        "machine_codes": (),
        "display_order": 4,
    },
)

CAPACITY_GROUP_DISPLAY_ORDER = sorted(CAPACITY_GROUP_DEFS, key=lambda d: int(d.get("display_order") or 99))

WORK_HOURS_REFERENCE = (
    {"label": "Normal Shift", "hours": "0830 – 2000 hrs"},
    {"label": "24 Hours", "hours": "0730 – 0730 hrs"},
    {"label": "Full 24 Hours", "hours": "0730 – 0730 hrs"},
)

CAPACITY_DEFINITIONS = (
    {
        "term": "Effective Machine Capacity",
        "text": (
            "Realistic capacity based on planned regular operating hours (e.g. a standard 40-hour workweek), "
            "accounting for inevitable downtime. Normal shift is 0830–2000 hrs (10.5 working hours per machine per weekday)."
        ),
    },
    {
        "term": "Maximum (Design) Capacity",
        "text": (
            "Includes Saturday overtime. The absolute highest possible output if the facility runs at full speed "
            "including Saturday shifts. This level is unsustainable."
        ),
    },
    {
        "term": "Reported Machine Capacity",
        "text": "Based on the Effective Machine Capacity.",
    },
    {
        "term": "Saturday Over-time",
        "text": "Number of Saturdays in the active capacity window.",
    },
)


def _machine_code(machine: dict) -> str:
    return compact_text(machine.get("machine_code") or machine.get("machine_no"))


def default_planning_month(as_of: date | None = None) -> tuple[int, int]:
    today = as_of or planner_today()
    if today.day >= 23:
        if today.month == 12:
            return today.year + 1, 1
        return today.year, today.month + 1
    return today.year, today.month


def planning_period(year: int, month: int) -> tuple[date, date]:
    year = int(year)
    month = int(month)
    if month == 1:
        start = date(year - 1, 12, 23)
    else:
        start = date(year, month - 1, 23)
    end = date(year, month, 22)
    return start, end


def planning_month_label(year: int, month: int) -> str:
    end = date(int(year), int(month), 22)
    return end.strftime("%b-%y")


def calendar_month_label(year: int, month: int) -> str:
    return date(int(year), int(month), 1).strftime("%b-%y")


def calendar_month_bounds(year: int, month: int) -> tuple[date, date]:
    year = int(year)
    month = int(month)
    start = date(year, month, 1)
    last_day = calendar.monthrange(year, month)[1]
    return start, date(year, month, last_day)


def parse_capacity_basis(raw: str) -> str:
    text = compact_text(raw).lower()
    if text in {"rest", "rest_of_month", "remainder", "remaining", "month_remaining", "forecast", "forward"}:
        return "rest_of_month"
    if text in {"calendar", "calendar_month", "prospective", "prospective_month", "month", "queue"}:
        return "calendar_month"
    if text in {"rolling", "rolling_period", "planning_period", "plan", "period"}:
        return "rolling_period"
    return "rolling_period"


def capacity_basis_label(basis: str) -> str:
    return {
        "rest_of_month": "Rest of this month (from today)",
        "calendar_month": "Calendar month (1st → last day)",
        "rolling_period": "Rolling period (23rd → 22nd)",
    }.get(basis, basis)


def resolve_capacity_basis_window(basis: str, year: int, month: int, as_of: date) -> dict:
    """
    Three capacity views:
    - rest_of_month: today → end of selected calendar month (only when that month is "now")
    - calendar_month: 1st → last day of selected calendar month
    - rolling_period: 23rd of prior month → 22nd of selected month
    """
    basis = parse_capacity_basis(basis)
    year = int(year)
    month = int(month)
    warning = ""

    if basis == "rolling_period":
        start, end = planning_period(year, month)
        return {
            "basis": basis,
            "basis_label": capacity_basis_label(basis),
            "capacity_start": start,
            "capacity_end": end,
            "segment_start": start,
            "segment_end": end,
            "display_label": planning_month_label(year, month),
            "warning": warning,
        }

    cal_start, cal_end = calendar_month_bounds(year, month)
    if basis == "calendar_month":
        return {
            "basis": basis,
            "basis_label": capacity_basis_label(basis),
            "capacity_start": cal_start,
            "capacity_end": cal_end,
            "segment_start": cal_start,
            "segment_end": cal_end,
            "display_label": calendar_month_label(year, month),
            "warning": warning,
        }

    # rest_of_month
    if (as_of.year, as_of.month) == (year, month):
        return {
            "basis": basis,
            "basis_label": capacity_basis_label(basis),
            "capacity_start": as_of,
            "capacity_end": cal_end,
            "segment_start": as_of,
            "segment_end": cal_end,
            "display_label": calendar_month_label(year, month),
            "warning": warning,
        }
    if as_of < cal_start:
        warning = (
            f"{calendar_month_label(year, month)} has not started yet — "
            "switch to Calendar month or Rolling period to plan ahead."
        )
        return {
            "basis": basis,
            "basis_label": capacity_basis_label(basis),
            "capacity_start": cal_start,
            "capacity_end": cal_end,
            "segment_start": cal_start,
            "segment_end": cal_end,
            "display_label": calendar_month_label(year, month),
            "warning": warning,
        }
    warning = f"{calendar_month_label(year, month)} has ended — showing the full calendar month."
    return {
        "basis": basis,
        "basis_label": capacity_basis_label(basis),
        "capacity_start": cal_start,
        "capacity_end": cal_end,
        "segment_start": cal_start,
        "segment_end": cal_end,
        "display_label": calendar_month_label(year, month),
        "warning": warning,
    }


def _capacity_basis_notes(basis: str, window: dict, as_of: date, *, saturday_ot_hours: float = 7.0) -> list[str]:
    start = window["capacity_start"].isoformat()
    end = window["capacity_end"].isoformat()
    if basis == "rest_of_month" and (as_of.year, as_of.month) == (window["capacity_end"].year, window["capacity_end"].month):
        notes = [
            f"Rest of month: capacity and open queue load from today ({as_of.isoformat()}) through {end}.",
            "Use this while you are inside the selected calendar month to see what is left to run.",
        ]
    elif basis == "calendar_month":
        notes = [
            f"Calendar month: full window {start} → {end}.",
            "Plan usage is the open queue (excludes completed ops) with segments scheduled in this month.",
            "Use this for a prospective month (e.g. all of July) based on the queue as of today.",
        ]
    else:
        notes = [
            f"Rolling period: {start} → {end} (23rd of prior month through 22nd of selected month).",
            "Plan usage is the open queue scheduled anywhere in this rolling month.",
        ]
    if window.get("warning"):
        notes.append(window["warning"])
    notes.extend(
        [
            "Weekdays less PH counts Mon–Fri in the active window, excluding Singapore public holidays.",
            f"Saturday overtime uses the SATURDAY capacity profile ({saturday_ot_hours} h per machine).",
            "Machine plan usage is summed from planner segments in the active window (including MPP planner lanes).",
            "Completed operations (DONE/COMPLETED) are excluded from plan usage.",
        ]
    )
    return notes


def _group_matches(definition: dict, machine: dict) -> bool:
    code = _machine_code(machine)
    codes = tuple(compact_text(c) for c in definition.get("machine_codes") or ())
    if codes:
        return code in codes
    exclude = {compact_text(c) for c in definition.get("exclude_machine_codes") or ()}
    if code in exclude:
        return False
    category = compact_text(machine.get("machine_category"))
    return category in {compact_text(c) for c in definition.get("categories") or ()}


def assign_machines_to_groups(machines: list[dict]) -> dict[str, list[dict]]:
    assigned: dict[str, list[dict]] = {definition["key"]: [] for definition in CAPACITY_GROUP_DEFS}
    claimed: set[int] = set()
    for definition in CAPACITY_GROUP_DEFS:
        key = definition["key"]
        for machine in machines:
            machine_id = int(machine["machine_id"])
            if machine_id in claimed:
                continue
            if _group_matches(definition, machine):
                assigned[key].append(machine)
                claimed.add(machine_id)
    return assigned


def _load_capacity_profiles(con) -> dict[str, dict]:
    profile_rows = rows(
        con.execute(
            "SELECT profile_name, capacity_minutes, start_minute, note FROM planner_capacity_profile"
        )
    )
    return {
        compact_text(row["profile_name"]): {
            "profile_name": compact_text(row["profile_name"]),
            "capacity_minutes": int(row["capacity_minutes"] or 0),
            "capacity_hours": round(int(row["capacity_minutes"] or 0) / 60.0, 2),
            "start_minute": int(row["start_minute"] or 0),
            "note": row["note"] or "",
        }
        for row in profile_rows
    }


def _weekday_hours_for_machine(profiles: dict[str, dict], shift_profile: str) -> float:
    profile_name = "FULL_24H" if compact_text(shift_profile).upper() == "24HR" else "NORMAL_DAY_NIGHT"
    profile = profiles.get(profile_name) or {}
    return float(profile.get("capacity_hours") or 0.0)


def _saturday_ot_hours(profiles: dict[str, dict]) -> float:
    profile = profiles.get("SATURDAY") or {}
    return float(profile.get("capacity_hours") or 0.0)


def _count_period_days(con, start: date, end: date) -> dict:
    weekdays = 0
    saturdays = 0
    public_holidays: list[dict] = []
    day = start
    while day <= end:
        if day.weekday() == 5:
            saturdays += 1
        elif day.weekday() != 6:
            if is_public_holiday(con, day):
                public_holidays.append({"holiday_date": day.isoformat(), "weekday": day.strftime("%a")})
            else:
                weekdays += 1
        day += timedelta(days=1)
    return {
        "weekdays_less_ph": weekdays,
        "saturday_count": saturdays,
        "public_holidays": public_holidays,
        "public_holiday_count": len(public_holidays),
    }


def _hours(minutes: float) -> float:
    return round(float(minutes or 0) / 60.0, 1)


def _build_group_metrics(
  *,
  machines: list[dict],
  profiles: dict[str, dict],
  weekdays_less_ph: int,
  saturday_count: int,
  planned_minutes: float,
) -> dict:
    machine_count = len(machines)
    saturday_ot_hours = _saturday_ot_hours(profiles)

    if machine_count == 0:
        empty = {
            "machine_count": 0,
            "hours_per_machine_per_day": 0.0,
            "hours_per_weekday": 0.0,
            "effective_capacity_hours": 0.0,
            "overtime_one_saturday_hours": 0.0,
            "overtime_capacity_hours": 0.0,
            "maximum_capacity_hours": 0.0,
            "plan_usage_hours": _hours(planned_minutes),
            "plan_usage_minutes": round(planned_minutes, 1),
            "effective_utilization_pct": 0.0,
            "maximum_utilization_pct": 0.0,
        }
        return empty

    per_machine_hours = [_weekday_hours_for_machine(profiles, m.get("shift_profile")) for m in machines]
    hours_per_machine_per_day = per_machine_hours[0] if len(set(per_machine_hours)) == 1 else round(
        sum(per_machine_hours) / machine_count, 2
    )
    hours_per_weekday = round(sum(per_machine_hours), 2)
    effective_capacity_hours = round(hours_per_weekday * weekdays_less_ph, 1)
    overtime_one_saturday_hours = round(saturday_ot_hours * machine_count, 1)
    overtime_capacity_hours = round(overtime_one_saturday_hours * saturday_count, 1)
    maximum_capacity_hours = round(effective_capacity_hours + overtime_capacity_hours, 1)
    plan_usage_hours = _hours(planned_minutes)

    return {
        "machine_count": machine_count,
        "hours_per_machine_per_day": hours_per_machine_per_day,
        "hours_per_weekday": hours_per_weekday,
        "effective_capacity_hours": effective_capacity_hours,
        "overtime_one_saturday_hours": overtime_one_saturday_hours,
        "overtime_capacity_hours": overtime_capacity_hours,
        "maximum_capacity_hours": maximum_capacity_hours,
        "plan_usage_hours": plan_usage_hours,
        "plan_usage_minutes": round(planned_minutes, 1),
        "effective_utilization_pct": _pct(planned_minutes, effective_capacity_hours * 60),
        "maximum_utilization_pct": _pct(planned_minutes, maximum_capacity_hours * 60),
    }


def _group_header_subtitle(definition: dict, machine_count: int) -> str:
    fixed = definition.get("subtitle")
    if fixed:
        return str(fixed)
    if machine_count <= 0:
        return "—"
    return f"{machine_count}X"


def _fetch_planned_minutes_by_machine(
    con,
    machine_ids: list[int],
    segment_start: date,
    segment_end: date,
) -> dict[int, float]:
    if not machine_ids:
        return {}
    block_filter = _block_filter_sql("queue")

    segment_rows = rows(
        con.execute(
            f"""
            SELECT b.machine_id, COALESCE(SUM(s.minutes_used), 0) AS planned_minutes
            FROM planner_run_block_segment s
            JOIN planner_run_block b ON b.block_id = s.block_id
            WHERE {block_filter}
              AND s.segment_date BETWEEN %s AND %s
              AND b.machine_id = ANY(%s)
            GROUP BY b.machine_id
            """,
            (segment_start.isoformat(), segment_end.isoformat(), machine_ids),
        )
    )
    return {int(row["machine_id"]): float(row["planned_minutes"] or 0) for row in segment_rows}


def build_group_capacity_report(
    con,
    year: int,
    month: int,
    *,
    capacity_basis: str = "rest_of_month",
    as_of: date | None = None,
    schedule_mode: str | None = None,
) -> dict:
    basis = parse_capacity_basis(schedule_mode or capacity_basis)
    as_of_date = as_of or planner_today()
    window = resolve_capacity_basis_window(basis, year, month, as_of_date)
    period_start, period_end = planning_period(year, month)
    cal_start, cal_end = calendar_month_bounds(year, month)
    if basis == "rolling_period":
        full_start, full_end = period_start, period_end
    else:
        full_start, full_end = cal_start, cal_end
    day_counts = _count_period_days(con, window["capacity_start"], window["capacity_end"])
    day_counts_full = _count_period_days(con, full_start, full_end)
    profiles = _load_capacity_profiles(con)

    all_machines = [dict(row) for row in fetch_machines(con)]
    grouped = assign_machines_to_groups(all_machines)
    machine_ids = [int(m["machine_id"]) for m in all_machines]
    planned_by_machine = _fetch_planned_minutes_by_machine(
        con,
        machine_ids,
        window["segment_start"],
        window["segment_end"],
    )

    groups = []
    for definition in CAPACITY_GROUP_DISPLAY_ORDER:
        key = definition["key"]
        group_machines = grouped.get(key) or []
        group_machine_ids = {int(m["machine_id"]) for m in group_machines}
        planned_minutes = sum(planned_by_machine.get(mid, 0.0) for mid in group_machine_ids)
        metrics = _build_group_metrics(
            machines=group_machines,
            profiles=profiles,
            weekdays_less_ph=day_counts["weekdays_less_ph"],
            saturday_count=day_counts["saturday_count"],
            planned_minutes=planned_minutes,
        )
        machine_rows = []
        for machine in sorted(group_machines, key=lambda m: _machine_code(m)):
            machine_id = int(machine["machine_id"])
            machine_planned = planned_by_machine.get(machine_id, 0.0)
            machine_metrics = _build_group_metrics(
                machines=[machine],
                profiles=profiles,
                weekdays_less_ph=day_counts["weekdays_less_ph"],
                saturday_count=day_counts["saturday_count"],
                planned_minutes=machine_planned,
            )
            machine_rows.append(
                {
                    "machine_id": machine_id,
                    "machine_code": _machine_code(machine),
                    "machine_category": compact_text(machine.get("machine_category")),
                    "shift_profile": compact_text(machine.get("shift_profile")) or "STANDARD",
                    **machine_metrics,
                }
            )

        groups.append(
            {
                "key": key,
                "label": definition["label"],
                "header_subtitle": _group_header_subtitle(definition, len(group_machines)),
                "machine_count": len(group_machines),
                **metrics,
                "machines": machine_rows,
            }
        )

    normal_profile = profiles.get("NORMAL_DAY_NIGHT") or {}
    full_profile = profiles.get("FULL_24H") or {}
    saturday_profile = profiles.get("SATURDAY") or {}

    notes = _capacity_basis_notes(
        basis,
        window,
        as_of_date,
        saturday_ot_hours=float(saturday_profile.get("capacity_hours") or 7.0),
    )

    is_remaining = basis == "rest_of_month" and (as_of_date.year, as_of_date.month) == (year, month)

    return {
        "report_type": "group_sheet",
        "planning_year": int(year),
        "planning_month": int(month),
        "planning_month_label": window["display_label"],
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "calendar_month_start": cal_start.isoformat(),
        "calendar_month_end": cal_end.isoformat(),
        "capacity_basis": basis,
        "capacity_basis_label": window["basis_label"],
        "capacity_window_mode": "remaining" if is_remaining else "full",
        "capacity_window_label": window["basis_label"],
        "capacity_window_start": window["capacity_start"].isoformat(),
        "capacity_window_end": window["capacity_end"].isoformat(),
        "active_period_start": window["capacity_start"].isoformat(),
        "active_period_end": window["capacity_end"].isoformat(),
        "basis_warning": window.get("warning") or "",
        "weekdays_less_ph": day_counts["weekdays_less_ph"],
        "saturday_count": day_counts["saturday_count"],
        "weekdays_less_ph_full": day_counts_full["weekdays_less_ph"],
        "saturday_count_full": day_counts_full["saturday_count"],
        "public_holiday_count": day_counts["public_holiday_count"],
        "public_holidays": day_counts["public_holidays"],
        "schedule_mode": basis,
        "schedule_mode_label": window["basis_label"],
        "as_of_date": as_of_date.isoformat(),
        "definitions": CAPACITY_DEFINITIONS,
        "work_hours_reference": WORK_HOURS_REFERENCE,
        "shift_profiles": {
            "weekday_standard_hours": normal_profile.get("capacity_hours", 10.5),
            "weekday_24hr_hours": full_profile.get("capacity_hours", 24.0),
            "saturday_overtime_hours": saturday_profile.get("capacity_hours", 7.0),
        },
        "groups": groups,
        "notes": notes,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
