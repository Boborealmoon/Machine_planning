"""Daily output & efficiency board — sheet generation, 11am snapshot, persistence."""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta

from .helpers import one, rows
from .utils import PLANNER_TZ, compact_text

SECTION_ORDER = ("PS_ML", "PS_TN", "APS_TN")
SECTION_LABELS = {
    "PS_ML": "PS ML",
    "PS_TN": "PS TN",
    "APS_TN": "APS TN",
}
SECTION_OEE_TARGETS = {
    "PS_ML": 0.7,
    "PS_TN": 0.95,
    "APS_TN": 0.95,
}
JOB_SLOTS = 6
SNAPSHOT_HOUR = 11
SNAPSHOT_MINUTE = 0


def _now_sgt() -> datetime:
    return datetime.now(PLANNER_TZ)


def _as_date(value) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = compact_text(value)
    return date.fromisoformat(text[:10])


def _time_text(value) -> str:
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, datetime):
        return value.strftime("%H:%M")
    text = compact_text(value)
    return text[:5] if len(text) >= 5 else text


def effective_minutes(shift_start: str, shift_end: str) -> int:
    def to_minutes(text: str) -> int:
        parts = (text or "0:0").split(":")
        return int(parts[0]) * 60 + int(parts[1] if len(parts) > 1 else 0)

    raw = to_minutes(shift_end) - to_minutes(shift_start) - 60
    if raw <= 0:
        return 0
    return int(math.ceil(raw / 10.0) * 10)


def _cell_number(value, *, blank=0.0, text=1.0) -> float:
    if value is None or value == "":
        return blank
    try:
        return float(value)
    except (TypeError, ValueError):
        return text


def calc_utilisation(jobs: list[dict], eff_mins: int) -> float:
    if not eff_mins:
        return 0.0
    total = sum(_cell_number(j.get("cycle_time")) * _cell_number(j.get("target_qty")) for j in jobs)
    return total / eff_mins


def calc_actual(jobs: list[dict], eff_mins: int) -> float:
    if not eff_mins:
        return 0.0
    total = sum(_cell_number(j.get("cycle_time")) * _cell_number(j.get("out_qty")) for j in jobs)
    return total / eff_mins


def _iso_week_label(work_date: date) -> str:
    iso = work_date.isocalendar()
    return f"WEEK {iso.week}/{iso.year}"


def _day_label(work_date: date) -> str:
    return work_date.strftime("%a")


def _board_machines(con):
    return rows(
        con.execute(
            """
            SELECT machine_id, machine_no, output_section
            FROM planner_machines
            WHERE active = TRUE
              AND COALESCE(output_section, '') <> ''
            ORDER BY output_section, machine_no
            """
        )
    )


def _scheduled_jobs_for_date(con, work_date: date) -> list[dict]:
    return rows(
        con.execute(
            """
            SELECT
                b.block_id,
                b.machine_id,
                b.queue_position,
                m.machine_no,
                m.output_section,
                o.source_ps_id AS ps_id,
                o.source_op_no AS op_no,
                COALESCE(o.cycle_minutes_per_qty, 0) AS cycle_time,
                COALESCE(seg.target_qty, 0) AS target_qty
            FROM planner_run_block b
            JOIN planner_machines m ON m.machine_id = b.machine_id
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN (
                SELECT block_id,
                       COALESCE(SUM(COALESCE(qty_done, planned_qty, 0)), 0) AS target_qty
                FROM planner_run_block_segment
                WHERE segment_date = %s::date
                GROUP BY block_id
            ) seg ON seg.block_id = b.block_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(b.status, '') <> 'COMPLETED'
              AND COALESCE(m.output_section, '') <> ''
            ORDER BY m.output_section, m.machine_no, b.queue_position, b.block_id
            """,
            (work_date.isoformat(),),
        )
    )


