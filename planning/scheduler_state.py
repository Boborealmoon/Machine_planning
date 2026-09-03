"""planning/scheduler_state.py — scheduler state helpers (PostgreSQL port of Vanessa's scheduler_state.py).

Key changes vs SQLite original:
  run_block                    → planner_run_block
  run_block_segment            → planner_run_block_segment
  production_actual            → planner_production_actual
  operation                    → planner_operation
  process_sheet                → planner_process_sheet  (ps_id col → planner_ps_id)
  machine_calendar_window      → planner_machine_calendar_window
  machine_queue_state          → planner_machine_queue_state
  process_sheet_operation_state→ planner_process_sheet_operation_state  (ps_id → planner_ps_id)
  process_sheet_state          → planner_process_sheet_state             (ps_id → planner_ps_id)
  schedule_run                 → planner_schedule_run  (status ARCHIVED → SUPERSEDED)
  schedule_alert               → planner_schedule_alert  (ps_id col → planner_ps_id)
  is_late                      → BOOLEAN (True/False, not 1/0)
  active = 1                   → active = TRUE
  cur.lastrowid                → RETURNING + one(cur)["pk"]
  WHERE col IS ?               → WHERE col IS NOT DISTINCT FROM %s
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from .actuals import actual_totals_for_block
from .helpers import one, rows, parse_dt_text
from .utils import planner_now_naive, planner_timestamptz_for_db, compact_text


def _text(value):
    return "" if value is None else str(value)


def _float(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _segment_bounds(con, block_id):
    row = one(
        con.execute(
            """
            SELECT MIN(start_datetime) AS start_datetime, MAX(end_datetime) AS end_datetime
            FROM planner_run_block_segment
            WHERE block_id = %s AND COALESCE(segment_status, 'PLANNED') = 'PLANNED'
            """,
            (int(block_id),),
        )
    )
    if not row or not row["start_datetime"] or not row["end_datetime"]:
        return None
    return row["start_datetime"], row["end_datetime"]


def _operation_bounds(con, operation_id):
    row = one(
        con.execute(
            """
            SELECT MIN(s.start_datetime) AS start_datetime, MAX(s.end_datetime) AS end_datetime
            FROM planner_run_block_segment s
            JOIN planner_run_block b ON b.block_id = s.block_id
            WHERE b.operation_id = %s AND COALESCE(s.segment_status, 'PLANNED') = 'PLANNED'
            """,
            (int(operation_id),),
        )
    )
    if not row or not row["start_datetime"] or not row["end_datetime"]:
        return None
    return row["start_datetime"], row["end_datetime"]


def _process_sheet_bounds(con, ps_id):
    row = one(
        con.execute(
            """
            SELECT MIN(s.start_datetime) AS start_datetime, MAX(s.end_datetime) AS end_datetime
            FROM planner_run_block_segment s
            JOIN planner_run_block b ON b.block_id = s.block_id
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE COALESCE(o.source_ps_id, '') = %s
              AND COALESCE(s.segment_status, 'PLANNED') = 'PLANNED'
            """,
            (str(ps_id),),
        )
    )
    if not row or not row["start_datetime"] or not row["end_datetime"]:
        return None
    return row["start_datetime"], row["end_datetime"]


def _ps_id_for_operation(con, operation_id):
    row = one(
        con.execute(
            "SELECT COALESCE(source_ps_id, '') AS ps_id FROM planner_operation WHERE operation_id = %s",
            (int(operation_id),),
        )
    )
    return _text(row["ps_id"]) if row else ""


def _ps_id_for_block(con, block_id):
    row = one(
        con.execute(
            """
            SELECT COALESCE(o.source_ps_id, '') AS ps_id
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    return _text(row["ps_id"]) if row else ""


def _validated_ps_id(con, raw_ps_id):
    """Return raw_ps_id only if it exists in planner_process_sheet, else None.

    Prevents FK violations when ERP-sourced ps_ids (not yet in planner_process_sheet)
    are stored in tables that FK-reference planner_process_sheet.
    """
    if not raw_ps_id:
        return None
    row = one(con.execute(
        "SELECT 1 FROM planner_process_sheet WHERE planner_ps_id = %s LIMIT 1",
        (str(raw_ps_id),),
    ))
    return str(raw_ps_id) if row else None


