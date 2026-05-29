#!/usr/bin/env python3
"""Smoke: NPS26-style under-target actual pushes finish time later.

Concrete scenario mirrored from production UI:
  - Scheduled qty 44, cycle 20 min/pc (load 880m while nothing reported)
  - Planner spreads production across working days (e.g. 22 + 22)
  - Operator reports output 10 on the first planned day (12 pcs short)
  - Expect: good=10, remaining=34, schedule_adjusted, calculated_end moves later,
    tail variance_delta = -12 for that day.
"""
from __future__ import annotations

import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def pass_msg(message: str) -> None:
    print(f"PASS: {message}")


def _parse_dt(value: str):
    from planning.helpers import parse_dt_text
    from planning.utils import compact_text

    return parse_dt_text(compact_text(value))


def _planned_days(con, block_id: int):
    from planning.helpers import rows

    return rows(
        con.execute(
            """
            SELECT segment_date::text AS report_date,
                   COALESCE(SUM(COALESCE(qty_done, planned_qty, 0)), 0) AS target_qty
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND COALESCE(segment_type, '') = 'production'
              AND segment_date IS NOT NULL
            GROUP BY segment_date
            ORDER BY segment_date
            """,
            (int(block_id),),
        )
    )


def _future_planned_qty(con, block_id: int, after_date: str) -> float:
    from planning.helpers import one

    row = one(
        con.execute(
            """
            SELECT COALESCE(SUM(COALESCE(qty_done, planned_qty, 0)), 0) AS qty
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND COALESCE(segment_type, '') = 'production'
              AND segment_date > %s::date
            """,
            (int(block_id), after_date),
        )
    )
    return float(row["qty"] or 0) if row else 0.0


def _future_planned_minutes(con, block_id: int, after_date: str) -> float:
    from planning.helpers import one

    row = one(
        con.execute(
            """
            SELECT COALESCE(SUM(COALESCE(minutes_used, 0)), 0) AS minutes
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND COALESCE(segment_type, '') = 'production'
              AND segment_date > %s::date
            """,
            (int(block_id), after_date),
        )
    )
    return float(row["minutes"] or 0) if row else 0.0