def _scheduled_job_counts(con, work_date: date) -> dict[int, int]:
    counts: dict[int, int] = {}
    for row in rows(
        con.execute(
            """
            SELECT b.machine_id, COUNT(DISTINCT b.block_id) AS job_count
            FROM planner_run_block b
            JOIN planner_machines m ON m.machine_id = b.machine_id
            JOIN planner_run_block_segment s ON s.block_id = b.block_id
            WHERE s.segment_date = %s::date
              AND COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(b.status, '') <> 'COMPLETED'
              AND COALESCE(m.output_section, '') <> ''
            GROUP BY b.machine_id
            """,
            (work_date.isoformat(),),
        )
    ):
        counts[int(row["machine_id"])] = int(row["job_count"] or 0)
    return counts


def _daily_output_qty_for_block(con, block_id, work_date: date):
    if not block_id:
        return None
    row = one(
        con.execute(
            """
            SELECT COALESCE(SUM(COALESCE(output_qty, 0)), 0) AS output_qty
            FROM planner_production_actual
            WHERE block_id = %s
              AND report_date = %s::date
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            """,
            (int(block_id), work_date.isoformat()),
        )
    )
    if not row:
        return None
    qty = float(row.get("output_qty") or 0)
    return qty if qty > 0 else None


def _get_sheet(con, work_date: date):
    return one(
        con.execute(
            """
            SELECT sheet_id, work_date::text AS work_date, shift_start, shift_end,
                   plan_locked_at, status, created_at, updated_at
            FROM planner_daily_output_sheet
            WHERE work_date = %s::date
            """,
            (work_date.isoformat(),),
        )
    )


def _ensure_machine_rows(con, sheet_id: int):
    machines = _board_machines(con)
    for index, machine in enumerate(machines):
        con.execute(
            """
            INSERT INTO planner_daily_output_machine (
                sheet_id, machine_id, section_code, sort_order
            ) VALUES (%s, %s, %s, %s)
            ON CONFLICT (sheet_id, machine_id) DO NOTHING
            """,
            (
                sheet_id,
                machine["machine_id"],
                machine["output_section"],
                index,
            ),
        )
    return machines


def _empty_line(sheet_id: int, machine_id: int, slot_index: int) -> dict:
    return {
        "sheet_id": sheet_id,
        "machine_id": machine_id,
        "slot_index": slot_index,
        "block_id": None,
        "ps_id": "",
        "op_no": "",
        "cycle_time": None,
        "target_qty": None,
        "out_qty": None,
        "fpce": "",
        "in_pro": "",
        "qua_his": "",
        "rejects": None,
        "source": "SCHEDULE",
        "manual_touched": False,
    }


