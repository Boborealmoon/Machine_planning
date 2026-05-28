#!/usr/bin/env python3
"""Smoke test: planner daily actuals API (PostgreSQL / main app)."""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def pass_msg(message: str) -> None:
    print(f"PASS: {message}")


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    try:
        from db import planner_get_conn, planner_release_conn
    except Exception as exc:
        return fail(f"db import failed: {exc}")

    try:
        conn = planner_get_conn()
    except Exception as exc:
        return fail(f"planner DB connect failed (set SUPA_DB_URL in .env): {exc}")

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT EXISTS (
                  SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public'
                    AND table_name = 'planner_block_removed_actual_date'
                ) AS ok
                """
            )
            row = cur.fetchone()
            if not row or not row[0]:
                return fail("planner_block_removed_actual_date table missing — run schema_planner.sql migration")
        pass_msg("planner_block_removed_actual_date table exists")
    finally:
        planner_release_conn(conn)

    from planning.helpers import one, planner_db, rows
    from app import app

    token = uuid.uuid4().hex[:8]
    temp_ps_id = f"SMOKE-ACTUAL-{token}::1"
    temp_job = f"SA-{token.upper()}"
    report_date = "2099-06-15"
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
                ) VALUES (%s, %s, 1, '', 'UNPLANNED', 'ACTIVE', 10, 0)
                ON CONFLICT (planner_ps_id) DO NOTHING
                """,
                (temp_ps_id, temp_ps_id.split("::", 1)[0]),
            )
            operation = one(
                con.execute(
                    """
                    INSERT INTO planner_operation (
                      job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty,
                      compatible_machine_group, source_ps_id, source_op_seq_id, source_op_no, status
                    ) VALUES (%s, 'OP10', 10, 30, 2, 'ALL', %s, 0, '10', 'ACTIVE')
                    RETURNING operation_id
                    """,
                    (temp_job, temp_ps_id),
                )
            )
            block = one(
                con.execute(
                    """
                    INSERT INTO planner_run_block (
                      operation_id, machine_id, queue_position, scheduled_qty, include_setup,
                      status, planning_status, execution_status, active
                    ) VALUES (%s, %s, 9999, 10, TRUE, 'PLANNED', 'PLANNED', 'NOT_STARTED', TRUE)
                    RETURNING block_id, machine_id
                    """,
                    (int(operation["operation_id"]), int(machine["machine_id"])),
                )
            )
            start = datetime(2099, 6, 15, 8, 0, tzinfo=timezone.utc)
            end = start + timedelta(hours=4)
            con.execute(
                """
                INSERT INTO planner_run_block_segment (
                  block_id, machine_id, segment_date, segment_type, qty_done, minutes_used,
                  planned_qty, planned_minutes, start_datetime, end_datetime
                ) VALUES (%s, %s, %s::date, 'production', 5, 120, 5, 120, %s, %s)
                """,
                (
                    int(block["block_id"]),
                    int(machine["machine_id"]),
                    report_date,
                    start,
                    end,
                ),
            )
            return {
                "block_id": int(block["block_id"]),
                "machine_id": int(machine["machine_id"]),
                "operation_id": int(operation["operation_id"]),
                "planner_ps_id": temp_ps_id,
            }

    def _cleanup_fixture(data):
        if not data:
            return
        with planner_db() as con:
            con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (data["block_id"],))
            con.execute("DELETE FROM planner_operation WHERE operation_id = %s", (data["operation_id"],))
            con.execute("DELETE FROM planner_process_sheet WHERE planner_ps_id = %s", (data["planner_ps_id"],))

    client = app.test_client()
    fixture = None

    try:
        fixture = _create_fixture()
        pass_msg(f"fixture block_id={fixture['block_id']}")

        page = client.get("/scheduler")
        if page.status_code != 200:
            return fail(f"GET /scheduler returned {page.status_code}")
        html = page.get_data(as_text=True)
        if "js/scheduler/actuals.js" not in html:
            return fail("/scheduler does not load js/scheduler/actuals.js")
        pass_msg("/scheduler loads planner actuals JS")

        save = client.post(
            f"/api/trial/blocks/{fixture['block_id']}/actual",
            json={
                "daily_actuals": [
                    {
                        "report_date": report_date,
                        "target_qty": 5,
                        "output_qty": "3",
                        "reject_qty": "0",
                        "remarks": "smoke test",
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
        if not data.get("block"):
            return fail("response missing block payload")
        daily_rows = data.get("actual_daily_rows") or (data.get("block") or {}).get("actual_daily_rows") or []
        if not daily_rows:
            return fail("response missing actual_daily_rows")
        matched = [r for r in daily_rows if str(r.get("report_date") or "") == report_date]
        if not matched:
            return fail(f"actual_daily_rows has no row for {report_date}")
        if str(matched[0].get("output_qty")) not in ("3", "3.0"):
            return fail(f"unexpected output_qty in daily row: {matched[0].get('output_qty')!r}")
        pass_msg("POST /api/trial/blocks/<id>/actual saves and returns actual_daily_rows")

        with planner_db() as con:
            saved = one(
                con.execute(
                    """
                    SELECT output_qty, reject_qty, remarks
                    FROM planner_production_actual
                    WHERE block_id = %s
                      AND report_date = %s::date
                      AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                    ORDER BY actual_id DESC
                    LIMIT 1
                    """,
                    (fixture["block_id"], report_date),
                )
            )
            if not saved:
                return fail("planner_production_actual row not found after save")
            if float(saved["output_qty"] or 0) != 3.0:
                return fail(f"DB output_qty expected 3, got {saved['output_qty']!r}")
        pass_msg("planner_production_actual persisted in database")

        empty = client.post(f"/api/trial/blocks/{fixture['block_id']}/actual", json={})
        if empty.status_code != 400:
            return fail(f"empty payload expected 400, got {empty.status_code}")
        if (empty.get_json() or {}).get("error") != "No actual rows submitted.":
            return fail(f"unexpected empty error: {empty.get_json()!r}")
        pass_msg("empty payload rejected with clear error")

        sched = client.get(f"/api/trial/schedule?machine_ids={fixture['machine_id']}&lite=1")
        if sched.status_code != 200:
            return fail(f"GET schedule returned {sched.status_code}")
        sched_blocks = (sched.get_json() or {}).get("blocks") or []
        sched_block = next((b for b in sched_blocks if int(b.get("block_id") or 0) == fixture["block_id"]), None)
        if not sched_block:
            return fail("fixture block missing from schedule refresh")
        if not sched_block.get("actual_daily_rows"):
            return fail("schedule block missing actual_daily_rows")
        if not str(sched_block.get("actual_start_at") or "").strip():
            return fail("schedule block missing actual_start_at after save")
        pass_msg("schedule API includes actual_daily_rows and actual timing on blocks")

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

    print("PASS: smoke_planner_actual_daily completed successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())