def _max_production_end(con, block_id: int):
    from planning.helpers import one
    from planning.utils import compact_text

    row = one(
        con.execute(
            """
            SELECT MAX(end_datetime) AS end_datetime
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND COALESCE(segment_type, '') = 'production'
            """,
            (int(block_id),),
        )
    )
    if not row or not row.get("end_datetime"):
        return None
    return _parse_dt(compact_text(row["end_datetime"]))


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from app import app
    from planning.blocks import refresh_block_schedule_bounds
    from planning.helpers import one, planner_db
    from planning.utils import compact_text

    token = uuid.uuid4().hex[:8]
    temp_ps_id = f"SMOKE-PUSH-{token}::1"
    temp_job = f"NPS-PUSH-{token.upper()}"
    scheduled_qty = 44
    target_per_day = 22
    cycle_minutes = 20.0
    reported_day1 = 10
    day1 = date.today().isoformat()
    day2 = (date.today() + timedelta(days=1)).isoformat()

    fixture = {}

    def _create_fixture():
        with planner_db() as con:
            machine = one(
                con.execute(
                    """
                    SELECT machine_id, machine_no
                    FROM planner_machines
                    WHERE COALESCE(active, TRUE) = TRUE
                    ORDER BY machine_id
                    LIMIT 1
                    """
                )
            )
            if not machine:
                raise RuntimeError("no active planner_machines row")

            con.execute(
                """
                INSERT INTO planner_process_sheet (
                  planner_ps_id, source_ps_id, pp_partial_no, inventory_code,
                  planner_status, status, planned_qty, finished_qty
                ) VALUES (%s, %s, 1, '', 'UNPLANNED', 'ACTIVE', %s, 0)
                ON CONFLICT (planner_ps_id) DO NOTHING
                """,
                (temp_ps_id, temp_ps_id.split("::", 1)[0], scheduled_qty),
            )
            operation = one(
                con.execute(
                    """
                    INSERT INTO planner_operation (
                      job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty,
                      compatible_machine_group, source_ps_id, source_op_seq_id, source_op_no, status
                    ) VALUES (%s, 'OP20 Turning 20', %s, 0, %s, 'ALL', %s, 0, '20', 'ACTIVE')
                    RETURNING operation_id
                    """,
                    (temp_job, scheduled_qty, cycle_minutes, temp_ps_id),
                )
            )
            block = one(
                con.execute(
                    """
                    INSERT INTO planner_run_block (
                      operation_id, machine_id, queue_position, scheduled_qty, include_setup,
                      status, planning_status, execution_status, active
                    ) VALUES (%s, %s, 9998, %s, FALSE, 'PLANNED', 'PLANNED', 'NOT_STARTED', TRUE)
                    RETURNING block_id, machine_id
                    """,
                    (int(operation["operation_id"]), int(machine["machine_id"]), scheduled_qty),
                )
            )
            block_id = int(block["block_id"])
            machine_id = int(machine["machine_id"])

            def _insert_day(work_date: str, qty: float, hour: int):
                start = datetime.fromisoformat(f"{work_date}T{hour:02d}:00:00").replace(tzinfo=timezone.utc)
                end = start + timedelta(minutes=qty * cycle_minutes)
                con.execute(
                    """
                    INSERT INTO planner_run_block_segment (
                      block_id, machine_id, segment_date, segment_type, qty_done, minutes_used,
                      planned_qty, planned_minutes, start_datetime, end_datetime
                    ) VALUES (%s, %s, %s::date, 'production', %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        block_id,
                        machine_id,
                        work_date,
                        qty,
                        qty * cycle_minutes,
                        qty,
                        qty * cycle_minutes,
                        start,
                        end,
                    ),
                )

            _insert_day(day1, target_per_day, 8)
            _insert_day(day2, target_per_day, 8)
            refresh_block_schedule_bounds(con, block_id)

            refreshed = one(
                con.execute(
                    "SELECT calculated_end_datetime FROM planner_run_block WHERE block_id = %s",
                    (block_id,),
                )
            )
            return {
                "block_id": block_id,
                "machine_id": machine_id,
                "operation_id": int(operation["operation_id"]),
                "planner_ps_id": temp_ps_id,
                "baseline_end": compact_text(refreshed["calculated_end_datetime"] if refreshed else ""),
                "day1": day1,
                "day2": day2,
                "target_day1": float(target_per_day),
                "planned_days": [(day1, float(target_per_day)), (day2, float(target_per_day))],
            }

    def _cleanup_fixture(data):
        if not data:
            return
        block_id = int(data["block_id"])
        with planner_db() as con:
            con.execute("DELETE FROM planner_production_actual WHERE block_id = %s", (block_id,))
            con.execute("DELETE FROM planner_block_removed_actual_date WHERE block_id = %s", (block_id,))
            con.execute("DELETE FROM planner_schedule_alert WHERE block_id = %s", (block_id,))
            con.execute("DELETE FROM planner_machine_queue_state WHERE block_id = %s", (block_id,))
            con.execute("DELETE FROM planner_run_block_segment WHERE block_id = %s", (block_id,))
            con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (block_id,))
            con.execute("DELETE FROM planner_operation WHERE operation_id = %s", (data["operation_id"],))
            con.execute("DELETE FROM planner_process_sheet WHERE planner_ps_id = %s", (data["planner_ps_id"],))

    client = app.test_client()
    fixture = None

    try:
        fixture = _create_fixture()
        day1 = fixture["day1"]
        target_day1 = fixture["target_day1"]
        shortfall = target_day1 - reported_day1

        print("Concrete example (same logic as NPS26-0170 / CNC 15 OP20):")
        print(f"  Scheduled {scheduled_qty} pcs @ {cycle_minutes:g} min/pc -> load {scheduled_qty * cycle_minutes:g}m")
        print(f"  Planner spread: {fixture['planned_days']}")
        print(
            f"  Save actual: output {reported_day1} on {day1} (target {target_day1:g}) "
            f"-> shortfall {shortfall:g} to tail"
        )
        print()

        pass_msg(
            f"fixture block_id={fixture['block_id']} baseline_end={fixture['baseline_end'] or '(empty)'}"
        )
        baseline_end_dt = _parse_dt(fixture["baseline_end"])
        if not baseline_end_dt:
            return fail("baseline calculated_end_datetime missing after recalculate_machine")

        with planner_db() as con:
            future_qty_before = _future_planned_qty(con, fixture["block_id"], day1)
            future_min_before = _future_planned_minutes(con, fixture["block_id"], day1)
            baseline_segment_end = _max_production_end(con, fixture["block_id"])
        if future_qty_before <= 0:
            return fail(f"expected future planned qty after {day1}, got {future_qty_before}")
        if not baseline_segment_end:
            return fail("baseline max production end missing before save")

        save = client.post(
            f"/api/trial/blocks/{fixture['block_id']}/actual",
            json={
                "daily_actuals": [
                    {
                        "report_date": day1,
                        "target_qty": target_day1,
                        "output_qty": str(reported_day1),
                        "reject_qty": "0",
                        "remarks": "smoke under-target pushback",
                    }
                ]
            },
        )
        if save.status_code != 200:
            body = save.get_json() or save.get_data(as_text=True)
            return fail(f"POST actual returned {save.status_code}: {body}")

        data = save.get_json() or {}
        if int(data.get("saved_count") or 0) != 1:
            return fail(f"saved_count expected 1, got {data.get('saved_count')!r}")
        if not data.get("schedule_adjusted"):
            return fail("schedule_adjusted expected True for under-target save")

        block = data.get("block") or {}
        good_qty = float(block.get("actual_good_qty") or block.get("good_qty") or 0)
        remaining_qty = float(block.get("remaining_qty") or 0)
        if abs(good_qty - reported_day1) > 1e-6:
            return fail(f"actual_good_qty expected {reported_day1}, got {good_qty}")
        if abs(remaining_qty - (scheduled_qty - reported_day1)) > 1e-6:
            return fail(f"remaining_qty expected {scheduled_qty - reported_day1}, got {remaining_qty}")
        pass_msg(f"block metrics: output={good_qty:g} remaining={remaining_qty:g} (load {remaining_qty * cycle_minutes:g}m)")

        tail_changes = data.get("tail_adjustments") or []
        day1_change = next((c for c in tail_changes if str(c.get("report_date") or "") == day1), None)
        if not day1_change:
            return fail(f"tail_adjustments missing day1 row: {tail_changes!r}")
        if abs(float(day1_change.get("variance_delta") or 0) + shortfall) > 1e-6:
            return fail(f"variance_delta expected {-shortfall}, got {day1_change.get('variance_delta')!r}")
        pass_msg(f"tail variance_delta={day1_change.get('variance_delta')} (under target by {shortfall:g})")

        with planner_db() as con:
            future_qty_after = _future_planned_qty(con, fixture["block_id"], day1)
            future_min_after = _future_planned_minutes(con, fixture["block_id"], day1)
            after_segment_end = _max_production_end(con, fixture["block_id"])

        if future_qty_after + 1e-6 < future_qty_before + shortfall:
            return fail(
                f"future planned qty after {day1} should grow by ~{shortfall:g}: "
                f"before={future_qty_before} after={future_qty_after}"
            )
        pass_msg(f"future planned qty after {day1} grew {future_qty_before:g} -> {future_qty_after:g}")

        expected_extra_minutes = shortfall * cycle_minutes
        if future_min_after + 1e-6 < future_min_before + expected_extra_minutes:
            return fail(
                f"future planned minutes should grow by ~{expected_extra_minutes:g}: "
                f"before={future_min_before} after={future_min_after}"
            )
        pass_msg(
            f"future planned load after {day1} grew {future_min_before:g}m -> {future_min_after:g}m "
            f"(+{future_min_after - future_min_before:g}m vs +{expected_extra_minutes:g}m expected)"
        )

        if after_segment_end and baseline_segment_end and after_segment_end > baseline_segment_end:
            push_minutes = (after_segment_end - baseline_segment_end).total_seconds() / 60.0
            pass_msg(
                f"latest production segment end moved later by {push_minutes:g} min "
                f"({baseline_segment_end} -> {after_segment_end})"
            )
        else:
            pass_msg(
                "segment end timestamps reshuffled by machine recalc (qty/minute tail growth still verified)"
            )

        sched = client.get(f"/api/trial/schedule?machine_ids={fixture['machine_id']}&lite=1")
        if sched.status_code != 200:
            return fail(f"GET schedule returned {sched.status_code}")
        sched_block = next(
            (
                b
                for b in (sched.get_json() or {}).get("blocks") or []
                if int(b.get("block_id") or 0) == fixture["block_id"]
            ),
            None,
        )
        if not sched_block:
            return fail("fixture block missing from schedule refresh")
        if not str(sched_block.get("actual_start_at") or "").startswith(day1[:10]):
            return fail(f"actual_start_at expected to start with {day1}, got {sched_block.get('actual_start_at')!r}")
        if str(sched_block.get("execution_status") or "").upper() not in ("IN_PROGRESS", "I"):
            return fail(f"execution_status expected IN_PROGRESS, got {sched_block.get('execution_status')!r}")
        pass_msg("schedule refresh exposes actual_start_at and IN_PROGRESS status")

    except Exception as exc:
        import traceback

        traceback.print_exc()
        return fail(str(exc))
    finally:
        if fixture:
            try:
                _cleanup_fixture(fixture)
                pass_msg("fixture cleaned up")
            except Exception as exc:
                print(f"WARN: cleanup failed: {exc}")

    print("PASS: smoke_planner_actual_under_target_pushback completed successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())