def _apply_schedule_to_lines(con, sheet_id: int, work_date: date, *, plan_locked: bool):
    if plan_locked:
        return
    jobs_by_machine: dict[int, list[dict]] = {}
    for job in _scheduled_jobs_for_date(con, work_date):
        mid = int(job["machine_id"])
        jobs_by_machine.setdefault(mid, []).append(job)

    machines = _board_machines(con)
    for machine in machines:
        machine_id = int(machine["machine_id"])
        scheduled = jobs_by_machine.get(machine_id, [])[:JOB_SLOTS]
        existing = rows(
            con.execute(
                """
                SELECT line_id, slot_index, block_id, ps_id, op_no, cycle_time, target_qty,
                       out_qty, fpce, in_pro, qua_his, rejects, source, manual_touched
                FROM planner_daily_output_line
                WHERE sheet_id = %s AND machine_id = %s
                ORDER BY slot_index
                """,
                (sheet_id, machine_id),
            )
        )
        by_slot = {int(row["slot_index"]): row for row in existing}

        for slot_index in range(JOB_SLOTS):
            current = by_slot.get(slot_index)
            scheduled_job = scheduled[slot_index] if slot_index < len(scheduled) else None

            if current and (current.get("manual_touched") or _line_has_manual_values(current)):
                continue

            if not scheduled_job:
                if current:
                    con.execute(
                        """
                        UPDATE planner_daily_output_line
                        SET block_id = NULL, ps_id = '', op_no = '', cycle_time = NULL,
                            target_qty = NULL, source = 'SCHEDULE', updated_at = NOW()
                        WHERE line_id = %s AND NOT manual_touched
                          AND COALESCE(out_qty, 0) = 0
                          AND fpce = '' AND in_pro = '' AND qua_his = ''
                          AND COALESCE(rejects, 0) = 0
                        """,
                        (current["line_id"],),
                    )
                else:
                    payload = _empty_line(sheet_id, machine_id, slot_index)
                    con.execute(
                        """
                        INSERT INTO planner_daily_output_line (
                            sheet_id, machine_id, slot_index, block_id, ps_id, op_no,
                            cycle_time, target_qty, source
                        ) VALUES (%s, %s, %s, NULL, '', '', NULL, NULL, 'SCHEDULE')
                        ON CONFLICT (sheet_id, machine_id, slot_index) DO NOTHING
                        """,
                        (sheet_id, machine_id, slot_index),
                    )
                continue

            block_id = scheduled_job.get("block_id")
            actual_out = _daily_output_qty_for_block(con, block_id, work_date)
            values = (
                block_id,
                compact_text(scheduled_job.get("ps_id")),
                compact_text(scheduled_job.get("op_no")),
                scheduled_job.get("cycle_time"),
                scheduled_job.get("target_qty"),
            )
            if current:
                if actual_out is not None and not current.get("manual_touched") and not _line_has_manual_values(current):
                    con.execute(
                        """
                        UPDATE planner_daily_output_line
                        SET block_id = %s, ps_id = %s, op_no = %s, cycle_time = %s,
                            target_qty = %s, out_qty = %s, source = 'SCHEDULE', updated_at = NOW()
                        WHERE line_id = %s
                          AND NOT manual_touched
                          AND fpce = '' AND in_pro = '' AND qua_his = ''
                          AND COALESCE(rejects, 0) = 0
                        """,
                        (*values, actual_out, current["line_id"]),
                    )
                else:
                    con.execute(
                        """
                        UPDATE planner_daily_output_line
                        SET block_id = %s, ps_id = %s, op_no = %s, cycle_time = %s,
                            target_qty = %s, source = 'SCHEDULE', updated_at = NOW()
                        WHERE line_id = %s
                          AND NOT manual_touched
                          AND COALESCE(out_qty, 0) = 0
                          AND fpce = '' AND in_pro = '' AND qua_his = ''
                          AND COALESCE(rejects, 0) = 0
                        """,
                        (*values, current["line_id"]),
                    )
            else:
                con.execute(
                    """
                    INSERT INTO planner_daily_output_line (
                        sheet_id, machine_id, slot_index, block_id, ps_id, op_no,
                        cycle_time, target_qty, source
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'SCHEDULE')
                    ON CONFLICT (sheet_id, machine_id, slot_index) DO UPDATE
                    SET block_id = EXCLUDED.block_id,
                        ps_id = EXCLUDED.ps_id,
                        op_no = EXCLUDED.op_no,
                        cycle_time = EXCLUDED.cycle_time,
                        target_qty = EXCLUDED.target_qty,
                        source = 'SCHEDULE',
                        updated_at = NOW()
                    WHERE NOT planner_daily_output_line.manual_touched
                    """,
                    (sheet_id, machine_id, slot_index, *values),
                )

        for slot_index in range(len(scheduled), JOB_SLOTS):
            if slot_index not in by_slot:
                con.execute(
                    """
                    INSERT INTO planner_daily_output_line (
                        sheet_id, machine_id, slot_index, source
                    ) VALUES (%s, %s, %s, 'SCHEDULE')
                    ON CONFLICT (sheet_id, machine_id, slot_index) DO NOTHING
                    """,
                    (sheet_id, machine_id, slot_index),
                )


