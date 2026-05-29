"""Profile /api/trial/schedule?lite=1 sections."""
import sys
import time

sys.path.insert(0, ".")

from flask import Flask

from planning.auto_unschedule import auto_unschedule_on_page_load
from planning.erp_actuals import ensure_erp_snapshot_table
from planning.helpers import one, parse_dt_text, planner_db, rows
from planning.planner_actuals import actual_summaries_for_block_rows
from planning.planner_routes import _api_trial_schedule_db
from planning.utils import compact_text
from planning.visual_time import visual_timing_for_segment


def tick(label, t0):
    elapsed = time.perf_counter() - t0
    print(f"{label}: {elapsed:.2f}s")
    return time.perf_counter()


with planner_db() as con:
    t0 = time.perf_counter()
    auto_unschedule_on_page_load(con)
    t0 = tick("auto_unschedule", t0)

    stale = rows(
        con.execute(
            """
            SELECT card_id, planner_ps_id AS ps_id, scheduled_block_group_id
            FROM planner_planning_card
            WHERE card_type = 'COMBINED'
              AND planning_status = 'SCHEDULED'
              AND COALESCE(scheduled_block_group_id, 0) > 0
            """
        )
    )
    t0 = tick(f"stale cards query ({len(stale)})", t0)
    for card in stale:
        group_id = int(card["scheduled_block_group_id"] or 0)
        one(
            con.execute(
                "SELECT COUNT(*) AS cnt FROM planner_run_block WHERE group_id = %s",
                (group_id,),
            )
        )
    t0 = tick("stale card loop", t0)

    machines = rows(
        con.execute(
            """
            SELECT machine_id, machine_no AS machine_code, machine_category, shift_profile, active
            FROM planner_machines
            WHERE active = TRUE
            ORDER BY machine_id
            """
        )
    )
    machine_by_id = {int(row["machine_id"]): dict(row) for row in machines}
    t0 = tick("machines", t0)

    raw_blocks = rows(
        con.execute(
            """
            SELECT b.*, o.job_no, o.operation_name, o.total_qty, o.setup_minutes, o.cycle_minutes_per_qty,
                   o.compatible_machine_group, o.source_ps_id, o.source_op_seq_id AS source_op_seq_id, o.source_op_no,
                   m.machine_no AS machine_code, m.machine_category, m.shift_profile,
                   g.group_label AS group_label, g.group_type AS group_type,
                   os.operation_sequence_id AS operation_sequence_id,
                   os.sequence_no AS sequence_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            LEFT JOIN planner_run_block_group g ON g.group_id = b.group_id
            LEFT JOIN planner_operation_sequence os ON os.block_id = b.block_id
            WHERE COALESCE(b.active, TRUE) = TRUE
            ORDER BY b.machine_id, b.queue_position, b.block_id
            """
        )
    )
    t0 = tick(f"raw_blocks ({len(raw_blocks)})", t0)

    block_ids = [int(b["block_id"]) for b in raw_blocks]
    raw_segments = rows(
        con.execute(
            """
            SELECT s.*, b.operation_id
            FROM planner_run_block_segment s
            JOIN planner_run_block b ON b.block_id = s.block_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND s.block_id = ANY(%s)
            ORDER BY b.machine_id, b.queue_position, s.segment_id
            """,
            (block_ids,),
        )
    )
    t0 = tick(f"segments ({len(raw_segments)})", t0)

    segments_by_block = {}
    for row in raw_segments:
        item = dict(row)
        machine = machine_by_id.get(int(item.get("machine_id") or 0), {})
        shift_profile = compact_text(machine.get("shift_profile") or item.get("shift_profile") or "")
        start_dt = parse_dt_text(item.get("start_datetime"))
        end_dt = parse_dt_text(item.get("end_datetime"))
        timing = visual_timing_for_segment(
            start_dt,
            item.get("minutes_used") or 0,
            end_dt=end_dt,
            work_date=start_dt.date() if start_dt else None,
            profile_name="",
            shift_profile=shift_profile,
            segment_type=item.get("segment_type") or "production",
        )
        item["visual_start_datetime"] = timing["visual_start_datetime"]
        item["visual_end_datetime"] = timing["visual_end_datetime"]
        item["visual_parts"] = timing["visual_parts"]
        item["break_windows"] = timing["break_windows"]
        segments_by_block.setdefault(int(item.get("block_id") or 0), []).append(item)
    t0 = tick("segment visual timing (+parts)", t0)

    blocks = []
    for row in raw_blocks:
        item = dict(row)
        block_segments = segments_by_block.get(int(item.get("block_id") or 0), [])
        if block_segments:
            block_start_dt = parse_dt_text(item.get("anchor_datetime") or item.get("calculated_start_datetime"))
            block_end_dt = parse_dt_text(item.get("calculated_end_datetime"))
            visual_starts = sorted(
                [
                    compact_text(seg.get("visual_start_datetime"))
                    for seg in block_segments
                    if compact_text(seg.get("visual_start_datetime"))
                ]
            )
            timing = (
                visual_timing_for_segment(
                    block_start_dt,
                    item.get("minutes_used") or 0,
                    end_dt=block_end_dt,
                    work_date=block_start_dt.date() if block_start_dt else None,
                    profile_name="",
                    shift_profile=compact_text(
                        item.get("shift_profile")
                        or machine_by_id.get(int(item.get("machine_id") or 0), {}).get("shift_profile", "")
                    ),
                    segment_type=item.get("segment_type") or "production",
                )
                if block_start_dt
                else {"visual_start_datetime": "", "visual_end_datetime": ""}
            )
            item["visual_start_datetime"] = timing.get("visual_start_datetime") or ""
            visual_parts = []
            for seg in block_segments:
                visual_parts.extend(seg.get("visual_parts") or [])
            item["visual_parts"] = visual_parts
        blocks.append(item)
    t0 = tick("block visual timing (+parts)", t0)

    actual_summaries_for_block_rows(con, blocks)
    tick("actual_summaries", t0)

with planner_db() as con:
    t0 = time.perf_counter()
    ensure_erp_snapshot_table(con)
    print(f"ensure_erp_snapshot_table: {time.perf_counter() - t0:.2f}s")

app = Flask(__name__)
for run in range(2):
    with app.test_request_context("/api/trial/schedule?lite=1"):
        t0 = time.perf_counter()
        resp = _api_trial_schedule_db()
        data = resp.get_json()
        elapsed = time.perf_counter() - t0
        print(
            f"full api run {run + 1}: {elapsed:.2f}s "
            f"blocks={len(data.get('blocks', []))} "
            f"segs={len(data.get('segments', []))} "
            f"actuals={len(data.get('actuals', []))}"
        )