def _archive_current_runs(con, scope_type, machine_id):
    if machine_id is None:
        con.execute(
            """
            UPDATE planner_schedule_run
            SET status = 'SUPERSEDED', updated_at = NOW()
            WHERE status = 'CURRENT'
              AND scope_type = %s
              AND machine_id IS NULL
            """,
            (scope_type,),
        )
    else:
        con.execute(
            """
            UPDATE planner_schedule_run
            SET status = 'SUPERSEDED', updated_at = NOW()
            WHERE status = 'CURRENT'
              AND scope_type = %s
              AND machine_id = %s
            """,
            (scope_type, int(machine_id)),
        )


def create_schedule_run(con, reason, scope_type="FULL", machine_id=None, notes=""):
    _archive_current_runs(con, scope_type, machine_id)
    cur = con.execute(
        """
        INSERT INTO planner_schedule_run (reason, status, scope_type, machine_id, notes, generated_at, created_at, updated_at)
        VALUES (%s, 'CURRENT', %s, %s, %s, NOW(), NOW(), NOW())
        RETURNING schedule_run_id
        """,
        (str(reason or ""), scope_type, int(machine_id) if machine_id is not None else None, str(notes or "")),
    )
    return int(one(cur)["schedule_run_id"])


def active_calendar_windows_for_machine_day(con, machine_id, work_day):
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


def prefetch_calendar_windows_for_machines(con, machine_ids, start_date, end_date):
    """Bulk-load calendar windows overlapping [start_date, end_date] keyed by machine_id."""
    from datetime import date as date_type

    mids = [int(machine_id) for machine_id in (machine_ids or []) if int(machine_id or 0) > 0]
    if not mids:
        return {}
    start_day = start_date if isinstance(start_date, date_type) else date_type.fromisoformat(str(start_date)[:10])
    end_day = end_date if isinstance(end_date, date_type) else date_type.fromisoformat(str(end_date)[:10])
    grouped = {mid: [] for mid in mids}
    for row in rows(
        con.execute(
            """
            SELECT *
            FROM planner_machine_calendar_window
            WHERE machine_id = ANY(%s)
              AND active = TRUE
              AND start_at < %s
              AND end_at > %s
            ORDER BY machine_id, start_at, window_id
            """,
            (mids, (end_day + timedelta(days=1)).strftime("%Y-%m-%d"), start_day.strftime("%Y-%m-%d")),
        )
    ):
        grouped.setdefault(int(row["machine_id"]), []).append(dict(row))
    return grouped


def _effective_qty_totals_for_block(con, block_row):
    """Shop actuals plus ERP WO progress (ERP wins when shop has not reported)."""
    try:
        from .erp_actuals import effective_actual_totals_for_block

        totals = effective_actual_totals_for_block(con, block_row)
        output_qty = _float(totals.get("effective_output_qty"))
        reject_qty = _float(totals.get("effective_reject_qty"))
        good_qty = _float(totals.get("effective_good_qty"))
    except Exception:
        shop = actual_totals_for_block(con, int(block_row.get("block_id") or 0))
        output_qty = _float(shop.get("output_qty"))
        reject_qty = _float(shop.get("reject_qty"))
        good_qty = _float(shop.get("good_qty"))
    scheduled_qty = _float(block_row.get("scheduled_qty"))
    remaining_qty = max(0.0, scheduled_qty - good_qty) if scheduled_qty > 0 else 0.0
    return output_qty, reject_qty, good_qty, remaining_qty