def _sync_out_qty_from_actuals(con, sheet_id: int, work_date: date):
    line_rows = rows(
        con.execute(
            """
            SELECT line_id, block_id, manual_touched, out_qty, fpce, in_pro, qua_his, rejects
            FROM planner_daily_output_line
            WHERE sheet_id = %s
              AND block_id IS NOT NULL
              AND NOT manual_touched
            """,
            (sheet_id,),
        )
    )
    for row in line_rows:
        if row.get("manual_touched"):
            continue
        if compact_text(row.get("fpce")) or compact_text(row.get("in_pro")) or compact_text(row.get("qua_his")):
            continue
        if row.get("rejects") not in (None, "", 0):
            continue
        actual_out = _daily_output_qty_for_block(con, row.get("block_id"), work_date)
        if actual_out is None:
            continue
        current_out = float(row.get("out_qty") or 0)
        if abs(current_out - actual_out) < 1e-9:
            continue
        con.execute(
            """
            UPDATE planner_daily_output_line
            SET out_qty = %s, updated_at = NOW()
            WHERE line_id = %s
              AND NOT manual_touched
              AND fpce = '' AND in_pro = '' AND qua_his = ''
              AND COALESCE(rejects, 0) = 0
            """,
            (actual_out, row["line_id"]),
        )


def _line_has_manual_values(row: dict) -> bool:
    return bool(
        row.get("out_qty") not in (None, "", 0)
        or compact_text(row.get("fpce"))
        or compact_text(row.get("in_pro"))
        or compact_text(row.get("qua_his"))
        or row.get("rejects") not in (None, "", 0)
    )


def ensure_sheet(con, work_date: date) -> dict:
    sheet = _get_sheet(con, work_date)
    if not sheet:
        con.execute(
            """
            INSERT INTO planner_daily_output_sheet (work_date, shift_start, shift_end)
            VALUES (%s::date, '08:30', '20:00')
            """,
            (work_date.isoformat(),),
        )
        sheet = _get_sheet(con, work_date)
    sheet_id = int(sheet["sheet_id"])
    _ensure_machine_rows(con, sheet_id)
    plan_locked = bool(sheet.get("plan_locked_at"))
    _apply_schedule_to_lines(con, sheet_id, work_date, plan_locked=plan_locked)
    if not plan_locked:
        _sync_out_qty_from_actuals(con, sheet_id, work_date)
    maybe_auto_snapshot_11am(con, sheet_id, work_date)
    return _get_sheet(con, work_date) or sheet


def _snapshot_exists(con, sheet_id: int, snapshot_type: str) -> bool:
    row = one(
        con.execute(
            """
            SELECT snapshot_id
            FROM planner_daily_output_snapshot
            WHERE sheet_id = %s AND snapshot_type = %s
            LIMIT 1
            """,
            (sheet_id, snapshot_type),
        )
    )
    return bool(row)


