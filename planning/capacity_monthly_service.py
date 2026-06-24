"""Monthly production capacity — scheduled load vs machine availability."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from .helpers import rows
from .machines import fetch_machines, machine_capacity_details_with_context, prefetch_capacity_context
from .utils import compact_text

SCHEDULE_MODES = ("plan", "queue", "forecast")


def _parse_schedule_mode(raw: str) -> str:
    text = compact_text(raw).lower()
    if text in {"forecast", "forward", "future"}:
        return "forecast"
    if text in {"queue", "remaining", "open"}:
        return "queue"
    return "plan"


def _block_filter_sql(mode: str) -> str:
    active_clause = "COALESCE(b.active, TRUE) = TRUE"
    if mode == "plan":
        return active_clause
    done_clause = (
        "UPPER(REPLACE(REPLACE(COALESCE(b.execution_status, b.status, ''), '-', '_'), ' ', '_')) "
        "NOT IN ('DONE', 'COMPLETED')"
    )
    return f"{active_clause} AND {done_clause}"


def _include_capacity_day(day: date, mode: str, as_of: date, report_year: int) -> bool:
    if mode != "forecast":
        return day.year == report_year
    return day.year == report_year and day >= as_of


def _include_report_month(month: int, report_year: int, mode: str, as_of: date) -> bool:
    if mode != "forecast":
        return True
    if report_year > as_of.year:
        return True
    if report_year < as_of.year:
        return False
    return month >= as_of.month


def _mode_notes(mode: str, as_of: date) -> list[str]:
    notes = [
        "Scheduled load is summed from planner segments (anchor + duration) by segment date.",
        "Weekday totals exclude Saturdays and Sundays; Saturday columns show catch-up / overtime only.",
        "Machine capacity follows planner shift profiles (default planning skips Saturdays unless a SATURDAY profile is set).",
        "Breakdown splits 24-hour MPP (CNC 35/36) from standard day-shift groups (Turning, Milling, Turnmill, CNC 41).",
        "24-hour machines use FULL_24H capacity; standard machines use Mon–Fri day/night windows.",
    ]
    if mode == "plan":
        notes.append(
            "Full plan includes all segments on active queue blocks for the year (including past planned days)."
        )
    elif mode == "queue":
        notes.append(
            "Open queue excludes completed operations (DONE/COMPLETED) that have left the machine lane."
        )
    else:
        notes.append(
            f"Forward forecast counts only from {as_of.isoformat()} onward — completed ops and past days are excluded."
        )
        notes.append("Past months are hidden; totals reflect remaining capacity and open schedule only.")
    return notes


def _mode_label(mode: str) -> str:
    return {
        "plan": "Full year plan",
        "queue": "Open queue",
        "forecast": "Forward forecast",
    }.get(mode, mode)


def _pct(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0 if numerator <= 0 else 100.0
    return round(numerator / denominator * 100.0, 1)


def _hours(minutes: float) -> float:
    return round(float(minutes or 0) / 60.0, 1)


def _new_month_bucket(month: int, year: int) -> dict:
    month_start = date(int(year), month, 1)
    return {
        "month": month,
        "month_key": month_start.strftime("%Y-%m"),
        "month_label": month_start.strftime("%B %Y"),
        "weekday_scheduled_minutes": 0.0,
        "saturday_scheduled_minutes": 0.0,
        "weekday_capacity_minutes": 0,
        "saturday_capacity_minutes": 0,
        "working_days": 0,
        "saturday_days": 0,
    }


def _new_month_grid(year: int) -> dict[int, dict]:
    return {month: _new_month_bucket(month, year) for month in range(1, 13)}


def _count_calendar_day(bucket: dict, is_sat: bool, is_sun: bool) -> None:
    if is_sun:
        return
    if is_sat:
        bucket["saturday_days"] += 1
    else:
        bucket["working_days"] += 1


def _add_capacity(bucket: dict, is_sat: bool, is_sun: bool, mins: int) -> None:
    if is_sat:
        bucket["saturday_capacity_minutes"] += mins
    elif not is_sun:
        bucket["weekday_capacity_minutes"] += mins


def _add_scheduled(bucket: dict, seg_date: date, mins: float) -> None:
    if seg_date.weekday() == 5:
        bucket["saturday_scheduled_minutes"] += mins
    elif seg_date.weekday() != 6:
        bucket["weekday_scheduled_minutes"] += mins


def _finalize_month_row(row: dict) -> dict:
    weekday_sched = round(float(row["weekday_scheduled_minutes"]), 1)
    sat_sched = round(float(row["saturday_scheduled_minutes"]), 1)
    weekday_cap = int(row["weekday_capacity_minutes"])
    sat_cap = int(row["saturday_capacity_minutes"])
    total_sched = weekday_sched + sat_sched
    total_cap = weekday_cap + sat_cap
    return {
        **row,
        "weekday_scheduled_minutes": weekday_sched,
        "saturday_scheduled_minutes": sat_sched,
        "weekday_capacity_minutes": weekday_cap,
        "saturday_capacity_minutes": sat_cap,
        "weekday_scheduled_hours": _hours(weekday_sched),
        "saturday_scheduled_hours": _hours(sat_sched),
        "weekday_capacity_hours": _hours(weekday_cap),
        "saturday_capacity_hours": _hours(sat_cap),
        "total_scheduled_minutes": round(total_sched, 1),
        "total_capacity_minutes": total_cap,
        "total_scheduled_hours": _hours(total_sched),
        "total_capacity_hours": _hours(total_cap),
        "weekday_utilization_pct": _pct(weekday_sched, weekday_cap),
        "saturday_utilization_pct": _pct(sat_sched, sat_cap),
        "total_utilization_pct": _pct(total_sched, total_cap),
        "weekday_headroom_minutes": max(0.0, weekday_cap - weekday_sched),
        "saturday_headroom_minutes": max(0.0, sat_cap - sat_sched),
    }


def _finalize_month_list(month_grid: dict[int, dict]) -> list[dict]:
    return [_finalize_month_row(month_grid[month]) for month in range(1, 13)]


def _rollup_totals(month_rows: list[dict]) -> dict:
    totals = {
        "weekday_scheduled_minutes": 0.0,
        "saturday_scheduled_minutes": 0.0,
        "weekday_capacity_minutes": 0,
        "saturday_capacity_minutes": 0,
    }
    for row in month_rows:
        totals["weekday_scheduled_minutes"] += row["weekday_scheduled_minutes"]
        totals["saturday_scheduled_minutes"] += row["saturday_scheduled_minutes"]
        totals["weekday_capacity_minutes"] += row["weekday_capacity_minutes"]
        totals["saturday_capacity_minutes"] += row["saturday_capacity_minutes"]

    total_sched = totals["weekday_scheduled_minutes"] + totals["saturday_scheduled_minutes"]
    total_cap = totals["weekday_capacity_minutes"] + totals["saturday_capacity_minutes"]
    return {
        **totals,
        "weekday_scheduled_hours": _hours(totals["weekday_scheduled_minutes"]),
        "saturday_scheduled_hours": _hours(totals["saturday_scheduled_minutes"]),
        "weekday_capacity_hours": _hours(totals["weekday_capacity_minutes"]),
        "saturday_capacity_hours": _hours(totals["saturday_capacity_minutes"]),
        "total_scheduled_minutes": round(total_sched, 1),
        "total_capacity_minutes": total_cap,
        "total_scheduled_hours": _hours(total_sched),
        "total_capacity_hours": _hours(total_cap),
        "weekday_utilization_pct": _pct(totals["weekday_scheduled_minutes"], totals["weekday_capacity_minutes"]),
        "saturday_utilization_pct": _pct(
            totals["saturday_scheduled_minutes"], totals["saturday_capacity_minutes"]
        ),
        "total_utilization_pct": _pct(total_sched, total_cap),
    }


def _build_entity_block(
    *,
    key: str,
    label: str,
    entity_type: str,
    month_grid: dict[int, dict],
    extra: dict | None = None,
) -> dict:
    month_rows = _finalize_month_list(month_grid)
    block = {
        "key": key,
        "label": label,
        "entity_type": entity_type,
        "months": month_rows,
        "totals": _rollup_totals(month_rows),
    }
    if extra:
        block.update(extra)
    return block


def _shift_pool(shift_profile: str) -> str:
    return "24HR" if compact_text(shift_profile).upper() == "24HR" else "STANDARD"


def _pool_meta(pool_key: str) -> dict:
    if pool_key == "24HR":
        return {
            "shift_profile": "24HR",
            "label": "24-hour · MPP",
            "description": "MPP machines on 24/7 shift (higher daily capacity).",
        }
    return {
        "shift_profile": "STANDARD",
        "label": "Standard shift",
        "description": "Day-shift machines (Turning, Milling, Turnmill, non-24h MPP).",
    }


def _rollup_grids_from_machines(
    machine_blocks: list[dict],
    machine_ids: set[int],
    year: int,
    overall_grid: dict[int, dict],
) -> dict[int, dict]:
    grid = _new_month_grid(year)
    id_set = {int(mid) for mid in machine_ids}
    for block in machine_blocks:
        if int(block.get("machine_id") or 0) not in id_set:
            continue
        for month in range(1, 13):
            src = next((row for row in block.get("months") or [] if int(row.get("month") or 0) == month), None)
            if not src:
                continue
            dst = grid[month]
            dst["weekday_scheduled_minutes"] += src["weekday_scheduled_minutes"]
            dst["saturday_scheduled_minutes"] += src["saturday_scheduled_minutes"]
            dst["weekday_capacity_minutes"] += src["weekday_capacity_minutes"]
            dst["saturday_capacity_minutes"] += src["saturday_capacity_minutes"]
            dst["working_days"] = overall_grid[month]["working_days"]
            dst["saturday_days"] = overall_grid[month]["saturday_days"]
    return grid


def _build_category_groups(
    *,
    machine_blocks: list[dict],
    machines: list[dict],
    year: int,
    overall_grid: dict[int, dict],
    machine_grids: dict[int, dict[int, dict]],
) -> list[dict]:
    groups_map: dict[str, dict[int, dict]] = {}
    machine_ids = {int(m["machine_id"]) for m in machines}
    scoped_blocks = [b for b in machine_blocks if int(b.get("machine_id") or 0) in machine_ids]

    for machine in machines:
        machine_category = compact_text(machine.get("machine_category")) or "Uncategorized"
        if machine_category not in groups_map:
            groups_map[machine_category] = _new_month_grid(year)
        machine_id = int(machine["machine_id"])
        for month in range(1, 13):
            src = machine_grids[machine_id][month]
            dst = groups_map[machine_category][month]
            dst["weekday_scheduled_minutes"] += src["weekday_scheduled_minutes"]
            dst["saturday_scheduled_minutes"] += src["saturday_scheduled_minutes"]
            dst["weekday_capacity_minutes"] += src["weekday_capacity_minutes"]
            dst["saturday_capacity_minutes"] += src["saturday_capacity_minutes"]
            dst["working_days"] = overall_grid[month]["working_days"]
            dst["saturday_days"] = overall_grid[month]["saturday_days"]

    group_blocks = []
    for machine_category in sorted(groups_map.keys()):
        group_machines = [m for m in scoped_blocks if m.get("machine_category") == machine_category]
        group_blocks.append(
            {
                **_build_entity_block(
                    key=f"group:{machine_category}",
                    label=machine_category,
                    entity_type="group",
                    month_grid=groups_map[machine_category],
                    extra={
                        "machine_category": machine_category,
                        "machine_count": len(group_machines),
                    },
                ),
                "machines": group_machines,
            }
        )
    return group_blocks


def _build_shift_pools(
    *,
    machine_blocks: list[dict],
    machines: list[dict],
    year: int,
    overall_grid: dict[int, dict],
    machine_grids: dict[int, dict[int, dict]],
) -> list[dict]:
    pools = []
    for pool_key in ("24HR", "STANDARD"):
        meta = _pool_meta(pool_key)
        pool_machines = [m for m in machines if _shift_pool(m.get("shift_profile")) == pool_key]
        if not pool_machines:
            continue
        pool_ids = {int(m["machine_id"]) for m in pool_machines}
        pool_groups = _build_category_groups(
            machine_blocks=machine_blocks,
            machines=pool_machines,
            year=year,
            overall_grid=overall_grid,
            machine_grids=machine_grids,
        )
        pool_grid = _rollup_grids_from_machines(machine_blocks, pool_ids, year, overall_grid)
        pools.append(
            {
                **_build_entity_block(
                    key=f"pool:{pool_key}",
                    label=meta["label"],
                    entity_type="pool",
                    month_grid=pool_grid,
                    extra={
                        "shift_profile": meta["shift_profile"],
                        "description": meta["description"],
                        "machine_count": len(pool_machines),
                        "group_count": len(pool_groups),
                    },
                ),
                "groups": pool_groups,
            }
        )
    return pools


def build_monthly_capacity_report(
    con,
    year: int,
    category: str = "",
    *,
    schedule_mode: str = "plan",
    as_of: date | None = None,
) -> dict:
    mode = _parse_schedule_mode(schedule_mode)
    as_of_date = as_of or date.today()
    all_machines = [dict(row) for row in fetch_machines(con)]
    machine_types = sorted(
        {
            compact_text(row.get("machine_category"))
            for row in all_machines
            if compact_text(row.get("machine_category"))
        }
    )
    cat = compact_text(category)
    machines = all_machines
    if cat and cat.lower() != "all":
        machines = [m for m in machines if compact_text(m.get("machine_category")) == cat]

    machine_ids = [int(m["machine_id"]) for m in machines]
    year_start = date(int(year), 1, 1)
    year_end = date(int(year), 12, 31)

    overall_grid = _new_month_grid(year)
    machine_grids: dict[int, dict[int, dict]] = {
        int(m["machine_id"]): _new_month_grid(year) for m in machines
    }
    calendar_days_counted: set[tuple[int, str]] = set()

    if machine_ids:
        ctx = prefetch_capacity_context(con, machine_ids, year_start, year_end)
        day = year_start
        while day <= year_end:
            month = day.month
            dow = day.weekday()
            is_sat = dow == 5
            is_sun = dow == 6
            day_key = day.isoformat()
            count_capacity = _include_capacity_day(day, mode, as_of_date, int(year))

            if count_capacity:
                if (month, day_key) not in calendar_days_counted:
                    _count_calendar_day(overall_grid[month], is_sat, is_sun)
                    calendar_days_counted.add((month, day_key))

                for machine in machines:
                    machine_id = int(machine["machine_id"])
                    grid = machine_grids[machine_id]
                    if (machine_id, day_key) not in calendar_days_counted:
                        _count_calendar_day(grid[month], is_sat, is_sun)
                        calendar_days_counted.add((machine_id, day_key))

                    cap = machine_capacity_details_with_context(con, machine_id, day, ctx)
                    mins = int(cap.get("capacity_minutes") or 0)
                    _add_capacity(overall_grid[month], is_sat, is_sun, mins)
                    _add_capacity(grid[month], is_sat, is_sun, mins)

            day += timedelta(days=1)

        block_filter = _block_filter_sql(mode)
        segment_params: list = [year_start.isoformat(), year_end.isoformat(), machine_ids]
        segment_extra = ""
        if mode == "forecast":
            segment_extra = " AND s.segment_date >= %s"
            segment_params.append(as_of_date.isoformat())

        segment_rows = rows(
            con.execute(
                f"""
                SELECT s.segment_date::TEXT AS segment_date,
                       b.machine_id,
                       COALESCE(s.minutes_used, 0) AS minutes_used
                FROM planner_run_block_segment s
                JOIN planner_run_block b ON b.block_id = s.block_id
                WHERE {block_filter}
                  AND s.segment_date BETWEEN %s AND %s
                  AND b.machine_id = ANY(%s)
                  {segment_extra}
                """,
                tuple(segment_params),
            )
        )
        for row in segment_rows:
            seg_date = date.fromisoformat(compact_text(row.get("segment_date"))[:10])
            mins = float(row.get("minutes_used") or 0)
            month = seg_date.month
            machine_id = int(row.get("machine_id") or 0)
            _add_scheduled(overall_grid[month], seg_date, mins)
            machine_grid = machine_grids.get(machine_id)
            if machine_grid:
                _add_scheduled(machine_grid[month], seg_date, mins)

    month_rows = _finalize_month_list(overall_grid)
    if mode == "forecast":
        month_rows = [
            row
            for row in month_rows
            if _include_report_month(row["month"], int(year), mode, as_of_date)
        ]
    totals = _rollup_totals(month_rows)

    def _trim_entity_months(entity: dict) -> dict:
        if mode != "forecast":
            return entity
        trimmed_months = [
            row
            for row in (entity.get("months") or [])
            if _include_report_month(row["month"], int(year), mode, as_of_date)
        ]
        out = dict(entity)
        out["months"] = trimmed_months
        out["totals"] = _rollup_totals(trimmed_months)
        return out

    machine_blocks = []
    for machine in machines:
        machine_id = int(machine["machine_id"])
        machine_code = compact_text(machine.get("machine_code") or machine.get("machine_no")) or f"M{machine_id}"
        machine_category = compact_text(machine.get("machine_category")) or "Uncategorized"
        shift_profile = compact_text(machine.get("shift_profile")) or "STANDARD"
        shift_pool = _shift_pool(shift_profile)
        machine_blocks.append(
            _build_entity_block(
                key=f"machine:{machine_id}",
                label=machine_code,
                entity_type="machine",
                month_grid=machine_grids[machine_id],
                extra={
                    "machine_id": machine_id,
                    "machine_code": machine_code,
                    "machine_category": machine_category,
                    "shift_profile": shift_profile,
                    "shift_pool": shift_pool,
                },
            )
        )
    machine_blocks.sort(
        key=lambda item: (
            item.get("shift_pool") or "",
            item.get("machine_category") or "",
            item.get("machine_code") or "",
        )
    )

    group_blocks = _build_category_groups(
        machine_blocks=machine_blocks,
        machines=machines,
        year=int(year),
        overall_grid=overall_grid,
        machine_grids=machine_grids,
    )
    shift_pools = _build_shift_pools(
        machine_blocks=machine_blocks,
        machines=machines,
        year=int(year),
        overall_grid=overall_grid,
        machine_grids=machine_grids,
    )

    machine_blocks = [_trim_entity_months(block) for block in machine_blocks]
    group_blocks = [
        {
            **_trim_entity_months(group),
            "machines": [_trim_entity_months(m) for m in group.get("machines") or []],
        }
        for group in group_blocks
    ]
    shift_pools = [
        {
            **_trim_entity_months(pool),
            "groups": [
                {
                    **_trim_entity_months(group),
                    "machines": [_trim_entity_months(m) for m in group.get("machines") or []],
                }
                for group in pool.get("groups") or []
            ],
        }
        for pool in shift_pools
    ]
    pool_totals = {
        pool["shift_profile"]: pool["totals"]
        for pool in shift_pools
        if pool.get("shift_profile")
    }

    return {
        "year": int(year),
        "category": cat or "all",
        "schedule_mode": mode,
        "schedule_mode_label": _mode_label(mode),
        "as_of_date": as_of_date.isoformat(),
        "machine_count": len(machines),
        "machine_types": machine_types,
        "months": month_rows,
        "totals": totals,
        "groups": group_blocks,
        "shift_pools": shift_pools,
        "pool_totals": pool_totals,
        "machines": machine_blocks,
        "notes": _mode_notes(mode, as_of_date),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