def refresh_machine_queue_state(con, block_id, schedule_run_id=None):
    block = one(
        con.execute(
            """
            SELECT b.*, o.source_ps_id, o.source_op_no, o.source_op_seq_id, o.job_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not block:
        return None

    output_qty, reject_qty, good_qty, remaining_qty = _effective_qty_totals_for_block(con, block)

    bounds = _segment_bounds(con, block_id)
    # Queue state is the live prediction shown by the scheduler. Prefer the
    # recalculated/segment window so setup toggles push downstream jobs.
    planned_start = (bounds[0] if bounds else None) or block["calculated_start_datetime"] or block["planned_start_at"]
    planned_end = (bounds[1] if bounds else None) or block["calculated_end_datetime"] or block["planned_end_at"]

    # Normalise to text for storage
    ps_text = planned_start.isoformat() if isinstance(planned_start, datetime) else _text(planned_start)
    pe_text = planned_end.isoformat() if isinstance(planned_end, datetime) else _text(planned_end)

    planned_minutes = 0.0
    if planned_start and planned_end:
        try:
            s = parse_dt_text(planned_start)
            e = parse_dt_text(planned_end)
            if s and e:
                planned_minutes = max(0.0, (e - s).total_seconds() / 60.0)
        except (ValueError, TypeError):
            planned_minutes = 0.0

    execution_status = _text(block["execution_status"] or block["status"] or "NOT_STARTED")
    if good_qty > 0 and execution_status in {"", "NOT_STARTED", "PLANNED"}:
        execution_status = "IN_PROGRESS"
    if remaining_qty <= 0 and _float(block.get("scheduled_qty")) > 0:
        execution_status = "DONE"
    schedule_status = _text(block["planning_status"] or "UNSCHEDULED")

    is_late = False
    delay_minutes = 0.0
    if planned_end:
        try:
            end_dt = parse_dt_text(planned_end)
            if end_dt:
                now_dt = planner_now_naive()
                if end_dt < now_dt and execution_status not in {"DONE", "COMPLETED"}:
                    is_late = True
                    delay_minutes = max(0.0, (now_dt - end_dt).total_seconds() / 60.0)
        except (ValueError, TypeError):
            pass

    con.execute(
        """
        INSERT INTO planner_machine_queue_state (
          block_id, schedule_run_id, predicted_start_at, predicted_end_at, remaining_qty, output_qty,
          reject_qty, good_qty, planned_minutes, schedule_status, execution_status, is_late, delay_minutes, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (block_id) DO UPDATE SET
          schedule_run_id    = EXCLUDED.schedule_run_id,
          predicted_start_at = EXCLUDED.predicted_start_at,
          predicted_end_at   = EXCLUDED.predicted_end_at,
          remaining_qty      = EXCLUDED.remaining_qty,
          output_qty         = EXCLUDED.output_qty,
          reject_qty         = EXCLUDED.reject_qty,
          good_qty           = EXCLUDED.good_qty,
          planned_minutes    = EXCLUDED.planned_minutes,
          schedule_status    = EXCLUDED.schedule_status,
          execution_status   = EXCLUDED.execution_status,
          is_late            = EXCLUDED.is_late,
          delay_minutes      = EXCLUDED.delay_minutes,
          updated_at         = NOW()
        """,
        (
            int(block_id),
            int(schedule_run_id) if schedule_run_id is not None else block["last_schedule_run_id"],
            planner_timestamptz_for_db(planned_start),
            planner_timestamptz_for_db(planned_end),
            remaining_qty,
            output_qty,
            reject_qty,
            good_qty,
            planned_minutes,
            schedule_status,
            execution_status,
            is_late,
            delay_minutes,
        ),
    )
    return {
        "block_id": int(block_id),
        "remaining_qty": remaining_qty,
        "good_qty": good_qty,
        "planned_start_at": ps_text,
        "planned_end_at": pe_text,
        "execution_status": execution_status,
    }


def refresh_stale_queue_state_fields(con, block_row):
    """Repair queue_state rows that falsely show full output after ERP stage relinks."""
    if not block_row or not int(block_row.get("block_id") or 0):
        return block_row
    exec_status = _text(block_row.get("execution_status") or block_row.get("status")).upper()
    if exec_status not in {"", "NOT_STARTED", "PLANNED"}:
        return block_row
    scheduled = _float(block_row.get("scheduled_qty"))
    qs_good = _float(block_row.get("qs_good_qty") or block_row.get("good_qty"))
    actual_good = _float(block_row.get("actual_good_qty"))
    if scheduled <= 0 or qs_good < scheduled - 1e-4 or actual_good > 0:
        return block_row
    state = refresh_machine_queue_state(con, int(block_row["block_id"]))
    if not state:
        return block_row
    block_row["qs_good_qty"] = state.get("good_qty")
    block_row["qs_remaining_qty"] = state.get("remaining_qty")
    block_row["good_qty"] = state.get("good_qty")
    block_row["remaining_qty"] = state.get("remaining_qty")
    if state.get("execution_status"):
        block_row["execution_status"] = state["execution_status"]
    return block_row


def refresh_operation_state(con, operation_id):
    operation = one(
        con.execute(
            "SELECT * FROM planner_operation WHERE operation_id = %s",
            (int(operation_id),),
        )
    )
    if not operation:
        return None

    actual_totals = one(
        con.execute(
            """
            SELECT
              COALESCE(SUM(COALESCE(a.output_qty, 0)), 0) AS output_qty,
              COALESCE(SUM(COALESCE(a.reject_qty, 0)), 0) AS reject_qty,
              COALESCE(SUM(COALESCE(a.output_qty, 0) - COALESCE(a.reject_qty, 0)), 0) AS good_qty,
              SUM(CASE WHEN a.output_qty IS NOT NULL THEN 1 ELSE 0 END) AS output_reports,
              SUM(CASE WHEN a.reject_qty IS NOT NULL THEN 1 ELSE 0 END) AS reject_reports
            FROM planner_run_block b
            LEFT JOIN planner_production_actual a ON a.block_id = b.block_id
            WHERE b.operation_id = %s
              AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
            """,
            (int(operation_id),),
        )
    )
    bounds = _operation_bounds(con, operation_id)
    output_qty = _float(actual_totals["output_qty"] if actual_totals else 0)
    reject_qty = _float(actual_totals["reject_qty"] if actual_totals else 0)
    good_qty = _float(actual_totals["good_qty"] if actual_totals else 0)
    remaining_qty = max(0.0, _float(operation["total_qty"]) - good_qty)
    execution_status = "NOT_STARTED"
    if int((actual_totals or {}).get("output_reports") or 0) > 0 or int((actual_totals or {}).get("reject_reports") or 0) > 0:
        execution_status = "IN_PROGRESS"
    if remaining_qty <= 0 and _float(operation["total_qty"]) > 0:
        execution_status = "DONE"

    planner_ps_id = _validated_ps_id(con, _text(operation["source_ps_id"]))
    con.execute(
        """
        INSERT INTO planner_process_sheet_operation_state (
          operation_id, planner_ps_id, output_qty, reject_qty, good_qty, remaining_qty,
          predicted_start_at, predicted_end_at, execution_status, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (operation_id) DO UPDATE SET
          planner_ps_id      = EXCLUDED.planner_ps_id,
          output_qty         = EXCLUDED.output_qty,
          reject_qty         = EXCLUDED.reject_qty,
          good_qty           = EXCLUDED.good_qty,
          remaining_qty      = EXCLUDED.remaining_qty,
          predicted_start_at = EXCLUDED.predicted_start_at,
          predicted_end_at   = EXCLUDED.predicted_end_at,
          execution_status   = EXCLUDED.execution_status,
          updated_at         = NOW()
        """,
        (
            int(operation_id),
            planner_ps_id,
            output_qty,
            reject_qty,
            good_qty,
            remaining_qty,
            bounds[0] if bounds else None,
            bounds[1] if bounds else None,
            execution_status,
        ),
    )
    return {
        "operation_id": int(operation_id),
        "ps_id": planner_ps_id,
        "remaining_qty": remaining_qty,
        "execution_status": execution_status,
    }


def refresh_process_sheet_state(con, ps_id):
    ps = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (str(ps_id),),
        )
    )
    if not ps:
        return None

    actual_totals = one(
        con.execute(
            """
            SELECT
              COALESCE(SUM(COALESCE(s.output_qty, 0)), 0) AS output_qty,
              COALESCE(SUM(COALESCE(s.reject_qty, 0)), 0) AS reject_qty,
              COALESCE(SUM(COALESCE(s.good_qty, 0)), 0) AS good_qty,
              COALESCE(SUM(COALESCE(s.remaining_qty, 0)), 0) AS remaining_qty
            FROM planner_process_sheet_operation_state s
            WHERE s.planner_ps_id = %s
            """,
            (str(ps_id),),
        )
    )
    bounds = _process_sheet_bounds(con, ps_id)
    output_qty = _float(actual_totals["output_qty"] if actual_totals else 0)
    reject_qty = _float(actual_totals["reject_qty"] if actual_totals else 0)
    good_qty = _float(actual_totals["good_qty"] if actual_totals else 0)
    remaining_qty = _float(actual_totals["remaining_qty"] if actual_totals else 0)

    # planned_qty is the closest equivalent to Vanessa's total_qty in planner_process_sheet
    execution_status = "NOT_STARTED"
    if good_qty > 0:
        execution_status = "IN_PROGRESS"
    if remaining_qty <= 0 and _float(ps["planned_qty"]) > 0:
        execution_status = "DONE"

    is_late = False
    delay_minutes = 0.0
    if bounds and bounds[1]:
        try:
            end_dt = parse_dt_text(bounds[1])
            if end_dt:
                now_dt = datetime.now()
                if end_dt < now_dt and execution_status != "DONE":
                    is_late = True
                    delay_minutes = max(0.0, (now_dt - end_dt).total_seconds() / 60.0)
        except (ValueError, TypeError):
            pass

    con.execute(
        """
        INSERT INTO planner_process_sheet_state (
          planner_ps_id, predicted_start_at, predicted_end_at, output_qty, reject_qty, good_qty,
          remaining_qty, planner_status, execution_status, is_late, delay_minutes, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (planner_ps_id) DO UPDATE SET
          predicted_start_at = EXCLUDED.predicted_start_at,
          predicted_end_at   = EXCLUDED.predicted_end_at,
          output_qty         = EXCLUDED.output_qty,
          reject_qty         = EXCLUDED.reject_qty,
          good_qty           = EXCLUDED.good_qty,
          remaining_qty      = EXCLUDED.remaining_qty,
          planner_status     = EXCLUDED.planner_status,
          execution_status   = EXCLUDED.execution_status,
          is_late            = EXCLUDED.is_late,
          delay_minutes      = EXCLUDED.delay_minutes,
          updated_at         = NOW()
        """,
        (
            str(ps_id),
            bounds[0] if bounds else None,
            bounds[1] if bounds else None,
            output_qty,
            reject_qty,
            good_qty,
            remaining_qty,
            _text(ps["planner_status"] or "UNPLANNED"),
            execution_status,
            is_late,
            delay_minutes,
        ),
    )
    return {
        "ps_id": str(ps_id),
        "remaining_qty": remaining_qty,
        "execution_status": execution_status,
    }


def refresh_states_for_machine(con, machine_id, schedule_run_id=None):
    machine_id = int(machine_id)
    run_id = int(schedule_run_id) if schedule_run_id is not None else None
    con.execute(
        """
        INSERT INTO planner_machine_queue_state (
          block_id, schedule_run_id, predicted_start_at, predicted_end_at, remaining_qty, output_qty,
          reject_qty, good_qty, planned_minutes, schedule_status, execution_status, is_late, delay_minutes, updated_at
        )
        SELECT
          b.block_id,
          COALESCE(%s, b.last_schedule_run_id),
          b.calculated_start_datetime,
          b.calculated_end_datetime,
          GREATEST(0, COALESCE(b.scheduled_qty, 0) - COALESCE(b.actual_good_qty, 0)),
          COALESCE(b.actual_good_qty, 0) + COALESCE(b.actual_reject_qty, 0),
          COALESCE(b.actual_reject_qty, 0),
          COALESCE(b.actual_good_qty, 0),
          CASE
            WHEN b.calculated_start_datetime IS NOT NULL AND b.calculated_end_datetime IS NOT NULL
            THEN GREATEST(0, EXTRACT(EPOCH FROM (b.calculated_end_datetime - b.calculated_start_datetime)) / 60.0)
            ELSE 0
          END,
          COALESCE(NULLIF(b.planning_status, ''), 'UNSCHEDULED'),
          COALESCE(b.execution_status, b.status, 'NOT_STARTED'),
          CASE
            WHEN b.calculated_end_datetime IS NOT NULL
             AND b.calculated_end_datetime < NOW()
             AND COALESCE(b.execution_status, b.status, 'NOT_STARTED') NOT IN ('DONE', 'COMPLETED')
            THEN TRUE ELSE FALSE
          END,
          CASE
            WHEN b.calculated_end_datetime IS NOT NULL
             AND b.calculated_end_datetime < NOW()
             AND COALESCE(b.execution_status, b.status, 'NOT_STARTED') NOT IN ('DONE', 'COMPLETED')
            THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - b.calculated_end_datetime)) / 60.0)
            ELSE 0
          END,
          NOW()
        FROM planner_run_block b
        WHERE b.machine_id = %s
          AND COALESCE(b.active, TRUE) = TRUE
        ON CONFLICT (block_id) DO UPDATE SET
          schedule_run_id    = EXCLUDED.schedule_run_id,
          predicted_start_at = EXCLUDED.predicted_start_at,
          predicted_end_at   = EXCLUDED.predicted_end_at,
          planned_minutes    = EXCLUDED.planned_minutes,
          is_late            = EXCLUDED.is_late,
          delay_minutes      = EXCLUDED.delay_minutes,
          updated_at         = NOW()
        """,
        (run_id, machine_id),
    )
    con.execute(
        """
        UPDATE planner_process_sheet_operation_state s
        SET predicted_start_at = bounds.start_datetime,
            predicted_end_at = bounds.end_datetime,
            updated_at = NOW()
        FROM (
            SELECT b.operation_id,
                   MIN(seg.start_datetime) AS start_datetime,
                   MAX(seg.end_datetime) AS end_datetime
            FROM planner_run_block b
            JOIN planner_run_block_segment seg ON seg.block_id = b.block_id
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(seg.segment_status, 'PLANNED') = 'PLANNED'
            GROUP BY b.operation_id
        ) bounds
        WHERE s.operation_id = bounds.operation_id
        """,
        (machine_id,),
    )
    missing_ops = [
        int(row["operation_id"])
        for row in rows(
            con.execute(
                """
                SELECT DISTINCT b.operation_id
                FROM planner_run_block b
                LEFT JOIN planner_process_sheet_operation_state s ON s.operation_id = b.operation_id
                WHERE b.machine_id = %s
                  AND COALESCE(b.active, TRUE) = TRUE
                  AND COALESCE(b.operation_id, 0) > 0
                  AND s.operation_id IS NULL
                """,
                (machine_id,),
            )
        )
        if int(row["operation_id"] or 0) > 0
    ]
    ps_ids = {
        str(row["ps_id"])
        for row in rows(
            con.execute(
                """
                SELECT DISTINCT COALESCE(o.source_ps_id, '') AS ps_id
                FROM planner_run_block b
                JOIN planner_operation o ON o.operation_id = b.operation_id
                WHERE b.machine_id = %s
                  AND COALESCE(b.active, TRUE) = TRUE
                  AND COALESCE(o.source_ps_id, '') <> ''
                """,
                (machine_id,),
            )
        )
        if compact_text(row.get("ps_id"))
    }
    for operation_id in missing_ops:
        op_state = refresh_operation_state(con, operation_id)
        if op_state and op_state.get("ps_id"):
            ps_ids.add(str(op_state["ps_id"]))
    if ps_ids:
        con.execute(
            """
            UPDATE planner_process_sheet_state s
            SET predicted_start_at = bounds.start_datetime,
                predicted_end_at = bounds.end_datetime,
                updated_at = NOW()
            FROM (
                SELECT o.source_ps_id,
                       MIN(seg.start_datetime) AS start_datetime,
                       MAX(seg.end_datetime) AS end_datetime
                FROM planner_operation o
                JOIN planner_run_block b ON b.operation_id = o.operation_id
                JOIN planner_run_block_segment seg ON seg.block_id = b.block_id
                WHERE COALESCE(o.source_ps_id, '') = ANY(%s)
                  AND COALESCE(seg.segment_status, 'PLANNED') = 'PLANNED'
                GROUP BY o.source_ps_id
            ) bounds
            WHERE s.planner_ps_id = bounds.source_ps_id
            """,
            (list(ps_ids),),
        )
        existing_ps = {
            str(row["planner_ps_id"])
            for row in rows(
                con.execute(
                    """
                    SELECT planner_ps_id
                    FROM planner_process_sheet_state
                    WHERE planner_ps_id = ANY(%s)
                    """,
                    (list(ps_ids),),
                )
            )
            if compact_text(row.get("planner_ps_id"))
        }
        for ps_id in ps_ids:
            if ps_id not in existing_ps:
                refresh_process_sheet_state(con, ps_id)


def _alert_timestamp_for_db(value):
    if value is None or compact_text(value) == "":
        return None
    return planner_timestamptz_for_db(value)


def upsert_schedule_alert(
    con,
    *,
    schedule_run_id=None,
    block_id=None,
    operation_id=None,
    ps_id=None,
    machine_id=None,
    alert_type,
    severity="INFO",
    message="",
    old_value="",
    new_value="",
    planned_at=None,
    predicted_at=None,
    delay_minutes=0,
    status="OPEN",
):
    # Guard FK: planner_schedule_alert.planner_ps_id references planner_process_sheet.
    # ERP-sourced ps_ids won't exist there yet, so use NULL to avoid FK violations.
    ps_id = _validated_ps_id(con, ps_id)

    # IS NOT DISTINCT FROM handles both NULL and non-NULL block_id correctly
    existing = one(
        con.execute(
            """
            SELECT alert_id
            FROM planner_schedule_alert
            WHERE block_id IS NOT DISTINCT FROM %s
              AND alert_type = %s
              AND status IN ('OPEN', 'ACKNOWLEDGED')
            ORDER BY created_at DESC, alert_id DESC
            LIMIT 1
            """,
            (block_id, str(alert_type)),
        )
    )
    params = (
        schedule_run_id,
        block_id,
        operation_id,
        ps_id,
        machine_id,
        str(alert_type),
        severity,
        message,
        old_value,
        new_value,
        _alert_timestamp_for_db(planned_at),
        _alert_timestamp_for_db(predicted_at),
        float(delay_minutes or 0),
        status,
    )
    if existing:
        con.execute(
            """
            UPDATE planner_schedule_alert
            SET schedule_run_id = %s,
                operation_id    = %s,
                planner_ps_id   = %s,
                machine_id      = %s,
                severity        = %s,
                message         = %s,
                old_value       = %s,
                new_value       = %s,
                planned_at      = %s,
                predicted_at    = %s,
                delay_minutes   = %s,
                status          = %s,
                resolved_at     = CASE WHEN %s = 'RESOLVED' THEN NOW() ELSE resolved_at END,
                updated_at      = NOW()
            WHERE alert_id = %s
            """,
            (
                schedule_run_id,
                operation_id,
                ps_id,
                machine_id,
                severity,
                message,
                old_value,
                new_value,
                planned_at,
                predicted_at,
                float(delay_minutes or 0),
                status,
                status,
                int(existing["alert_id"]),
            ),
        )
        return int(existing["alert_id"])

    cur = con.execute(
        """
        INSERT INTO planner_schedule_alert (
          schedule_run_id, block_id, operation_id, planner_ps_id, machine_id, alert_type, severity,
          message, old_value, new_value, planned_at, predicted_at, delay_minutes, status,
          created_at, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
        RETURNING alert_id
        """,
        params,
    )
    return int(one(cur)["alert_id"])


def resolve_schedule_alert(con, alert_id):
    con.execute(
        """
        UPDATE planner_schedule_alert
        SET status      = 'RESOLVED',
            resolved_at = COALESCE(resolved_at, NOW()),
            updated_at  = NOW()
        WHERE alert_id = %s
        """,
        (int(alert_id),),
    )


def snapshot_queue_state(con, machine_id):
    """Return {block_id: row} for all active blocks on machine_id, from planner_machine_queue_state."""
    result = rows(
        con.execute(
            """
            SELECT q.block_id, q.predicted_start_at, q.predicted_end_at,
                   o.job_no, o.operation_name
            FROM planner_machine_queue_state q
            JOIN planner_run_block b ON b.block_id = q.block_id
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.machine_id = %s AND COALESCE(b.active, TRUE) = TRUE
            """,
            (int(machine_id),),
        )
    )
    return {int(row["block_id"]): row for row in result}


def snapshot_queue_state_all(con, machine_ids):
    """Return {machine_id: {block_id: row}} for all given machine_ids."""
    return {int(mid): snapshot_queue_state(con, mid) for mid in machine_ids}


def compute_change_summary(old_snap, new_snap, machine_id=None):
    """Diff two {block_id: row} snapshots into a structured change summary dict."""
    old_ids = set(old_snap)
    new_ids = set(new_snap)

    removed = []
    for bid in sorted(old_ids - new_ids):
        r = old_snap[bid]
        removed.append({
            "block_id": bid,
            "job_no": _text(r.get("job_no")),
            "op_name": _text(r.get("operation_name")),
            "old_start": r["predicted_start_at"].isoformat() if r.get("predicted_start_at") else None,
            "old_end": r["predicted_end_at"].isoformat() if r.get("predicted_end_at") else None,
        })

    added = []
    for bid in sorted(new_ids - old_ids):
        r = new_snap[bid]
        added.append({
            "block_id": bid,
            "job_no": _text(r.get("job_no")),
            "op_name": _text(r.get("operation_name")),
            "new_start": r["predicted_start_at"].isoformat() if r.get("predicted_start_at") else None,
            "new_end": r["predicted_end_at"].isoformat() if r.get("predicted_end_at") else None,
        })

    shifted = []
    for bid in sorted(old_ids & new_ids):
        o = old_snap[bid]
        n = new_snap[bid]
        old_s = o.get("predicted_start_at")
        new_s = n.get("predicted_start_at")
        old_e = o.get("predicted_end_at")
        new_e = n.get("predicted_end_at")
        if old_s == new_s and old_e == new_e:
            continue
        entry = {
            "block_id": bid,
            "job_no": _text(o.get("job_no")),
            "op_name": _text(o.get("operation_name")),
            "old_start": old_s.isoformat() if old_s else None,
            "new_start": new_s.isoformat() if new_s else None,
            "old_end": old_e.isoformat() if old_e else None,
            "new_end": new_e.isoformat() if new_e else None,
        }
        if old_s and new_s:
            entry["shift_minutes"] = round((new_s - old_s).total_seconds() / 60.0, 1)
        shifted.append(entry)

    summary = {
        "blocks_shifted": shifted,
        "blocks_added": added,
        "blocks_removed": removed,
        "unchanged_count": max(0, len(old_ids & new_ids) - len(shifted)),
        "total_blocks": len(new_ids),
    }
    if machine_id is not None:
        summary["machine_id"] = int(machine_id)
    return summary


def find_superseded_run_id(con, new_run_id, machine_id, scope_type):
    """Return the schedule_run_id that was just superseded when new_run_id was created."""
    row = one(
        con.execute(
            """
            SELECT schedule_run_id
            FROM planner_schedule_run
            WHERE status = 'SUPERSEDED'
              AND scope_type = %s
              AND machine_id IS NOT DISTINCT FROM %s
              AND schedule_run_id < %s
            ORDER BY schedule_run_id DESC
            LIMIT 1
            """,
            (scope_type, int(machine_id) if machine_id is not None else None, int(new_run_id)),
        )
    )
    return int(row["schedule_run_id"]) if row else None


def write_change_summary(con, superseded_run_id, summary):
    """Write a change summary JSON to the given superseded schedule run."""
    con.execute(
        "UPDATE planner_schedule_run SET change_summary = %s WHERE schedule_run_id = %s",
        (json.dumps(summary), int(superseded_run_id)),
    )
