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

from datetime import datetime, timedelta

from .actuals import actual_totals_for_block
from .helpers import one, rows, parse_dt_text


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


def refresh_machine_queue_state(con, block_id, schedule_run_id=None):
    block = one(
        con.execute(
            """
            SELECT b.*, COALESCE(v.remaining_qty, 0) AS remaining_qty,
                   COALESCE(v.good_qty, 0) AS good_qty,
                   COALESCE(a.output_qty, 0) AS output_qty,
                   COALESCE(a.reject_qty, 0) AS reject_qty
            FROM planner_run_block b
            LEFT JOIN planner_v_block_remaining v ON v.block_id = b.block_id
            LEFT JOIN planner_v_block_actual_totals a ON a.block_id = b.block_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not block:
        return None

    bounds = _segment_bounds(con, block_id)
    planned_start = block["planned_start_at"] or (bounds[0] if bounds else None)
    planned_end = block["planned_end_at"] or (bounds[1] if bounds else None)

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

    output_qty = _float(block["output_qty"])
    reject_qty = _float(block["reject_qty"])
    good_qty = _float(block["good_qty"])
    remaining_qty = _float(block["remaining_qty"])
    execution_status = _text(block["execution_status"] or block["status"] or "NOT_STARTED")
    schedule_status = _text(block["planning_status"] or "UNSCHEDULED")

    is_late = False
    delay_minutes = 0.0
    if planned_end:
        try:
            end_dt = parse_dt_text(planned_end)
            if end_dt:
                now_dt = datetime.now()
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
            planned_start or None,
            planned_end or None,
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
    block_rows = rows(
        con.execute(
            "SELECT block_id, operation_id FROM planner_run_block WHERE machine_id = %s",
            (int(machine_id),),
        )
    )
    operation_ids = set()
    ps_ids = set()
    for row in block_rows:
        block_id = int(row["block_id"])
        operation_id = int(row["operation_id"] or 0)
        refresh_machine_queue_state(con, block_id, schedule_run_id=schedule_run_id)
        if operation_id:
            operation_ids.add(operation_id)
            op_state = refresh_operation_state(con, operation_id)
            if op_state and op_state.get("ps_id"):
                ps_ids.add(op_state["ps_id"])
    for operation_id in operation_ids:
        op_row = one(
            con.execute(
                "SELECT COALESCE(source_ps_id, '') AS ps_id FROM planner_operation WHERE operation_id = %s",
                (int(operation_id),),
            )
        )
        if op_row and op_row["ps_id"]:
            ps_ids.add(str(op_row["ps_id"]))
    for ps_id in ps_ids:
        refresh_process_sheet_state(con, ps_id)


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
        planned_at,
        predicted_at,
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