def create_snapshot(con, sheet_id: int, *, snapshot_type: str = "AUTO_11AM", label: str = "", created_by: str = "") -> dict:
    snap = one(
        con.execute(
            """
            INSERT INTO planner_daily_output_snapshot (
                sheet_id, snapshot_type, label, created_by
            ) VALUES (%s, %s, %s, %s)
            RETURNING snapshot_id, sheet_id, snapshot_type, snapshot_at, label
            """,
            (sheet_id, snapshot_type, label or snapshot_type, created_by),
        )
    )
    snapshot_id = int(snap["snapshot_id"])
    line_rows = rows(
        con.execute(
            """
            SELECT l.machine_id, l.slot_index, l.block_id, l.ps_id, l.op_no,
                   l.cycle_time, l.target_qty, l.out_qty, l.fpce, l.in_pro,
                   l.qua_his, l.rejects, m.mc_am, m.mc_ot
            FROM planner_daily_output_line l
            JOIN planner_daily_output_machine m
              ON m.sheet_id = l.sheet_id AND m.machine_id = l.machine_id
            WHERE l.sheet_id = %s
            ORDER BY l.machine_id, l.slot_index
            """,
            (sheet_id,),
        )
    )
    for row in line_rows:
        con.execute(
            """
            INSERT INTO planner_daily_output_snapshot_line (
                snapshot_id, machine_id, slot_index, block_id, ps_id, op_no,
                cycle_time, target_qty, out_qty, fpce, in_pro, qua_his, rejects,
                mc_am, mc_ot
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                snapshot_id,
                row["machine_id"],
                row["slot_index"],
                row.get("block_id"),
                row.get("ps_id") or "",
                compact_text(row.get("op_no")),
                row.get("cycle_time"),
                row.get("target_qty"),
                row.get("out_qty"),
                row.get("fpce") or "",
                row.get("in_pro") or "",
                row.get("qua_his") or "",
                row.get("rejects"),
                row.get("mc_am") or "",
                row.get("mc_ot") or "",
            ),
        )
    con.execute(
        """
        UPDATE planner_daily_output_sheet
        SET plan_locked_at = COALESCE(plan_locked_at, NOW()), updated_at = NOW()
        WHERE sheet_id = %s
        """,
        (sheet_id,),
    )
    return snap


def maybe_auto_snapshot_11am(con, sheet_id: int, work_date: date):
    today = _now_sgt().date()
    if work_date != today:
        return None
    now = _now_sgt()
    cutoff = datetime.combine(today, time(SNAPSHOT_HOUR, SNAPSHOT_MINUTE), tzinfo=PLANNER_TZ)
    if now < cutoff:
        return None
    if _snapshot_exists(con, sheet_id, "AUTO_11AM"):
        return None
    return create_snapshot(con, sheet_id, snapshot_type="AUTO_11AM", label="11:00 SGT plan snapshot")


def _display_number(value):
    if value is None or value == "":
        return ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return compact_text(value)
    if abs(number - round(number)) < 1e-9:
        return str(int(round(number)))
    text = f"{number:.2f}".rstrip("0").rstrip(".")
    return text


def _serialize_line(row: dict) -> dict:
    return {
        "line_id": int(row["line_id"]) if row.get("line_id") else None,
        "slot_index": int(row.get("slot_index") or 0),
        "block_id": int(row["block_id"]) if row.get("block_id") else None,
        "ps": compact_text(row.get("ps_id")),
        "opn": row.get("op_no") if row.get("op_no") is not None else "",
        "ct": _display_number(row.get("cycle_time")),
        "tgt": _display_number(row.get("target_qty")),
        "out": _display_number(row.get("out_qty")),
        "fpce": compact_text(row.get("fpce")),
        "inpro": compact_text(row.get("in_pro")),
        "quahis": compact_text(row.get("qua_his")),
        "rejects": _display_number(row.get("rejects")),
        "source": compact_text(row.get("source")),
        "manual_touched": bool(row.get("manual_touched")),
        "plan_locked": bool(row.get("plan_locked")),
    }


def build_sheet_payload(con, work_date: date) -> dict:
    sheet = ensure_sheet(con, work_date)
    sheet_id = int(sheet["sheet_id"])
    shift_start = _time_text(sheet.get("shift_start"))
    shift_end = _time_text(sheet.get("shift_end"))
    eff_mins = effective_minutes(shift_start, shift_end)
    plan_locked = bool(sheet.get("plan_locked_at"))
    today = _now_sgt().date()
    is_today = work_date == today

    scheduled_counts = _scheduled_job_counts(con, work_date)

    machine_rows = rows(
        con.execute(
            """
            SELECT sm.sheet_machine_id, sm.machine_id, sm.section_code, sm.sort_order,
                   sm.mc_am, sm.mc_ot, m.machine_no
            FROM planner_daily_output_machine sm
            JOIN planner_machines m ON m.machine_id = sm.machine_id
            WHERE sm.sheet_id = %s
            ORDER BY sm.section_code, sm.sort_order, m.machine_no
            """,
            (sheet_id,),
        )
    )

    line_rows = rows(
        con.execute(
            """
            SELECT line_id, machine_id, slot_index, block_id, ps_id, op_no, cycle_time,
                   target_qty, out_qty, fpce, in_pro, qua_his, rejects, source, manual_touched
            FROM planner_daily_output_line
            WHERE sheet_id = %s
            ORDER BY machine_id, slot_index
            """,
            (sheet_id,),
        )
    )
    lines_by_machine: dict[int, list[dict]] = {}
    for row in line_rows:
        row["plan_locked"] = plan_locked
        mid = int(row["machine_id"])
        lines_by_machine.setdefault(mid, []).append(row)

    snapshots = rows(
        con.execute(
            """
            SELECT snapshot_id, snapshot_type, snapshot_at, label, created_by
            FROM planner_daily_output_snapshot
            WHERE sheet_id = %s
            ORDER BY snapshot_at DESC
            """,
            (sheet_id,),
        )
    )

    sections_map = {code: {"id": code, "label": SECTION_LABELS[code], "oeeTarget": SECTION_OEE_TARGETS.get(code, 0), "machines": []} for code in SECTION_ORDER}
    for machine in machine_rows:
        mid = int(machine["machine_id"])
        jobs_raw = lines_by_machine.get(mid, [])
        jobs = [_serialize_line(row) for row in sorted(jobs_raw, key=lambda r: int(r.get("slot_index") or 0))]
        util = calc_utilisation(
            [{"cycle_time": j["ct"], "target_qty": j["tgt"]} for j in jobs],
            eff_mins,
        )
        actual = calc_actual(
            [{"cycle_time": j["ct"], "out_qty": j["out"]} for j in jobs],
            eff_mins,
        )
        section_code = compact_text(machine.get("section_code"))
        bucket = sections_map.get(section_code)
        if not bucket:
            continue
        scheduled_total = int(scheduled_counts.get(mid, 0))
        bucket["machines"].append(
            {
                "machine_id": mid,
                "name": compact_text(machine.get("machine_no")),
                "mcAm": compact_text(machine.get("mc_am")),
                "mcOt": compact_text(machine.get("mc_ot")),
                "utilisation": util,
                "actual": actual,
                "scheduled_total": scheduled_total,
                "jobs_truncated": scheduled_total > JOB_SLOTS,
                "jobs": jobs,
            }
        )

    sections = [sections_map[code] for code in SECTION_ORDER if sections_map[code]["machines"]]

    return {
        "sheet_id": sheet_id,
        "work_date": work_date.isoformat(),
        "weekLabel": _iso_week_label(work_date),
        "dayLabel": _day_label(work_date),
        "shiftStart": shift_start,
        "shiftEnd": shift_end,
        "effectiveMinutes": eff_mins,
        "plan_locked": plan_locked,
        "is_today": is_today,
        "can_edit_plan": is_today and not plan_locked,
        "sections": sections,
        "snapshots": [
            {
                "snapshot_id": int(s["snapshot_id"]),
                "snapshot_type": s["snapshot_type"],
                "snapshot_at": compact_text(s.get("snapshot_at")),
                "label": compact_text(s.get("label")),
                "created_by": compact_text(s.get("created_by")),
            }
            for s in snapshots
        ],
    }


def patch_sheet(
    con,
    work_date: date,
    *,
    lines: list[dict] | None = None,
    machines: list[dict] | None = None,
    shift_start: str | None = None,
    shift_end: str | None = None,
    allow_past_edit: bool = False,
) -> dict:
    today = _now_sgt().date()
    if work_date < today and not allow_past_edit:
        raise PermissionError("Passcode required to edit past days.")

    sheet = ensure_sheet(con, work_date)
    sheet_id = int(sheet["sheet_id"])
    plan_locked = bool(sheet.get("plan_locked_at"))

    if shift_start or shift_end:
        start_val = f"{shift_start}:00" if shift_start and len(shift_start) == 5 else shift_start
        end_val = f"{shift_end}:00" if shift_end and len(shift_end) == 5 else shift_end
        con.execute(
            """
            UPDATE planner_daily_output_sheet
            SET shift_start = COALESCE(%s::time, shift_start),
                shift_end = COALESCE(%s::time, shift_end),
                updated_at = NOW()
            WHERE sheet_id = %s
            """,
            (start_val, end_val, sheet_id),
        )

    for machine in machines or []:
        machine_id = int(machine.get("machine_id") or 0)
        if machine_id <= 0:
            continue
        con.execute(
            """
            UPDATE planner_daily_output_machine
            SET mc_am = %s, mc_ot = %s, updated_at = NOW()
            WHERE sheet_id = %s AND machine_id = %s
            """,
            (
                compact_text(machine.get("mcAm")),
                compact_text(machine.get("mcOt")),
                sheet_id,
                machine_id,
            ),
        )

    for line in lines or []:
        line_id = int(line.get("line_id") or 0)
        if line_id <= 0:
            continue
        existing = one(
            con.execute(
                """
                SELECT line_id, manual_touched
                FROM planner_daily_output_line
                WHERE line_id = %s AND sheet_id = %s
                """,
                (line_id, sheet_id),
            )
        )
        if not existing:
            continue
        con.execute(
            """
            UPDATE planner_daily_output_line
            SET out_qty = %s,
                fpce = %s,
                in_pro = %s,
                qua_his = %s,
                rejects = %s,
                manual_touched = TRUE,
                updated_at = NOW()
            WHERE line_id = %s
            """,
            (
                _nullable_numeric(line.get("out")),
                compact_text(line.get("fpce")),
                compact_text(line.get("inpro")),
                compact_text(line.get("quahis")),
                _nullable_numeric(line.get("rejects")),
                line_id,
            ),
        )

    con.execute(
        "UPDATE planner_daily_output_sheet SET updated_at = NOW() WHERE sheet_id = %s",
        (sheet_id,),
    )
    return build_sheet_payload(con, work_date)


def refresh_plan_from_schedule(con, work_date: date) -> dict:
    sheet = _get_sheet(con, work_date)
    if not sheet:
        return build_sheet_payload(con, work_date)
    if sheet.get("plan_locked_at"):
        raise ValueError("Plan is locked after the 11:00 snapshot.")
    sheet_id = int(sheet["sheet_id"])
    _apply_schedule_to_lines(con, sheet_id, work_date, plan_locked=False)
    return build_sheet_payload(con, work_date)


def get_snapshot_detail(con, snapshot_id: int) -> dict | None:
    header = one(
        con.execute(
            """
            SELECT s.snapshot_id, s.sheet_id, s.snapshot_type, s.snapshot_at, s.label,
                   sh.work_date::text AS work_date
            FROM planner_daily_output_snapshot s
            JOIN planner_daily_output_sheet sh ON sh.sheet_id = s.sheet_id
            WHERE s.snapshot_id = %s
            """,
            (snapshot_id,),
        )
    )
    if not header:
        return None
    lines = rows(
        con.execute(
            """
            SELECT sl.*, m.machine_no, m.output_section
            FROM planner_daily_output_snapshot_line sl
            JOIN planner_machines m ON m.machine_id = sl.machine_id
            WHERE sl.snapshot_id = %s
            ORDER BY m.output_section, m.machine_no, sl.slot_index
            """,
            (snapshot_id,),
        )
    )
    return {"header": header, "lines": lines}


def _nullable_numeric(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def apply_migration(con):
    """Idempotent apply for dev environments without manual migration run."""
    from pathlib import Path

    sql_path = Path(__file__).resolve().parents[1] / "migrations" / "add_daily_output_board.sql"
    if not sql_path.is_file():
        return
    sql = sql_path.read_text(encoding="utf-8")
    statement = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        statement.append(line)
        if stripped.endswith(";"):
            chunk = "\n".join(statement).strip()
            if chunk:
                con.execute(chunk)
            statement = []
