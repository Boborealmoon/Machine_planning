"""planning/planner_routes.py — Planner schedule API (PostgreSQL port of Vanessa's routes/planner.py).

Key changes vs SQLite original:
  db()                      → planner_db()
  planning_card.ps_id       → planner_planning_card.planner_ps_id  (aliased ps_id in queries)
  run_block                 → planner_run_block
  operation                 → planner_operation
  machines m.machine_code   → planner_machines m.machine_no AS machine_code
  run_block_segment         → planner_run_block_segment
  run_block_group           → planner_run_block_group
  production_actual         → planner_production_actual
  machine_calendar_window   → planner_machine_calendar_window
  machine_capacity_day      → planner_machine_capacity_day
  capacity_profile          → planner_capacity_profile
  cur.lastrowid             → RETURNING + one(cur)["pk"]
  CURRENT_TIMESTAMP         → NOW()
  active = 1 / 0            → TRUE / FALSE
  ? IN (?,?)                → = ANY(%s) with list param
  '', '' for TIMESTAMPTZ    → NULL
  include_setup 1/0         → Python bool
"""
from __future__ import annotations

import threading
import time
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request

from .actuals import refresh_block_actual_status
from .blocks import (
    _actual_good_qty,
    _actual_variance,
    _row_planner_ps_identity,
    apply_actual_variance_delta_to_block_tail,
    apply_output_delta_to_block_tail,
    apply_removed_target_date_to_block_tail,
    actual_daily_rows_for_block_row,
    attach_actual_daily_to_blocks,
    create_rework_from_reject,
    create_dummy_card,
    update_dummy_card,
    delete_dummy_card,
    is_dummy_block_row,
    delete_rework_from_reject_segment,
    find_rework_source_for_reject,
    recalculate_all,
    recalculate_machine,
    recalculate_machines,
    refresh_block_group_label,
    refresh_block_schedule_bounds,
    removed_actual_dates_for_block_row,
    schedule_signature_for_machine,
    dedupe_machine_catalog_queue,
    find_active_catalog_lane_block,
    attach_block_ps_identity,
    planner_ps_id_from_block_row,
    merge_deleted_split_block_qty,
    trial_block_payload,
    trial_block_row,
)
from .catalog import (
    combined_group_summary,
    create_planning_card,
    planning_card_row,
    planning_cards_by_ps,
    schedule_planning_card,
    trial_catalog_items,
)
from .helpers import planner_db, one, planner_try_savepoint, rows, parse_dt_text
from .materials import material_status_map_for_ps_ids, sync_material_requirements_for_ps_ids
from .operation_sequence import apply_machine_queue_order, apply_machine_queue_orders
from .process_sheets import (
    due_date_map_for_planner_ps_ids,
    ensure_planner_process_sheet,
    format_planner_ps_id,
    is_temp_planner_ps_id,
    list_delivery_schedule_board_items,
    list_process_sheets_payload,
    material_in_map_for_planner_ps_ids,
    parse_planner_ps_id,
    tooling_map_for_operation_ids,
)
from .machines import (
    default_profile_for_weekday,
    fetch_machines,
    fetch_scheduler_machines,
    is_mpp_planner_owned_block,
    scheduler_blocks_exclude_mpp_planner_clause,
    is_public_holiday,
    MPP_PLANNER_GUARD_MSG,
)
from .sg_public_holidays import fetch_sg_public_holidays, list_public_holidays, sync_sg_public_holidays_to_db
from .planner_actuals import actual_summaries_for_block_rows
from .visual_time import visual_timing_for_segment
from .utils import (
    compact_text,
    format_qty,
    normalize_block_status_inputs,
    parse_nullable_number,
    parse_number,
    planner_wall_datetime_from_input,
    planner_wall_datetime_to_api,
    validate_cycle_minutes,
)

trial_bp = Blueprint("trial", __name__)


def _mpp_planner_block_guard(con, block):
    """Reject main-planner mutations on blocks owned by the MPP planner tab."""
    if not block:
        return None
    if is_mpp_planner_owned_block(con, int(block.get("block_id") or 0)):
        return jsonify({"error": MPP_PLANNER_GUARD_MSG}), 400
    return None


def _parse_recalculate_flag(data):
    """Request body recalculate flag; default True for backward compatibility."""
    if not isinstance(data, dict) or "recalculate" not in data:
        return True
    value = data.get("recalculate")
    if isinstance(value, bool):
        return value
    text = compact_text(value).lower()
    if text in {"0", "false", "no", "off"}:
        return False
    if text in {"1", "true", "yes", "on"}:
        return True
    return bool(value)


def _visual_datetime_text(value):
    dt = parse_dt_text(value)
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else ""


def _visual_minutes_of_day(value):
    dt = parse_dt_text(value)
    if not dt:
        return 0
    return dt.hour * 60 + dt.minute


def _void_actual(con, actual_id):
    con.execute(
        """
        UPDATE planner_production_actual
        SET status = 'VOIDED'
        WHERE actual_id = %s
        """,
        (int(actual_id),),
    )


def _insert_actual(con, *, segment_id, block_id, report_date, output_qty, reject_qty, remarks, target_qty, machine_id, entry_type, correction_of_actual_id=None, created_by=""):
    cur = con.execute(
        """
        INSERT INTO planner_production_actual (
          segment_id, block_id, machine_id, report_date, remarks, reported_at,
          output_qty, reject_qty, target_qty_at_report, status, entry_type,
          correction_of_actual_id, good_qty_at_report, created_by
        ) VALUES (%s, %s, %s, %s, %s, NOW(), %s, %s, %s, 'ACTIVE', %s, %s, %s, %s)
        RETURNING actual_id
        """,
        (
            segment_id,
            block_id,
            machine_id,
            report_date,
            compact_text(remarks),
            output_qty,
            reject_qty,
            target_qty,
            entry_type,
            correction_of_actual_id,
            None if output_qty is None or reject_qty is None else max(0.0, float(output_qty or 0) - float(reject_qty or 0)),
            created_by,
        ),
    )
    return int(one(cur)["actual_id"])


def _active_actual_for_segment(con, segment_id):
    return one(
        con.execute(
            """
            SELECT *
            FROM planner_production_actual
            WHERE segment_id = %s
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            ORDER BY actual_id DESC
            LIMIT 1
            """,
            (int(segment_id),),
        )
    )


def _active_actual_for_block_date(con, block_id, report_date):
    return one(
        con.execute(
            """
            SELECT *
            FROM planner_production_actual
            WHERE block_id = %s
              AND report_date = %s
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            ORDER BY CASE WHEN segment_id IS NULL THEN 1 ELSE 0 END, actual_id DESC
            LIMIT 1
            """,
            (int(block_id), report_date),
        )
    )


def _planned_target_qty_for_block_date(con, block_id, report_date):
    row = one(
        con.execute(
            """
            SELECT COALESCE(SUM(COALESCE(qty_done, planned_qty, 0)), 0) AS target_qty
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND COALESCE(segment_type, '') = 'production'
              AND segment_date = %s::date
            """,
            (int(block_id), report_date),
        )
    )
    return max(0.0, float(row["target_qty"] or 0)) if row else 0.0


def _calendar_window_rows(con, start_iso=None, end_iso=None, machine_id=None, active=None, window_type=None):
    clauses = []
    params = []
    if machine_id:
        clauses.append("w.machine_id = %s")
        params.append(int(machine_id))
    if start_iso:
        clauses.append("w.end_at > %s")
        params.append(start_iso)
    if end_iso:
        clauses.append("w.start_at < %s")
        params.append(end_iso)
    if active is not None:
        clauses.append("w.active = %s")
        params.append(bool(int(active)))
    if window_type:
        clauses.append("w.window_type = %s")
        params.append(compact_text(window_type).upper())
    where_clause = " AND ".join(clauses) if clauses else "1 = 1"
    return rows(
        con.execute(
            f"""
            SELECT w.*, m.machine_no AS machine_code
            FROM planner_machine_calendar_window w
            LEFT JOIN planner_machines m ON m.machine_id = w.machine_id
            WHERE {where_clause}
            ORDER BY w.start_at, w.window_id
            """,
            params,
        )
    )


def _calendar_window_payload(row):
    window_type = compact_text(row.get("window_type")).upper()
    return {
        "window_id": int(row.get("window_id") or 0),
        "machine_id": int(row.get("machine_id") or 0),
        "machine_code": compact_text(row.get("machine_code") or ""),
        "start_at": planner_wall_datetime_to_api(row.get("start_at") or ""),
        "end_at": planner_wall_datetime_to_api(row.get("end_at") or ""),
        "window_type": window_type,
        "capacity_minutes": int(row.get("capacity_minutes") or 0),
        "note": compact_text(row.get("note") or ""),
        "active": int(bool(row.get("active"))),
        "display_kind": "available" if window_type in {"OVERTIME", "AVAILABLE"} else "blocked",
    }


def _attach_board_meta_to_blocks(con, blocks):
    """Attach planner_ps_id, material_in, tooling_ready, and due_date for board / machinist lane cards."""
    if not blocks:
        return
    from .scheduler_state import refresh_stale_queue_state_fields

    for row in blocks:
        refresh_stale_queue_state_fields(con, row)
    board_ps_ids = list(dict.fromkeys(
        planner_ps_id_from_block_row(row)
        for row in blocks
        if planner_ps_id_from_block_row(row)
    ))
    if not board_ps_ids:
        return
    material_in_by_ps = material_in_map_for_planner_ps_ids(con, board_ps_ids)
    due_date_by_ps = due_date_map_for_planner_ps_ids(con, board_ps_ids)
    operation_ids = [
        int(row.get("operation_id") or 0)
        for row in blocks
        if int(row.get("operation_id") or 0) > 0
    ]
    tooling_by_op = tooling_map_for_operation_ids(con, operation_ids)
    for row in blocks:
        ps_id = planner_ps_id_from_block_row(row)
        if not ps_id:
            continue
        row["planner_ps_id"] = ps_id
        row["material_in"] = bool(material_in_by_ps.get(ps_id))
        op_id = int(row.get("operation_id") or 0)
        if op_id > 0:
            row["tooling_ready"] = bool(tooling_by_op.get(op_id, True))
        due_text = compact_text(due_date_by_ps.get(ps_id))
        if due_text:
            row["due_date"] = due_text


def _attach_board_meta_to_blocks_rest(blocks):
    """REST fallback: attach material_in, tooling_ready (and planner_ps_id) without direct DB."""
    if not blocks:
        return
    import requests as req
    from db import supa_url, supa_headers

    board_ps_ids = list(dict.fromkeys(
        planner_ps_id_from_block_row(row)
        for row in blocks
        if planner_ps_id_from_block_row(row)
    ))
    operation_ids = sorted({
        int(row.get("operation_id") or 0)
        for row in blocks
        if int(row.get("operation_id") or 0) > 0
    })
    if not board_ps_ids and not operation_ids:
        return
    material_in_by_ps = {pid: False for pid in board_ps_ids}
    tooling_by_op = {op_id: True for op_id in operation_ids}
    try:
        if board_ps_ids:
            quoted = ",".join(f'"{pid}"' for pid in board_ps_ids)
            r = req.get(
                f"{supa_url()}/planner_process_sheet",
                headers={**supa_headers(write=True), "Prefer": "return=representation"},
                params={
                    "select": "planner_ps_id,material_in",
                    "planner_ps_id": f"in.({quoted})",
                },
                timeout=30,
            )
            r.raise_for_status()
            for row in r.json() or []:
                pid = compact_text(row.get("planner_ps_id"))
                if pid:
                    material_in_by_ps[pid] = bool(row.get("material_in"))
    except Exception:
        import logging

        logging.getLogger(__name__).exception(
            "REST board material_in enrichment failed; defaulting to awaiting stock"
        )
    try:
        if operation_ids:
            quoted_ops = ",".join(str(op_id) for op_id in operation_ids)
            r = req.get(
                f"{supa_url()}/planner_operation",
                headers={**supa_headers(write=True), "Prefer": "return=representation"},
                params={
                    "select": "operation_id,tooling_ready",
                    "operation_id": f"in.({quoted_ops})",
                },
                timeout=30,
            )
            r.raise_for_status()
            for row in r.json() or []:
                op_id = int(row.get("operation_id") or 0)
                if op_id:
                    tooling_by_op[op_id] = bool(row.get("tooling_ready"))
    except Exception:
        import logging

        logging.getLogger(__name__).exception(
            "REST board tooling enrichment failed; defaulting to awaiting tooling"
        )
    for row in blocks:
        ps_id = planner_ps_id_from_block_row(row)
        if not ps_id:
            continue
        row["planner_ps_id"] = ps_id
        row["material_in"] = bool(material_in_by_ps.get(ps_id))
        op_id = int(row.get("operation_id") or 0)
        if op_id > 0:
            row["tooling_ready"] = bool(tooling_by_op.get(op_id, True))


def _trial_schedule_via_rest():
    """Fallback: build the schedule response using Supabase REST API instead of direct DB."""
    import requests as req
    from db import supa_url, supa_headers
    from collections import defaultdict

    def rget(table, params=None):
        r = req.get(
            f"{supa_url()}/{table}",
            headers={**supa_headers(write=True), "Prefer": "return=representation"},
            params=params or {},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    machines_raw   = rget("planner_machines",           {"select": "machine_id,machine_no,machine_category,shift_profile,active", "active": "eq.true", "order": "machine_id"})
    mpp_owned_block_ids = {
        int(row["block_id"])
        for row in rget("planner_mpp_cycle_op", {"select": "block_id"})
        if int(row.get("block_id") or 0) > 0
    }
    mpp_cycle_group_ids = {
        int(g["group_id"])
        for g in rget("planner_run_block_group", {"select": "group_id,group_type,group_label"})
        if compact_text(g.get("group_type")).upper() == "MPP_CYCLE"
        or compact_text(g.get("group_label")).lower().startswith("mpp cycle")
    }
    mpp_cycle_group_ids.update(
        int(c["group_id"])
        for c in rget("planner_mpp_cycle", {"select": "group_id"})
        if int(c.get("group_id") or 0) > 0
    )
    blocks_raw     = rget("planner_run_block",           {"select": "*", "order": "machine_id,queue_position,block_id"})
    ops_raw        = rget("planner_operation",           {"select": "*"})
    groups_raw     = rget("planner_run_block_group",     {"select": "*"})
    segments_raw   = rget("planner_run_block_segment",   {"select": "*", "order": "segment_id"})
    actuals_raw    = rget("planner_production_actual",   {"select": "*", "status": "eq.ACTIVE", "order": "report_date,actual_id"})
    caps_raw       = rget("planner_machine_capacity_day",{"select": "*", "order": "work_date,machine_id"})
    profiles_raw   = rget("planner_capacity_profile",    {"select": "*", "order": "profile_id"})
    cards_raw      = rget("planner_planning_card",       {"select": "*"})

    ops_by_id      = {o["operation_id"]: o for o in ops_raw}
    machines_by_id = {m["machine_id"]: m for m in machines_raw}
    groups_by_id   = {g["group_id"]: g for g in groups_raw}
    profiles_by_id = {p["profile_id"]: p for p in profiles_raw}

    active_block_ids = set()
    blocks = []
    for b in blocks_raw:
        if b.get("active") is False:
            continue
        machine = machines_by_id.get(b.get("machine_id") or 0, {})
        is_mpp_machine = compact_text(machine.get("machine_category")).upper() == "MPP"
        if not is_mpp_machine:
            if int(b.get("block_id") or 0) in mpp_owned_block_ids:
                continue
            if int(b.get("group_id") or 0) in mpp_cycle_group_ids:
                continue
        active_block_ids.add(b["block_id"])
        op      = ops_by_id.get(b.get("operation_id") or 0, {})
        group   = groups_by_id.get(b.get("group_id") or 0, {})
        blocks.append({
            **b,
            "job_no":                   op.get("job_no"),
            "operation_name":           op.get("operation_name"),
            "total_qty":                op.get("total_qty"),
            "setup_minutes":            op.get("setup_minutes"),
            "cycle_minutes_per_qty":    op.get("cycle_minutes_per_qty"),
            "compatible_machine_group": op.get("compatible_machine_group"),
            "source_ps_id":             op.get("source_ps_id"),
            "source_op_seq_id":         op.get("source_op_seq_id"),
            "source_op_no":             op.get("source_op_no"),
            "tooling_ready":            bool(op.get("tooling_ready", True)),
            "machine_code":             machine.get("machine_no"),
            "machine_category":         machine.get("machine_category"),
            "shift_profile":            machine.get("shift_profile"),
            "group_label":              group.get("group_label"),
            "group_type":               group.get("group_type"),
            "visual_start_datetime":    planner_wall_datetime_to_api(b.get("calculated_start_datetime")) or "",
            "visual_end_datetime":      planner_wall_datetime_to_api(b.get("calculated_end_datetime")) or "",
            "visual_parts":             [],
            "break_windows":            [],
            "material_status":          {"status": "NOT_REQUIRED", "label": "", "expected_ready_date": "", "severity": "none"},
            "anchor_datetime":          planner_wall_datetime_to_api(b.get("anchor_datetime")),
            "calculated_start_datetime": planner_wall_datetime_to_api(b.get("calculated_start_datetime")),
            "calculated_end_datetime":  planner_wall_datetime_to_api(b.get("calculated_end_datetime")),
            "updated_at":               compact_text(b.get("updated_at")),
        })

    segments = []
    for s in segments_raw:
        if s.get("block_id") not in active_block_ids:
            continue
        segments.append({
            **s,
            "operation_id":          ops_by_id.get((next((b for b in blocks_raw if b["block_id"] == s["block_id"]), {}) or {}).get("operation_id") or 0, {}).get("operation_id"),
            "visual_start_datetime": planner_wall_datetime_to_api(s.get("start_datetime")) or "",
            "visual_end_datetime":   planner_wall_datetime_to_api(s.get("end_datetime")) or "",
            "visual_parts":          [],
            "break_windows":         [],
            "segment_date":          compact_text(s.get("segment_date")),
            "start_datetime":        planner_wall_datetime_to_api(s.get("start_datetime")),
            "end_datetime":          planner_wall_datetime_to_api(s.get("end_datetime")),
        })

    capacities = [{**c, "profile_name": profiles_by_id.get(c.get("profile_id") or 0, {}).get("profile_name", ""), "work_date": compact_text(c.get("work_date"))} for c in caps_raw]

    block_group_ids = {b.get("group_id") for b in blocks if b.get("group_id")}
    block_groups = []
    for g in groups_raw:
        if g["group_id"] not in block_group_ids:
            continue
        block_groups.append({**g, "material_status": {"status": "NOT_REQUIRED", "label": "", "expected_ready_date": "", "severity": "none"}})

    planning_cards = [{**c, "ps_id": c.get("planner_ps_id")} for c in cards_raw]

    for actual in actuals_raw:
        actual["report_date"]  = compact_text(actual.get("report_date"))
        actual["reported_at"]  = compact_text(actual.get("reported_at"))

    _attach_board_meta_to_blocks_rest(blocks)

    return jsonify({
        "machines":        machines_raw,
        "blocks":          blocks,
        "segments":        segments,
        "actuals":         actuals_raw,
        "capacities":      capacities,
        "profiles":        profiles_raw,
        "block_groups":    block_groups,
        "catalog":         [],
        "planned":         [],
        "planning_cards":  planning_cards,
        "calendar_windows": [],
    })


@trial_bp.get("/api/trial/queue-state")
def api_trial_queue_state():
    with planner_db() as con:
        data = rows(
            con.execute(
                """
                SELECT qs.block_id, qs.predicted_start_at, qs.predicted_end_at,
                       qs.remaining_qty, qs.output_qty, qs.reject_qty, qs.good_qty,
                       qs.planned_minutes, qs.schedule_status, qs.execution_status,
                       qs.is_late, qs.delay_minutes,
                       b.machine_id, b.queue_position
                FROM planner_machine_queue_state qs
                JOIN planner_run_block b ON b.block_id = qs.block_id
                WHERE COALESCE(b.active, TRUE) = TRUE
                ORDER BY b.machine_id, b.queue_position, b.block_id
                """
            )
        )
        for row in data:
            row["predicted_start_at"] = planner_wall_datetime_to_api(row.get("predicted_start_at"))
            row["predicted_end_at"] = planner_wall_datetime_to_api(row.get("predicted_end_at"))
        return jsonify(data)


def _trial_machine_refresh_payload(con, machine_ids, *, lite=True):
    """
    Lane refresh after queue mutations.

    lite=True (default): read persisted times from planner_run_block +
    planner_machine_queue_state — no ERP enrichment or heavy group summaries.
    lite=False: full enrichment for editor/detail views.
    """
    machine_ids = sorted({int(value) for value in (machine_ids or []) if int(value or 0) > 0})
    if not machine_ids:
        return {"blocks": [], "block_groups": [], "lite": bool(lite)}

    raw_blocks = rows(
        con.execute(
            f"""
            SELECT b.*, o.job_no, o.operation_name, o.total_qty, o.setup_minutes, o.cycle_minutes_per_qty,
                   o.compatible_machine_group, o.source_ps_id, o.source_op_seq_id AS source_op_seq_id, o.source_op_no,
                   m.machine_no AS machine_code, m.machine_category, m.shift_profile,
                   g.group_label AS group_label, g.group_type AS group_type,
                   os.operation_sequence_id AS operation_sequence_id,
                   os.sequence_no AS sequence_no,
                   qs.predicted_start_at AS qs_predicted_start_at,
                   qs.predicted_end_at AS qs_predicted_end_at,
                   qs.remaining_qty AS qs_remaining_qty,
                   qs.good_qty AS qs_good_qty,
                   qs.reject_qty AS qs_reject_qty,
                   qs.schedule_status AS qs_schedule_status
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            LEFT JOIN planner_run_block_group g ON g.group_id = b.group_id
            LEFT JOIN planner_operation_sequence os ON os.block_id = b.block_id
            LEFT JOIN planner_machine_queue_state qs ON qs.block_id = b.block_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND b.machine_id = ANY(%s)
            ORDER BY b.machine_id, b.queue_position, b.block_id
            """,
            (machine_ids,),
        )
    )
    blocks = []
    for row in raw_blocks:
        item = dict(row)
        item["anchor_datetime"] = planner_wall_datetime_to_api(item.get("anchor_datetime"))
        calc_start = planner_wall_datetime_to_api(row.get("calculated_start_datetime"))
        calc_end = planner_wall_datetime_to_api(row.get("calculated_end_datetime"))
        pred_start = planner_wall_datetime_to_api(row.get("qs_predicted_start_at")) or calc_start
        pred_end = planner_wall_datetime_to_api(row.get("qs_predicted_end_at")) or calc_end
        item["calculated_start_datetime"] = calc_start
        item["calculated_end_datetime"] = calc_end
        item["predicted_start_at"] = pred_start
        item["predicted_end_at"] = pred_end
        item["visual_start_datetime"] = pred_start
        item["visual_end_datetime"] = pred_end
        item["updated_at"] = compact_text(item.get("updated_at"))
        item["visual_parts"] = []
        item["break_windows"] = []
        item["shift_profile"] = compact_text(item.get("shift_profile") or "")
        if item.get("qs_good_qty") is not None:
            item["actual_good_qty"] = float(item.get("qs_good_qty") or 0)
            item["good_qty"] = float(item.get("qs_good_qty") or 0)
        if item.get("qs_reject_qty") is not None:
            item["actual_reject_qty"] = float(item.get("qs_reject_qty") or 0)
            item["reject_qty"] = float(item.get("qs_reject_qty") or 0)
        if item.get("qs_schedule_status"):
            item["planning_status"] = compact_text(item.get("qs_schedule_status"))
        for drop_key in ("qs_predicted_start_at", "qs_predicted_end_at", "qs_remaining_qty", "qs_good_qty", "qs_reject_qty", "qs_schedule_status"):
            item.pop(drop_key, None)
        blocks.append(item)

    from .mpp_planner_queue_service import tag_mpp_planner_mirror_blocks

    tag_mpp_planner_mirror_blocks(con, blocks)

    if not lite:
        from .erp_actuals import effective_actual_totals_for_block, erp_reconciliation_for_block

        for item in blocks:
            try:
                con.execute("SAVEPOINT trial_machine_refresh_erp")
                erp_recon = erp_reconciliation_for_block(con, item)
                if erp_recon:
                    item["erp_reconciliation"] = erp_recon
                    try:
                        item["effective_actuals"] = effective_actual_totals_for_block(con, item, erp_recon)
                    except Exception:
                        item["effective_actuals"] = None
                con.execute("RELEASE SAVEPOINT trial_machine_refresh_erp")
            except Exception:
                try:
                    con.execute("ROLLBACK TO SAVEPOINT trial_machine_refresh_erp")
                except Exception:
                    pass

        actual_summary_map = actual_summaries_for_block_rows(con, blocks)
        for item in blocks:
            summary = actual_summary_map.get(int(item.get("block_id") or 0), {})
            item["actual_start_at"] = planner_wall_datetime_to_api(summary.get("actual_start_at") or "")
            item["actual_end_at"] = planner_wall_datetime_to_api(summary.get("actual_end_at") or "")
            if summary.get("actual_good_qty") is not None:
                item["actual_good_qty"] = float(summary.get("actual_good_qty") or 0)
            item["actual_row_count"] = int(summary.get("actual_row_count") or 0)

    group_ids = sorted({int(row.get("group_id") or 0) for row in blocks if int(row.get("group_id") or 0) > 0})
    block_groups = []
    if lite:
        if group_ids:
            for group in rows(
                con.execute(
                    """
                    SELECT group_id, group_label, group_type
                    FROM planner_run_block_group
                    WHERE group_id = ANY(%s)
                    ORDER BY group_id
                    """,
                    (group_ids,),
                )
            ):
                block_groups.append(dict(group))
    else:
        for group_id in group_ids:
            try:
                group = combined_group_summary(con, group_id)
                if group:
                    block_groups.append(group)
            except Exception:
                import logging

                logging.getLogger(__name__).exception(
                    "combined_group_summary failed for group_id=%s (machine refresh)", group_id
                )

    attach_block_ps_identity(con, blocks)

    from .queue_visibility import filter_completed_lane_blocks

    blocks = filter_completed_lane_blocks(con, blocks)
    visible_group_ids = {
        int(row.get("group_id") or 0)
        for row in blocks
        if int(row.get("group_id") or 0) > 0
    }
    if visible_group_ids:
        block_groups = [
            group for group in block_groups
            if int(group.get("group_id") or 0) in visible_group_ids
        ]
    elif not blocks:
        block_groups = []

    _attach_board_meta_to_blocks(con, blocks)

    return {"blocks": blocks, "block_groups": block_groups, "lite": bool(lite)}


@trial_bp.get("/api/trial/schedule")
def api_trial_schedule():
    try:
        return _api_trial_schedule_db()
    except Exception as exc:
        import logging
        import traceback
        logging.getLogger(__name__).exception("trial schedule DB path failed, using REST fallback: %s", exc)
        traceback.print_exc()
        return _trial_schedule_via_rest()


def _api_trial_schedule_db():
    include_completed = int(request.args.get("include_completed") or 0)
    lite = compact_text(request.args.get("lite")).lower() in {"1", "true", "yes"}
    start_iso = compact_text(request.args.get("start") or request.args.get("from")) or date.today().isoformat()
    end_iso = compact_text(request.args.get("end") or request.args.get("to")) or (date.today() + timedelta(days=7)).isoformat()
    machine_ids_param = compact_text(request.args.get("machine_ids") or "")
    machine_id_filter = [int(x) for x in machine_ids_param.split(",") if x.strip().lstrip("-").isdigit()] if machine_ids_param else []
    is_machine_scoped = bool(machine_id_filter)
    include_parts = {
        part.strip().lower()
        for part in compact_text(request.args.get("include") or "").split(",")
        if part.strip()
    }
    # Initial board load: skip heavy joins/enrichment; fetch on demand (Actual modal, Shop Calendar).
    board_lite = lite and not is_machine_scoped
    fast_lane_load = board_lite or (lite and is_machine_scoped)
    include_capacities = "capacities" in include_parts or not board_lite
    include_segments = ("segments" in include_parts) or (not board_lite and not is_machine_scoped)
    include_segment_visual = (not board_lite) or ("visual" in include_parts)
    include_actuals = (not board_lite) or ("actuals" in include_parts)
    include_actual_daily = "actual_daily" in include_parts
    include_holidays = "holidays" in include_parts
    shell_only = (
        not is_machine_scoped
        and board_lite
        and (
            compact_text(request.args.get("shell")).lower() in {"1", "true", "yes"}
            or include_parts == {"machines"}
        )
    )

    with planner_db() as con:
        if shell_only:
            machines = fetch_scheduler_machines(con)
            return jsonify({
                "machines": [dict(row) for row in machines],
                "blocks": [],
                "segments": [],
                "actuals": [],
                "capacities": [],
                "profiles": [],
                "public_holidays": [],
                "block_groups": [],
                "catalog": [],
                "planned": [],
                "planning_cards": [],
                "calendar_windows": [],
            })

        # Keep MPP mirrors healthy on full and lite board loads (Machine Queue uses lite).
        # Cheap no-op when cycle_op.block_id links are intact.
        if not is_machine_scoped:
            from .mpp_planner_queue_service import ensure_mpp_planner_scheduler_lanes

            ensure_mpp_planner_scheduler_lanes(con)
            con.commit()

        # Full board reload: move DONE ops off machine lanes + compact gaps.
        if not is_machine_scoped and not board_lite:
            from .auto_unschedule import auto_unschedule_on_page_load
            from .operation_sequence import compact_machine_lanes_with_gaps

            auto_unschedule_on_page_load(con)
            compact_machine_lanes_with_gaps(con, recalculate=False)
        # Lite board load: skip auto-unschedule sweep (was blocking every page open).
        elif is_machine_scoped and not lite:
            from .auto_unschedule import auto_unschedule_for_machines
            from .operation_sequence import compact_machine_lanes_with_gaps

            auto_unschedule_for_machines(con, machine_id_filter)
            compact_machine_lanes_with_gaps(con, machine_id_filter, recalculate=False)

        # Stale card cleanup — skip on lite board and machine-scoped refreshes.
        if not is_machine_scoped and not board_lite:
            stale_cards = rows(
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
            for card in stale_cards:
                group_id = int(card["scheduled_block_group_id"] or 0)
                live_group = one(
                    con.execute(
                        "SELECT COUNT(*) AS cnt FROM planner_run_block WHERE group_id = %s",
                        (group_id,),
                    )
                )
                if int((live_group or {}).get("cnt") or 0) > 0:
                    continue
                ps_id = compact_text(card["ps_id"])
                base_ps_id = ps_id.split("::", 1)[0] if ps_id else ""
                delete_ps_ids = {ps_id}
                if base_ps_id:
                    delete_ps_ids.add(base_ps_id)
                for delete_ps_id in delete_ps_ids:
                    if delete_ps_id:
                        con.execute(
                            """
                            DELETE FROM planner_planning_card
                            WHERE card_type = 'COMBINED'
                              AND planner_ps_id = %s
                            """,
                            (delete_ps_id,),
                        )
                con.execute(
                    "DELETE FROM planner_planning_card WHERE card_type = 'COMBINED' AND scheduled_block_group_id = %s",
                    (group_id,),
                )

        machines = fetch_scheduler_machines(con)

        machine_by_id = {int(row["machine_id"]): dict(row) for row in machines}
        scheduler_machine_ids = [int(row["machine_id"]) for row in machines]

        # include_completed=1 is used by Actual Production history view to include:
        # - DONE blocks that were auto-unscheduled (active = FALSE), and
        # - any block with saved actual rows (defensive for status drift).
        _block_where = (
            """(
                COALESCE(b.active, TRUE) = TRUE
                OR UPPER(COALESCE(b.execution_status, '')) = 'DONE'
                OR EXISTS (
                    SELECT 1
                    FROM planner_production_actual pa
                    WHERE pa.block_id = b.block_id
                )
            )"""
            if include_completed
            else "COALESCE(b.active, TRUE) = TRUE"
        )
        _block_params: list = []
        if is_machine_scoped:
            _block_where += " AND b.machine_id = ANY(%s)"
            _block_params.append(machine_id_filter)
        elif scheduler_machine_ids:
            _block_where += " AND b.machine_id = ANY(%s)"
            _block_params.append(scheduler_machine_ids)

        raw_blocks = rows(
            con.execute(
                f"""
                SELECT b.*, o.job_no, o.operation_name, o.total_qty, o.setup_minutes, o.cycle_minutes_per_qty,
                       o.compatible_machine_group, o.source_ps_id, o.source_op_seq_id AS source_op_seq_id, o.source_op_no,
                       m.machine_no AS machine_code, m.machine_category, m.shift_profile,
                       g.group_label AS group_label, g.group_type AS group_type,
                       os.operation_sequence_id AS operation_sequence_id,
                       os.sequence_no AS sequence_no,
                       qs.predicted_start_at AS qs_predicted_start_at,
                       qs.predicted_end_at AS qs_predicted_end_at,
                       qs.remaining_qty AS qs_remaining_qty,
                       qs.output_qty AS qs_output_qty,
                       qs.good_qty AS qs_good_qty,
                       qs.reject_qty AS qs_reject_qty,
                       qs.schedule_status AS qs_schedule_status
                FROM planner_run_block b
                JOIN planner_operation o ON o.operation_id = b.operation_id
                JOIN planner_machines m ON m.machine_id = b.machine_id
                LEFT JOIN planner_run_block_group g ON g.group_id = b.group_id
                LEFT JOIN planner_operation_sequence os ON os.block_id = b.block_id
                LEFT JOIN planner_machine_queue_state qs ON qs.block_id = b.block_id
                WHERE {_block_where}
                ORDER BY b.machine_id, b.queue_position, b.block_id
                """,
                _block_params or None,
            )
        )

        _active_block_ids = [int(b["block_id"]) for b in raw_blocks if b.get("block_id")]
        raw_segments = []
        if include_segments and _active_block_ids:
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
                    (_active_block_ids,),
                )
            )

        segments = []
        segments_by_block = {}
        for row in raw_segments:
            item = dict(row)
            if include_segment_visual:
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
                item["shift_profile"] = shift_profile
                item["visual_start_datetime"] = timing["visual_start_datetime"]
                item["visual_end_datetime"] = timing["visual_end_datetime"]
                item["visual_parts"] = timing["visual_parts"]
                item["break_windows"] = timing["break_windows"]
            else:
                item["visual_start_datetime"] = planner_wall_datetime_to_api(item.get("start_datetime"))
                item["visual_end_datetime"] = planner_wall_datetime_to_api(item.get("end_datetime"))
                item["visual_parts"] = []
                item["break_windows"] = []
            item["segment_date"] = compact_text(item.get("segment_date"))
            item["start_datetime"] = planner_wall_datetime_to_api(item.get("start_datetime"))
            item["end_datetime"] = planner_wall_datetime_to_api(item.get("end_datetime"))
            segments.append(item)
            segments_by_block.setdefault(int(item.get("block_id") or 0), []).append(item)

        blocks = []
        for row in raw_blocks:
            item = dict(row)
            calc_start = planner_wall_datetime_to_api(row.get("calculated_start_datetime"))
            calc_end = planner_wall_datetime_to_api(row.get("calculated_end_datetime"))
            # Stringify all datetime fields for JSON serialisation (Singapore wall clock)
            item["anchor_datetime"] = planner_wall_datetime_to_api(item.get("anchor_datetime"))
            item["calculated_start_datetime"] = calc_start
            item["calculated_end_datetime"] = calc_end
            item["updated_at"] = compact_text(item.get("updated_at"))

            block_segments = segments_by_block.get(int(item.get("block_id") or 0), [])
            if block_segments and include_segment_visual:
                block_start_dt = parse_dt_text(item.get("anchor_datetime") or item.get("calculated_start_datetime"))
                block_end_dt = parse_dt_text(item.get("calculated_end_datetime"))
                visual_starts = sorted([compact_text(seg.get("visual_start_datetime")) for seg in block_segments if compact_text(seg.get("visual_start_datetime"))])
                visual_ends = sorted([compact_text(seg.get("visual_end_datetime")) for seg in block_segments if compact_text(seg.get("visual_end_datetime"))])
                timing = visual_timing_for_segment(
                    block_start_dt,
                    item.get("minutes_used") or 0,
                    end_dt=block_end_dt,
                    work_date=block_start_dt.date() if block_start_dt else None,
                    profile_name="",
                    shift_profile=compact_text(item.get("shift_profile") or machine_by_id.get(int(item.get("machine_id") or 0), {}).get("shift_profile", "")),
                    segment_type=item.get("segment_type") or "production",
                ) if block_start_dt else {"visual_start_datetime": "", "visual_end_datetime": ""}
                item["visual_start_datetime"] = timing.get("visual_start_datetime") or (visual_starts[0] if visual_starts else item.get("calculated_start_datetime", ""))
                item["visual_end_datetime"] = timing.get("visual_end_datetime") or (visual_ends[-1] if visual_ends else item.get("calculated_end_datetime", ""))
                visual_parts = []
                for seg in block_segments:
                    visual_parts.extend(seg.get("visual_parts") or [])
                item["visual_parts"] = visual_parts
                item["break_windows"] = block_segments[0].get("break_windows") or []
                item["shift_profile"] = block_segments[0].get("shift_profile") or machine_by_id.get(int(item.get("machine_id") or 0), {}).get("shift_profile", "")
            else:
                item["visual_start_datetime"] = item.get("calculated_start_datetime", "")
                item["visual_end_datetime"] = item.get("calculated_end_datetime", "")
                item["visual_parts"] = []
                item["break_windows"] = []
                item["shift_profile"] = machine_by_id.get(int(item.get("machine_id") or 0), {}).get("shift_profile", "")
            if fast_lane_load:
                pred_start = planner_wall_datetime_to_api(row.get("qs_predicted_start_at")) or calc_start
                pred_end = planner_wall_datetime_to_api(row.get("qs_predicted_end_at")) or calc_end
                item["predicted_start_at"] = pred_start
                item["predicted_end_at"] = pred_end
                if pred_start:
                    item["visual_start_datetime"] = pred_start
                if pred_end:
                    item["visual_end_datetime"] = pred_end
                output_qty = item.get("qs_output_qty")
                good_qty = item.get("qs_good_qty")
                reject_qty = item.get("qs_reject_qty")
                if output_qty is not None or good_qty is not None or reject_qty is not None:
                    output_total = float(output_qty if output_qty is not None else good_qty or 0)
                    reject_total = float(reject_qty or 0)
                    good_total = float(
                        good_qty if good_qty is not None else max(0.0, output_total - reject_total)
                    )
                    item["actual_good_qty"] = good_total
                    item["good_qty"] = good_total
                    item["effective_actuals"] = {
                        "effective_output_qty": output_total,
                        "effective_reject_qty": reject_total,
                        "effective_good_qty": good_total,
                        "output_source": "queue_state",
                        "reject_source": "queue_state",
                        "good_source": "queue_state",
                    }
                if item.get("qs_schedule_status"):
                    item["planning_status"] = compact_text(item.get("qs_schedule_status"))
                for drop_key in (
                    "qs_predicted_start_at",
                    "qs_predicted_end_at",
                    "qs_remaining_qty",
                    "qs_output_qty",
                    "qs_good_qty",
                    "qs_reject_qty",
                    "qs_schedule_status",
                ):
                    item.pop(drop_key, None)
            blocks.append(item)

        from .mpp_planner_queue_service import tag_mpp_planner_mirror_blocks

        tag_mpp_planner_mirror_blocks(con, blocks)

        attach_block_ps_identity(con, blocks)

        visible_block_ids = {int(b["block_id"]) for b in blocks if b.get("block_id")}
        if not include_completed:
            if board_lite:
                from .queue_visibility import filter_completed_lane_blocks_fast

                blocks = filter_completed_lane_blocks_fast(blocks)
            else:
                from .queue_visibility import filter_completed_lane_blocks

                blocks = filter_completed_lane_blocks(con, blocks)
            visible_block_ids = {int(b["block_id"]) for b in blocks if b.get("block_id")}
            if visible_block_ids != {int(x) for x in _active_block_ids}:
                segments = [
                    seg for seg in segments
                    if int(seg.get("block_id") or 0) in visible_block_ids
                ]

        if not lite:
            from .blocks import actual_daily_rows_for_block_row_with_erp

            from .erp_actuals import effective_actual_totals_for_block

            for item in blocks:
                daily_rows, erp_recon = actual_daily_rows_for_block_row_with_erp(con, item)
                item["actual_daily_rows"] = daily_rows
                if erp_recon:
                    item["erp_reconciliation"] = erp_recon
                    item["effective_actuals"] = effective_actual_totals_for_block(con, item, erp_recon)
        elif include_actual_daily:
            from .erp_actuals import ensure_erp_snapshot_table

            ensure_erp_snapshot_table(con)
            attach_actual_daily_to_blocks(con, blocks, with_erp=True)
        elif include_actuals and not fast_lane_load:
            from .erp_actuals import effective_actual_totals_for_block, erp_reconciliation_for_block

            for item in blocks:
                def _attach_erp(block_item=item):
                    erp_recon = erp_reconciliation_for_block(con, block_item)
                    if not erp_recon:
                        return None
                    block_item["erp_reconciliation"] = erp_recon
                    try:
                        block_item["effective_actuals"] = effective_actual_totals_for_block(con, block_item, erp_recon)
                    except Exception:
                        block_item["effective_actuals"] = None
                    return erp_recon

                planner_try_savepoint(con, "trial_schedule_erp", _attach_erp, default=None)

        if blocks and not fast_lane_load:
            actual_summary_map = actual_summaries_for_block_rows(con, blocks)
            for item in blocks:
                summary = actual_summary_map.get(int(item.get("block_id") or 0), {})
                item["actual_start_at"] = planner_wall_datetime_to_api(summary.get("actual_start_at") or "")
                item["actual_end_at"] = planner_wall_datetime_to_api(summary.get("actual_end_at") or "")
                if summary.get("actual_good_qty") is not None:
                    item["actual_good_qty"] = float(summary.get("actual_good_qty") or 0)
                item["actual_row_count"] = int(summary.get("actual_row_count") or 0)

        # Actuals list for client-side daily row assembly.
        if not include_actuals or fast_lane_load:
            actuals = []
        elif is_machine_scoped and _active_block_ids:
            actuals = rows(
                con.execute(
                    """
                    SELECT actual_id, segment_id, block_id, report_date,
                           output_qty, reject_qty, target_qty_at_report,
                           remarks, reported_at
                    FROM planner_production_actual
                    WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
                      AND block_id = ANY(%s)
                    ORDER BY report_date, actual_id
                    """,
                    (_active_block_ids,),
                )
            )
        else:
            actuals = rows(
                con.execute(
                    """
                    SELECT actual_id, segment_id, block_id, report_date,
                           output_qty, reject_qty, target_qty_at_report,
                           remarks, reported_at
                    FROM planner_production_actual
                    WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
                    ORDER BY report_date, actual_id
                    """
                )
            )
        for actual in actuals:
            actual["report_date"] = compact_text(actual.get("report_date"))
            actual["reported_at"] = compact_text(actual.get("reported_at"))
        if not include_completed and visible_block_ids:
            actuals = [
                row for row in actuals
                if int(row.get("block_id") or 0) in visible_block_ids
            ]

        if include_capacities:
            capacities = rows(
                con.execute(
                    """
                    SELECT d.day_id, d.machine_id, d.work_date, d.profile_id,
                           d.capacity_minutes, d.start_minute, d.note, p.profile_name
                    FROM planner_machine_capacity_day d
                    JOIN planner_capacity_profile p ON p.profile_id = d.profile_id
                    ORDER BY d.work_date, d.machine_id
                    """
                )
            )
            for cap in capacities:
                cap["work_date"] = compact_text(cap.get("work_date"))

            profiles = rows(con.execute(
                "SELECT profile_name, capacity_minutes, start_minute, note FROM planner_capacity_profile ORDER BY profile_id"
            ))
        else:
            capacities = []
            profiles = []

        if include_holidays:
            try:
                start_d = datetime.fromisoformat(start_iso).date()
            except ValueError:
                start_d = date.today()
            try:
                end_d = datetime.fromisoformat(end_iso).date()
            except ValueError:
                end_d = start_d + timedelta(days=7)
            if end_d < start_d:
                start_d, end_d = end_d, start_d
            public_holidays = list_public_holidays(con, start_d, end_d)
        else:
            public_holidays = []

        # Skip catalog, planning cards, and material status for machine-scoped refreshes
        if is_machine_scoped:
            catalog = {"available": [], "planned": []}
            planning_cards = []
            group_ids = sorted({
                int(row["group_id"])
                for row in blocks
                if int(row.get("group_id") or 0) > 0
            })
            block_groups = []
            if fast_lane_load and group_ids:
                for group in rows(
                    con.execute(
                        """
                        SELECT group_id, group_label, group_type
                        FROM planner_run_block_group
                        WHERE group_id = ANY(%s)
                        ORDER BY group_id
                        """,
                        (group_ids,),
                    )
                ):
                    block_groups.append(dict(group))
            else:
                for group_id in group_ids:
                    group = planner_try_savepoint(
                        con,
                        f"trial_group_summary_{group_id}",
                        lambda gid=group_id: combined_group_summary(con, gid),
                        default=None,
                    )
                    if group:
                        block_groups.append(group)
                    elif group is None:
                        import logging

                        logging.getLogger(__name__).warning(
                            "combined_group_summary failed for group_id=%s (machine refresh)", group_id
                        )
            material_status_map = {}
        else:
            catalog = {"available": [], "planned": []} if lite else trial_catalog_items(con, include_completed=bool(include_completed))
            planning_cards = [] if lite else [card for cards in planning_cards_by_ps(con).values() for card in cards]
            block_groups = []
            if not board_lite:
                group_ids = sorted({int(row["group_id"]) for row in blocks if int(row.get("group_id") or 0) > 0})
                for group_id in group_ids:
                    group = planner_try_savepoint(
                        con,
                        f"trial_group_summary_{group_id}",
                        lambda gid=group_id: combined_group_summary(con, gid),
                        default=None,
                    )
                    if group:
                        block_groups.append(group)
                    elif group is None:
                        import logging

                        logging.getLogger(__name__).warning(
                            "combined_group_summary failed for group_id=%s", group_id
                        )

        calendar_windows = (
            []
            if board_lite
            else [_calendar_window_payload(row) for row in _calendar_window_rows(con, start_iso, end_iso)]
        )

        ps_ids = set()
        planned_starts = {}
        for row in blocks:
            ps_id = compact_text(row.get("source_ps_id"))
            if not ps_id:
                continue
            ps_ids.add(ps_id)
            start_text = compact_text(row.get("calculated_start_datetime"))
            if start_text and (ps_id not in planned_starts or start_text < planned_starts[ps_id]):
                planned_starts[ps_id] = start_text
        for group in block_groups:
            ps_id = compact_text(group.get("ps_id") or "")
            if not ps_id:
                continue
            ps_ids.add(ps_id)
            start_text = compact_text(group.get("group_start"))
            if start_text and (ps_id not in planned_starts or start_text < planned_starts[ps_id]):
                planned_starts[ps_id] = start_text

        if fast_lane_load and blocks:
            _attach_board_meta_to_blocks(con, blocks)

        if lite or is_machine_scoped:
            material_status_map = {}
        else:
            try:
                sync_material_requirements_for_ps_ids(con, ps_ids)
            except Exception:
                import logging
                logging.getLogger(__name__).exception(
                    "material requirement sync failed during trial schedule load"
                )
            material_status_map = material_status_map_for_ps_ids(con, ps_ids, planned_starts)
        default_material_status = {"status": "NOT_REQUIRED", "label": "", "expected_ready_date": "", "severity": "none"}
        for row in blocks:
            ps_id = compact_text(row.get("source_ps_id"))
            row["material_status"] = material_status_map.get(ps_id, default_material_status)
        for group in block_groups:
            ps_id = compact_text(group.get("ps_id") or "")
            group["material_status"] = material_status_map.get(ps_id, default_material_status)

        return jsonify(
            {
                "machines": [dict(row) for row in machines],
                "blocks": blocks,
                "segments": segments,
                "actuals": actuals,
                "capacities": capacities,
                "profiles": profiles,
                "public_holidays": public_holidays,
                "block_groups": block_groups,
                "catalog": catalog["available"],
                "planned": catalog["planned"],
                "planning_cards": planning_cards,
                "calendar_windows": calendar_windows,
            }
        )


def _queue_delay_iso_date(value):
    text = compact_text(value)
    if not text:
        return None
    if len(text) >= 10:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            pass
    dt = parse_dt_text(text)
    return dt.date() if dt else None


def _queue_delay_start_text(row):
    return compact_text(
        row.get("predicted_start_at")
        or row.get("calculated_start_datetime")
        or row.get("anchor_datetime")
        or ""
    )


def _queue_delay_end_text(row):
    return compact_text(
        row.get("predicted_end_at")
        or row.get("calculated_end_datetime")
        or ""
    )


def _queue_delay_op_label(row):
    op_no = compact_text(row.get("source_op_no"))
    op_name = compact_text(row.get("operation_name"))
    if op_no and op_name:
        clean = op_name
        prefix = f"OP{op_no.lstrip('OPop')}"
        if op_name.upper().startswith(prefix.upper()):
            clean = op_name[len(prefix):].lstrip(" -:")
        return f"OP{op_no.lstrip('OPop')} {clean}".strip()
    return op_name or (f"OP{op_no}" if op_no else "")


def _queue_delay_ps_display(source_ps_id):
    base, partial_no = parse_planner_ps_id(compact_text(source_ps_id))
    return base, max(1, int(partial_no or 1))


def _queue_delay_risk_flags(end_at, due_date, coway_edd):
    """Coway EDD takes precedence over PS due when present."""
    end_day = _queue_delay_iso_date(end_at)
    coway_text = compact_text(coway_edd)
    due_text = compact_text(due_date)
    if coway_text:
        commitment_source = "coway"
        commitment_date = coway_text
        ref_day = _queue_delay_iso_date(coway_text)
    elif due_text:
        commitment_source = "due"
        commitment_date = due_text
        ref_day = _queue_delay_iso_date(due_text)
    else:
        return {
            "commitment_source": "",
            "commitment_date": "",
            "past_commitment": False,
            "past_due": False,
            "past_coway_edd": False,
            "delay_days": 0,
            "coway_delay_days": 0,
            "at_risk": False,
        }

    past_commitment = bool(end_day and ref_day and end_day > ref_day)
    delay_days = (end_day - ref_day).days if past_commitment else 0
    past_due = past_commitment and commitment_source == "due"
    past_coway_edd = past_commitment and commitment_source == "coway"
    return {
        "commitment_source": commitment_source,
        "commitment_date": commitment_date,
        "past_commitment": past_commitment,
        "past_due": past_due,
        "past_coway_edd": past_coway_edd,
        "delay_days": delay_days,
        "coway_delay_days": delay_days if past_coway_edd else 0,
        "at_risk": past_commitment,
    }


def _build_queue_delay_jobs(raw_rows):
    jobs = []
    for row in raw_rows:
        status = compact_text(row.get("execution_status")).upper().replace("-", "_").replace(" ", "_")
        if status in {"DONE", "COMPLETED"}:
            continue

        ps_base, partial_no = _queue_delay_ps_display(row.get("source_ps_id"))
        if int(row.get("pp_partial_no") or 0) > 0:
            partial_no = int(row["pp_partial_no"])
        planner_ps_id = format_planner_ps_id(ps_base, partial_no)
        start_at = _queue_delay_start_text(row)
        end_at = _queue_delay_end_text(row)
        due_date = compact_text(row.get("due_date"))
        coway_edd = compact_text(row.get("coway_proposed_edd"))
        risk = _queue_delay_risk_flags(end_at, due_date, coway_edd)

        jobs.append(
            {
                "ps_id": ps_base,
                "partial_no": partial_no,
                "pp_partial_no": partial_no,
                "source_ps_id": planner_ps_id,
                "planner_ps_id": planner_ps_id,
                "block_id": int(row.get("block_id") or 0),
                "operation": _queue_delay_op_label(row),
                "source_op_no": compact_text(row.get("source_op_no")),
                "machine_code": compact_text(row.get("machine_code")),
                "machine_category": compact_text(row.get("machine_category")),
                "queue_position": int(row.get("queue_position") or 0),
                "scheduled_qty": float(row.get("scheduled_qty") or 0),
                "start_at": start_at,
                "end_at": end_at,
                "due_date": due_date,
                "coway_edd": coway_edd,
                "commitment_source": risk["commitment_source"],
                "commitment_date": risk["commitment_date"],
                "past_commitment": risk["past_commitment"],
                "past_due": risk["past_due"],
                "past_coway_edd": risk["past_coway_edd"],
                "delay_days": risk["delay_days"],
                "coway_delay_days": risk["coway_delay_days"],
                "at_risk": risk["at_risk"],
            }
        )

    jobs.sort(
        key=lambda job: (
            0 if job["at_risk"] else 1,
            -(job["delay_days"] or 0),
            job.get("commitment_date") or job.get("due_date") or "9999-12-31",
            job.get("ps_id") or "",
            int(job.get("pp_partial_no") or job.get("partial_no") or 1),
            job.get("machine_code") or "",
            job.get("queue_position") or 0,
        )
    )
    return jobs


def _delivery_schedule_so_line_qty(item):
    """Full sales-order line qty (same across partials of one PS)."""
    so_qty = item.get("so_det_qty")
    if so_qty is not None and float(so_qty or 0) > 0:
        return float(so_qty)
    return None


def _delivery_schedule_pp_partial_qty(item):
    """Qty for this PP partial. Temp PS reports its stipulated (reject) qty."""
    if item.get("is_temp_ps"):
        candidates = (item.get("pp_partial_qty"), item.get("temp_qty"))
    else:
        candidates = (
            item.get("pp_partial_qty"),
            item.get("partial_qty"),
            item.get("display_qty"),
        )
    for value in candidates:
        if value is None:
            continue
        try:
            qty = float(value)
        except (TypeError, ValueError):
            continue
        if qty > 0:
            return qty
    return None


def _delivery_schedule_ops_snapshot(ops):
    out = []
    for op in ops or []:
        out.append(
            {
                "stage_no": int(op.get("stage_no") or op.get("source_stage_no") or 0),
                "op_no": compact_text(op.get("op_no") or op.get("source_op_no")),
                "stage_desc": compact_text(
                    op.get("stage_desc") or op.get("op_type") or op.get("operation_name")
                ),
                "execution_status": compact_text(
                    op.get("execution_status") or op.get("erp_execution_status")
                ),
                "wo_qty_required": op.get("wo_qty_required") or op.get("required_qty"),
                "finished_qty": op.get("finished_qty") or op.get("wo_qty_produced"),
                "remaining_qty": op.get("remaining_qty"),
            }
        )
    return out


def _delivery_schedule_row_from_board(item):
    ps_id = compact_text(item.get("ps_id"))
    source = compact_text(item.get("source_ps_id") or item.get("display_ps_id") or ps_id)
    ps_base = source.split("::")[0] if source else ps_id.split("::")[0]
    try:
        partial_no = int(item.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        partial_no = 1
    if not item.get("pp_partial_no") and "::" in ps_id:
        try:
            partial_no = int(ps_id.rsplit("::", 1)[1])
        except ValueError:
            pass
    if is_temp_planner_ps_id(ps_id):
        ps_display = compact_text(item.get("display_ps_id") or ps_id)
    else:
        ps_display = format_planner_ps_id(ps_base, partial_no)
    return {
        "planner_ps_id": ps_id,
        "ps_id": ps_base,
        "partial_no": partial_no,
        "pp_partial_no": partial_no,
        "ps_display": ps_display,
        "part_no": compact_text(item.get("part_no") or item.get("part_name") or item.get("inventory_code")),
        "part_desc": compact_text(item.get("part_desc") or item.get("description")),
        "so_qty": _delivery_schedule_so_line_qty(item),
        "pp_partial_qty": _delivery_schedule_pp_partial_qty(item),
        "is_temp_ps": bool(item.get("is_temp_ps")),
        "due_date": compact_text(item.get("due_date")),
        "coway_edd": compact_text(item.get("coway_proposed_edd")),
        "remarks": compact_text(item.get("remarks")),
        "current_stage_desc": compact_text(item.get("current_stage_desc")),
        "current_stage_status": compact_text(item.get("current_stage_status")),
        "current_stage_no": int(item.get("current_stage_no") or 0),
        "planner_status": compact_text(item.get("planner_status")),
        "execution_status": compact_text(item.get("execution_status")),
        "execution_completed": bool(item.get("execution_completed")),
        "erp_all_wo_complete": bool(item.get("erp_all_wo_complete")),
        "is_queued": bool(item.get("is_queued")),
        "queued_machines": [
            compact_text(code) for code in (item.get("queued_machines") or []) if compact_text(code)
        ],
        "is_completed": bool(item.get("is_completed")),
        "shipped_completed": bool(item.get("shipped_completed")),
        "pending_do": bool(item.get("pending_do")),
        "ops": _delivery_schedule_ops_snapshot(item.get("ops")),
    }


def _build_delivery_schedule_rows(board_items):
    rows_out = [_delivery_schedule_row_from_board(item) for item in board_items]
    rows_out.sort(
        key=lambda item: (
            item.get("coway_edd") or item.get("due_date") or "9999-12-31",
            item.get("due_date") or "9999-12-31",
            item.get("ps_display") or "",
        )
    )
    return rows_out


_DELIVERY_SCHEDULE_CACHE: dict[str, dict] = {}
_DELIVERY_SCHEDULE_CACHE_LOCK = threading.Lock()
_DELIVERY_SCHEDULE_CACHE_TTL_SEC = 0


def _delivery_schedule_cache_key(search: str, full: bool) -> str:
    return f"{'full' if full else 'search'}:{compact_text(search).lower()}"


def _delivery_schedule_cache_get(key: str):
    now = time.monotonic()
    with _DELIVERY_SCHEDULE_CACHE_LOCK:
        bucket = _DELIVERY_SCHEDULE_CACHE.get(key)
        if not bucket:
            return None
        if now > float(bucket.get("expires_at") or 0):
            _DELIVERY_SCHEDULE_CACHE.pop(key, None)
            return None
        return bucket.get("payload")


def _delivery_schedule_cache_set(key: str, payload: dict) -> None:
    with _DELIVERY_SCHEDULE_CACHE_LOCK:
        _DELIVERY_SCHEDULE_CACHE[key] = {
            "payload": payload,
            "expires_at": time.monotonic() + _DELIVERY_SCHEDULE_CACHE_TTL_SEC,
        }


def clear_delivery_schedule_cache() -> None:
    with _DELIVERY_SCHEDULE_CACHE_LOCK:
        _DELIVERY_SCHEDULE_CACHE.clear()


def _apply_delivery_row_flags(con, items: list) -> None:
    from .delivery_planner_service import load_delivery_row_flags
    from .finishing_queue_service import load_checklist_done_flags

    ps_ids = [compact_text(item.get("planner_ps_id")) for item in items if compact_text(item.get("planner_ps_id"))]
    flags_map = planner_try_savepoint(
        con,
        "delivery_row_flags",
        lambda: load_delivery_row_flags(con, ps_ids),
        default={},
    ) or {}
    checklist_map = planner_try_savepoint(
        con,
        "delivery_checklist_flags",
        lambda: load_checklist_done_flags(con, ps_ids),
        default={},
    ) or {}
    for item in items:
        pid = compact_text(item.get("planner_ps_id"))
        flags = flags_map.get(pid) or {
            "dismissed": False,
            "exception": False,
            "coc_done": False,
            "qaqc_report_ready": False,
        }
        item["dismissed"] = bool(flags.get("dismissed"))
        item["exception"] = bool(flags.get("exception"))
        item["coc_done"] = bool(flags.get("coc_done"))
        item["qaqc_report_ready"] = bool(flags.get("qaqc_report_ready")) or bool(checklist_map.get(pid))


@trial_bp.get("/api/trial/delivery-schedule")
def api_trial_delivery_schedule():
    search = compact_text(request.args.get("search"))
    full = compact_text(request.args.get("full")).lower() in {"1", "true", "yes", "on"}
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    cache_key = _delivery_schedule_cache_key(search, full)
    if refresh:
        clear_delivery_schedule_cache()
    else:
        cached = _delivery_schedule_cache_get(cache_key)
        if cached is not None:
            return jsonify(cached)

    with planner_db() as con:
        board_items = list_delivery_schedule_board_items(con, search=search, full=full)
        items = _build_delivery_schedule_rows(board_items)
        _apply_delivery_row_flags(con, items)
        payload = {
            "items": items,
            "summary": {
                "total": len(items),
            },
        }
        _delivery_schedule_cache_set(cache_key, payload)
        return jsonify(payload)


@trial_bp.post("/api/trial/delivery-schedule/flags")
def api_trial_delivery_schedule_flags_post():
    from .delivery_planner_service import delivery_flags_post_response

    return delivery_flags_post_response()


@trial_bp.post("/api/trial/delivery-schedule/flags/bulk")
def api_trial_delivery_schedule_flags_bulk_post():
    from .delivery_planner_service import delivery_flags_bulk_post_response

    return delivery_flags_bulk_post_response()


@trial_bp.get("/api/trial/queue-delays")
def api_trial_queue_delays():
    with planner_db() as con:
        raw_rows = rows(
            con.execute(
                """
                WITH voucher_partials AS (
                    SELECT ps_id, pp_partial_no, MIN(due_date) AS due_date
                    FROM pp_vouchers_cache
                    GROUP BY ps_id, pp_partial_no
                )
                SELECT
                    b.block_id,
                    b.group_id,
                    b.machine_id,
                    b.queue_position,
                    b.scheduled_qty,
                    b.calculated_start_datetime,
                    b.calculated_end_datetime,
                    b.anchor_datetime,
                    b.execution_status,
                    m.machine_no AS machine_code,
                    m.machine_category,
                    o.source_ps_id,
                    o.source_op_no,
                    o.operation_name,
                    g.group_label,
                    qs.predicted_start_at,
                    qs.predicted_end_at,
                    ps.pp_partial_no,
                    ps.coway_proposed_edd,
                    vp.due_date
                FROM planner_run_block b
                JOIN planner_operation o ON o.operation_id = b.operation_id
                JOIN planner_machines m ON m.machine_id = b.machine_id
                LEFT JOIN planner_run_block_group g ON g.group_id = b.group_id
                LEFT JOIN planner_machine_queue_state qs ON qs.block_id = b.block_id
                LEFT JOIN planner_process_sheet ps ON ps.planner_ps_id = o.source_ps_id
                LEFT JOIN voucher_partials vp
                       ON vp.ps_id = ps.source_ps_id
                      AND vp.pp_partial_no = ps.pp_partial_no
                WHERE COALESCE(b.active, TRUE) = TRUE
                  AND UPPER(REPLACE(REPLACE(COALESCE(b.execution_status, ''), '-', '_'), ' ', '_'))
                      NOT IN ('DONE', 'COMPLETED')
                ORDER BY m.machine_id, b.queue_position, b.block_id
                """
            )
        )

        for row in raw_rows:
            row["calculated_start_datetime"] = planner_wall_datetime_to_api(row.get("calculated_start_datetime"))
            row["calculated_end_datetime"] = planner_wall_datetime_to_api(row.get("calculated_end_datetime"))
            row["anchor_datetime"] = planner_wall_datetime_to_api(row.get("anchor_datetime"))
            row["predicted_start_at"] = planner_wall_datetime_to_api(row.get("predicted_start_at"))
            row["predicted_end_at"] = planner_wall_datetime_to_api(row.get("predicted_end_at"))
            row["due_date"] = compact_text(row.get("due_date"))
            row["coway_proposed_edd"] = compact_text(row.get("coway_proposed_edd"))
            row["scheduled_qty"] = float(row.get("scheduled_qty") or 0)

        jobs = _build_queue_delay_jobs(raw_rows)
        at_risk = sum(1 for job in jobs if job.get("at_risk"))
        return jsonify(
            {
                "jobs": jobs,
                "summary": {
                    "total": len(jobs),
                    "at_risk": at_risk,
                },
            }
        )


@trial_bp.get("/api/trial/public-holidays")
def api_trial_public_holidays_list():
    from_iso = compact_text(request.args.get("from") or request.args.get("start"))
    to_iso = compact_text(request.args.get("to") or request.args.get("end"))
    today = date.today()
    try:
        start_d = datetime.fromisoformat(from_iso).date() if from_iso else today.replace(month=1, day=1)
    except ValueError:
        return jsonify({"error": "from must be YYYY-MM-DD"}), 400
    try:
        end_d = datetime.fromisoformat(to_iso).date() if to_iso else today.replace(month=12, day=31)
    except ValueError:
        return jsonify({"error": "to must be YYYY-MM-DD"}), 400
    if end_d < start_d:
        start_d, end_d = end_d, start_d

    live = compact_text(request.args.get("live")).lower() in {"1", "true", "yes"}
    if live:
        try:
            live_rows = fetch_sg_public_holidays(from_date=start_d, to_date=end_d)
        except Exception as exc:
            return jsonify({"error": f"Could not fetch SG holidays: {exc}"}), 502
        return jsonify(
            {
                "ok": True,
                "from": start_d.isoformat(),
                "to": end_d.isoformat(),
                "live": True,
                "holidays": live_rows,
            }
        )

    with planner_db() as con:
        stored = list_public_holidays(con, start_d, end_d)
    return jsonify(
        {
            "ok": True,
            "from": start_d.isoformat(),
            "to": end_d.isoformat(),
            "live": False,
            "holidays": stored,
        }
    )


def _refresh_sg_public_holidays_payload(data):
    today = date.today()
    from_year = data.get("from_year")
    to_year = data.get("to_year")
    try:
        from_year = int(from_year) if from_year is not None else today.year - 1
        to_year = int(to_year) if to_year is not None else today.year + 1
    except (TypeError, ValueError):
        return None, (jsonify({"error": "from_year and to_year must be integers"}), 400)

    recalculate = not compact_text(data.get("no_recalc")).lower() in {"1", "true", "yes"}
    try:
        with planner_db() as con:
            result = sync_sg_public_holidays_to_db(con, from_year=from_year, to_year=to_year)
        if recalculate:
            with planner_db() as con:
                recalculate_all(con)
    except Exception as exc:
        import logging

        logging.getLogger(__name__).exception("SG public holiday refresh failed")
        return None, (jsonify({"error": str(exc)}), 502)

    return (
        {
            **result,
            "recalculated": recalculate,
        },
        None,
    )


@trial_bp.post("/api/trial/public-holidays/refresh")
@trial_bp.post("/api/trial/refresh-public-holidays")
def api_trial_public_holidays_refresh():
    data = request.get_json(force=True, silent=True) or {}
    payload, error = _refresh_sg_public_holidays_payload(data)
    if error:
        return error
    return jsonify(payload)


def _apply_capacity_day_for_all_machines(con, work_day, profile_name, note):
    machines = fetch_machines(con)
    if not machines:
        return None
    for machine in machines:
        if work_day.weekday() == 6 or is_public_holiday(con, work_day):
            machine_profile_name = "OFF"
        else:
            machine_profile_name = profile_name or default_profile_for_weekday(work_day.weekday(), machine["shift_profile"])
            if compact_text(machine.get("shift_profile", "")).upper() == "24HR" and machine_profile_name in {"NORMAL_DAY_NIGHT", "SATURDAY"}:
                machine_profile_name = "FULL_24H"
        profile = one(con.execute("SELECT * FROM planner_capacity_profile WHERE profile_name = %s", (machine_profile_name,)))
        if not profile:
            profile = one(con.execute("SELECT * FROM planner_capacity_profile ORDER BY profile_id LIMIT 1"))
        if not profile:
            return None
        con.execute(
            """
            INSERT INTO planner_machine_capacity_day (machine_id, work_date, profile_id, capacity_minutes, start_minute, note, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (machine_id, work_date) DO UPDATE SET
              profile_id = EXCLUDED.profile_id,
              capacity_minutes = EXCLUDED.capacity_minutes,
              start_minute = EXCLUDED.start_minute,
              note = EXCLUDED.note,
              updated_at = NOW()
            """,
            (
                int(machine["machine_id"]),
                work_day.isoformat(),
                int(profile["profile_id"]),
                int(profile["capacity_minutes"] or 0),
                int(profile["start_minute"] or 0),
                compact_text(note),
            ),
        )
    return {"machine_count": len(machines)}


@trial_bp.post("/api/trial/capacity")
def api_trial_capacity():
    data = request.get_json(force=True, silent=True) or {}
    work_date = compact_text(data.get("work_date"))
    if not work_date:
        return jsonify({"error": "Work date is required"}), 400
    profile_name = compact_text(data.get("profile_name"))
    note = compact_text(data.get("note"))
    try:
        work_day = datetime.fromisoformat(work_date).date()
    except ValueError:
        return jsonify({"error": "Work date must be YYYY-MM-DD"}), 400
    try:
        with planner_db() as con:
            applied = _apply_capacity_day_for_all_machines(con, work_day, profile_name, note)
            if not applied:
                return jsonify({"error": "No capacity profiles available"}), 400
        with planner_db() as con:
            recalculate_all(con)
        return jsonify({"ok": True, "work_date": work_date, **applied})
    except Exception as exc:
        import logging

        logging.getLogger(__name__).exception("capacity save failed for %s", work_date)
        return jsonify({"error": str(exc)}), 500


@trial_bp.get("/api/trial/machine-calendar-windows")
def api_trial_machine_calendar_windows_list():
    machine_id = int(request.args.get("machine_id") or 0)
    active_arg = request.args.get("active")
    window_type = compact_text(request.args.get("window_type")).upper()
    from_iso = compact_text(request.args.get("from"))
    to_iso = compact_text(request.args.get("to"))
    active = None
    if active_arg is not None and compact_text(active_arg) != "":
        active = 1 if compact_text(active_arg).lower() in {"1", "true", "yes", "on"} else 0
    with planner_db() as con:
        windows = [_calendar_window_payload(row) for row in _calendar_window_rows(
            con, from_iso or None, to_iso or None, machine_id or None, active, window_type or None
        )]
        return jsonify({"ok": True, "calendar_windows": windows})


@trial_bp.post("/api/trial/machine-calendar-windows")
def api_trial_machine_calendar_windows_create():
    data = request.get_json(force=True, silent=True) or {}
    machine_id = int(data.get("machine_id") or 0)
    start_at = compact_text(data.get("start_at"))
    end_at = compact_text(data.get("end_at"))
    window_type = compact_text(data.get("window_type")).upper()
    note = compact_text(data.get("note"))
    capacity_minutes = int(parse_number(data.get("capacity_minutes"), 0))
    active = bool(data.get("active", True))
    allowed_types = {"AVAILABLE", "DOWN", "OVERTIME", "HOLIDAY", "MAINTENANCE", "BLOCKED"}
    if not machine_id:
        return jsonify({"error": "Machine is required"}), 400
    if not start_at or not end_at:
        return jsonify({"error": "start_at and end_at are required"}), 400
    if window_type not in allowed_types:
        return jsonify({"error": "Invalid window_type"}), 400
    try:
        start_dt = datetime.fromisoformat(start_at.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(end_at.replace("Z", "+00:00"))
    except ValueError:
        return jsonify({"error": "start_at and end_at must be ISO datetimes"}), 400
    if end_dt <= start_dt:
        return jsonify({"error": "start_at must be earlier than end_at"}), 400
    with planner_db() as con:
        machine = one(con.execute("SELECT machine_id FROM planner_machines WHERE machine_id = %s", (machine_id,)))
        if not machine:
            return jsonify({"error": "Machine not found"}), 404
        cur = con.execute(
            """
            INSERT INTO planner_machine_calendar_window (
              machine_id, start_at, end_at, window_type, capacity_minutes, note, active, created_at, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
            RETURNING window_id
            """,
            (
                machine_id,
                start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                window_type,
                capacity_minutes,
                note,
                active,
            ),
        )
        window_id = int(one(cur)["window_id"])
        recalculate_machine(con, machine_id)
        row = one(
            con.execute(
                """
                SELECT w.*, m.machine_no AS machine_code
                FROM planner_machine_calendar_window w
                LEFT JOIN planner_machines m ON m.machine_id = w.machine_id
                WHERE w.window_id = %s
                """,
                (window_id,),
            )
        )
        return jsonify({"ok": True, "window": _calendar_window_payload(row)})


@trial_bp.patch("/api/trial/machine-calendar-windows/<int:window_id>")
def api_trial_machine_calendar_windows_update(window_id):
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        row = one(con.execute("SELECT * FROM planner_machine_calendar_window WHERE window_id = %s", (int(window_id),)))
        if not row:
            return jsonify({"error": "Window not found"}), 404
        allowed_types = {"AVAILABLE", "DOWN", "OVERTIME", "HOLIDAY", "MAINTENANCE", "BLOCKED"}
        updates = {}
        machine_id = int(data.get("machine_id") or row["machine_id"])
        if "machine_id" in data:
            machine = one(con.execute("SELECT machine_id FROM planner_machines WHERE machine_id = %s", (machine_id,)))
            if not machine:
                return jsonify({"error": "Machine not found"}), 404
            updates["machine_id"] = machine_id
        if "start_at" in data:
            updates["start_at"] = compact_text(data.get("start_at"))
        if "end_at" in data:
            updates["end_at"] = compact_text(data.get("end_at"))
        if "window_type" in data:
            window_type = compact_text(data.get("window_type")).upper()
            if window_type not in allowed_types:
                return jsonify({"error": "Invalid window_type"}), 400
            updates["window_type"] = window_type
        if "capacity_minutes" in data:
            updates["capacity_minutes"] = int(parse_number(data.get("capacity_minutes"), 0))
        if "note" in data:
            updates["note"] = compact_text(data.get("note"))
        if "active" in data:
            updates["active"] = bool(data.get("active"))
        if "start_at" in updates or "end_at" in updates:
            try:
                start_dt = datetime.fromisoformat((updates.get("start_at") or compact_text(row["start_at"])).replace("Z", "+00:00"))
                end_dt = datetime.fromisoformat((updates.get("end_at") or compact_text(row["end_at"])).replace("Z", "+00:00"))
            except ValueError:
                return jsonify({"error": "start_at and end_at must be ISO datetimes"}), 400
            if end_dt <= start_dt:
                return jsonify({"error": "start_at must be earlier than end_at"}), 400
            updates["start_at"] = start_dt.strftime("%Y-%m-%d %H:%M:%S")
            updates["end_at"] = end_dt.strftime("%Y-%m-%d %H:%M:%S")
        if updates:
            set_clause = ", ".join(f"{key} = %s" for key in updates)
            con.execute(
                f"UPDATE planner_machine_calendar_window SET {set_clause}, updated_at = NOW() WHERE window_id = %s",
                (*updates.values(), int(window_id)),
            )
        recalculate_machine(con, machine_id)
        row = one(
            con.execute(
                """
                SELECT w.*, m.machine_no AS machine_code
                FROM planner_machine_calendar_window w
                LEFT JOIN planner_machines m ON m.machine_id = w.machine_id
                WHERE w.window_id = %s
                """,
                (int(window_id),),
            )
        )
        return jsonify({"ok": True, "window": _calendar_window_payload(row)})


@trial_bp.delete("/api/trial/machine-calendar-windows/<int:window_id>")
def api_trial_machine_calendar_windows_delete(window_id):
    with planner_db() as con:
        row = one(con.execute("SELECT * FROM planner_machine_calendar_window WHERE window_id = %s", (int(window_id),)))
        if not row:
            return jsonify({"error": "Window not found"}), 404
        con.execute(
            "UPDATE planner_machine_calendar_window SET active = FALSE, updated_at = NOW() WHERE window_id = %s",
            (int(window_id),),
        )
        recalculate_machine(con, int(row["machine_id"]))
        return jsonify({"ok": True, "window_id": int(window_id)})


@trial_bp.get("/api/trial/cycle-times/resolve")
def api_trial_resolve_cycle_times():
    """Resolve cycle/setup for a catalog op from master (same source as cycle-times UI)."""
    from .cycle_time_service import MasterTimeCache, resolve_step_times, _parse_op_no

    part_no = compact_text(request.args.get("part_no"))
    if not part_no:
        return jsonify({"error": "part_no is required"}), 400
    bom_code = compact_text(request.args.get("bom_code"))
    op_no = _parse_op_no(request.args.get("op_no"))
    op_type = compact_text(request.args.get("op_type"))
    stage_no = int(request.args.get("stage_no") or 0)
    extra_part = compact_text(request.args.get("inventory_code") or request.args.get("part_desc"))
    try:
        with planner_db() as con:
            master_cache = MasterTimeCache.load(con)
            resolved = resolve_step_times(
                con,
                part_no=part_no,
                bom_code=bom_code,
                step={
                    "op_no": request.args.get("op_no"),
                    "op_type": op_type,
                    "source_stage_no": stage_no,
                    "cycle_time": parse_number(request.args.get("fallback_cycle"), 0),
                    "setup_time": parse_number(request.args.get("fallback_setup"), 0),
                },
                extra_part_nos=[extra_part] if extra_part else None,
                master_cache=master_cache,
            )
        return jsonify(resolved)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 500


@trial_bp.post("/api/trial/operations")
def api_trial_create_operation():
    data = request.get_json(force=True, silent=True) or {}
    job_no = compact_text(data.get("job_no"))
    operation_name = compact_text(data.get("operation_name"))
    machine_id = int(data.get("machine_id") or 0)
    if not job_no or not operation_name:
        return jsonify({"error": "Job number and operation name are required"}), 400
    if not machine_id:
        return jsonify({"error": "Machine is required"}), 400
    try:
        with planner_db() as con:
            machine_row = one(
                con.execute(
                    """
                    SELECT machine_id, machine_no AS machine_code, machine_no, machine_category
                    FROM planner_machines
                    WHERE machine_id = %s AND active = TRUE
                    """,
                    (machine_id,),
                )
            )
            if not machine_row:
                return jsonify({"error": "Machine not found"}), 400
            raw_source_ps = compact_text(data.get("source_ps_id")) or job_no
            src_base, src_partial = parse_planner_ps_id(raw_source_ps)
            job_base, job_partial = parse_planner_ps_id(job_no)
            if job_base and not src_base:
                src_base = job_base
            if int(job_partial or 1) > int(src_partial or 1):
                src_partial = int(job_partial)
            try:
                body_partial = int(data.get("pp_partial_no") or 0)
            except (TypeError, ValueError):
                body_partial = 0
            if body_partial > 0:
                src_partial = body_partial
            source_ps_id_val = format_planner_ps_id(src_base, src_partial) if src_base else raw_source_ps
            source_op_no_val = compact_text(data.get("source_op_no"))
            source_op_seq_val = int(data.get("source_op_seq_id") or 0)

            from .cycle_time_service import resolve_schedule_times

            resolved_times = resolve_schedule_times(
                con,
                source_ps_id=source_ps_id_val,
                source_op_seq_id=source_op_seq_val,
                source_op_no=source_op_no_val,
                cycle_minutes_per_qty=parse_number(data.get("cycle_minutes_per_qty"), 0),
                setup_minutes=parse_number(data.get("setup_minutes"), 0),
            )
            cycle_minutes_per_qty = float(resolved_times.get("cycle_minutes_per_qty") or 0)
            setup_minutes = float(resolved_times.get("setup_minutes") or 0)
            cycle_error = validate_cycle_minutes(
                data.get("total_qty"),
                data.get("scheduled_qty"),
                cycle_minutes_per_qty,
            )
            if cycle_error:
                return jsonify({"error": cycle_error}), 400
            existing_block_id = find_active_catalog_lane_block(
                con,
                machine_id,
                source_ps_id_val,
                source_op_no_val,
                source_op_seq_val,
            )
            if existing_block_id:
                dup_row = one(
                    con.execute(
                        """
                        SELECT o.source_ps_id, o.job_no
                        FROM planner_run_block b
                        JOIN planner_operation o ON o.operation_id = b.operation_id
                        WHERE b.block_id = %s
                        """,
                        (existing_block_id,),
                    )
                )
                if dup_row:
                    _, dup_partial = _row_planner_ps_identity(dup_row)
                    _, want_partial = parse_planner_ps_id(source_ps_id_val)
                    if int(dup_partial) != int(want_partial):
                        existing_block_id = None
                    elif body_partial > 0 and int(dup_partial) != int(body_partial):
                        existing_block_id = None

            if existing_block_id:
                queue_position = float(data.get("queue_position") or 0)
                if queue_position > 0:
                    from .operation_sequence import apply_machine_queue_order, main_planner_lane_block_ids

                    ordered_ids = main_planner_lane_block_ids(con, machine_id)
                    ordered_ids = [bid for bid in ordered_ids if bid != existing_block_id]
                    insert_idx = min(max(0, int(queue_position) - 1), len(ordered_ids))
                    ordered_ids.insert(insert_idx, existing_block_id)
                    recalculate = _parse_recalculate_flag(data)
                    apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=recalculate)
                block = trial_block_row(con, existing_block_id)
                _, dup_partial_out = _row_planner_ps_identity(block)
                _, want_partial_out = parse_planner_ps_id(source_ps_id_val)
                return jsonify({
                    "ok": True,
                    "duplicate": True,
                    "operation_id": int(block["operation_id"]),
                    "block": trial_block_payload(block, None),
                    "requested_source_ps_id": source_ps_id_val,
                    "requested_partial_no": int(want_partial_out),
                    "matched_partial_no": int(dup_partial_out),
                    "machine_refresh": _trial_machine_refresh_payload(con, [machine_id], lite=True),
                })

            planning_status, execution_status = normalize_block_status_inputs(data)
            op_cur = con.execute(
                """
                INSERT INTO planner_operation (
                  job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty, compatible_machine_group,
                  source_ps_id, source_op_seq_id, source_op_no, status, remarks, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                RETURNING operation_id
                """,
                (
                    source_ps_id_val or job_no,
                    operation_name,
                    parse_number(data.get("total_qty"), parse_number(data.get("scheduled_qty"), 0)),
                    setup_minutes,
                    cycle_minutes_per_qty,
                    compact_text(data.get("compatible_machine_group")),
                    source_ps_id_val or None,
                    int(data.get("source_op_seq_id") or 0),
                    compact_text(data.get("source_op_no")),
                    compact_text(data.get("status") or "ACTIVE") or "ACTIVE",
                    compact_text(data.get("remarks")),
                ),
            )
            operation_id = int(one(op_cur)["operation_id"])
            queue_position = float(data.get("queue_position") or 0)
            if queue_position <= 0:
                from .operation_sequence import main_planner_lane_max_queue_position

                queue_position = main_planner_lane_max_queue_position(con, machine_id) + 1
            block_cur = con.execute(
                """
                INSERT INTO planner_run_block (
                  operation_id, machine_id, queue_position, scheduled_qty, include_setup, status, planning_status, execution_status,
                  anchor_datetime, calculated_start_datetime, calculated_end_datetime, actual_good_qty, actual_reject_qty, remarks, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NULL, NULL, NULL, 0, 0, %s, NOW())
                RETURNING block_id
                """,
                (
                    operation_id,
                    machine_id,
                    queue_position,
                    parse_number(data.get("scheduled_qty"), parse_number(data.get("total_qty"), 0)),
                    bool(data.get("include_setup", True)),
                    execution_status,
                    planning_status,
                    execution_status,
                    compact_text(data.get("remarks")),
                ),
            )
            block_id = int(one(block_cur)["block_id"])
            from .auto_unschedule import apply_saved_anchor_to_new_block
            from .preferred_machines_service import sync_preferred_machine_from_block
            from .preferred_machines_route import invalidate_preferred_machines_cache

            apply_saved_anchor_to_new_block(
                con,
                block_id,
                source_ps_id_val or job_no,
                compact_text(data.get("source_op_no")),
                explicit_anchor=data.get("anchor_datetime"),
            )
            sync_preferred_machine_from_block(con, block_id, source="BLOCK_CREATE")
            invalidate_preferred_machines_cache()

            # Write planning card + operation link when this op has a process sheet source
            if source_ps_id_val:
                ensure_planner_process_sheet(con, source_ps_id_val)
                scheduled_qty_val = parse_number(data.get("scheduled_qty"), parse_number(data.get("total_qty"), 0))
                card_label = compact_text(data.get("source_op_no")) or operation_name
                card_cur2 = con.execute(
                    """
                    INSERT INTO planner_planning_card (
                      planner_ps_id, operation_label, target_qty, planning_status, card_type,
                      machine_id, scheduled_block_group_id, created_at, updated_at
                    ) VALUES (%s, %s, %s, 'SCHEDULED', 'SINGLE', %s, NULL, NOW(), NOW())
                    RETURNING card_id
                    """,
                    (source_ps_id_val, card_label, scheduled_qty_val, machine_id),
                )
                card_id_val = int(one(card_cur2)["card_id"])
                con.execute(
                    """
                    INSERT INTO planner_planning_card_operation (
                      card_id, source_ps_id, source_op_seq_id, source_op_no, op_sequence,
                      setup_minutes, cycle_minutes_per_qty, target_qty
                    ) VALUES (%s, %s, %s, %s, 1, %s, %s, %s)
                    """,
                    (
                        card_id_val,
                        source_ps_id_val,
                        int(data.get("source_op_seq_id") or 0),
                        compact_text(data.get("source_op_no")),
                        setup_minutes,
                        cycle_minutes_per_qty,
                        scheduled_qty_val,
                    ),
                )

            requested_queue = float(data.get("queue_position") or 0)
            recalculate = _parse_recalculate_flag(data)
            queue_sync_result = None
            if requested_queue <= 0 and not recalculate:
                from .operation_sequence import (
                    compact_main_planner_lane_queue,
                    sync_planning_cards_for_machine,
                    update_planning_card_machine_for_block,
                )

                update_planning_card_machine_for_block(con, block_id, machine_id)
                queue_sync_result = compact_main_planner_lane_queue(con, machine_id, recalculate=False)
                sync_planning_cards_for_machine(con, machine_id)
                if queue_sync_result.get("tail_recalculated"):
                    recalculate = True
            else:
                from .operation_sequence import apply_machine_queue_order, main_planner_lane_block_ids

                ordered_ids = main_planner_lane_block_ids(con, machine_id)
                if block_id in ordered_ids and queue_position > 0:
                    ordered_ids = [bid for bid in ordered_ids if bid != block_id]
                    insert_idx = min(max(0, int(queue_position) - 1), len(ordered_ids))
                    ordered_ids.insert(insert_idx, block_id)
                apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=recalculate)
            return jsonify({
                "ok": True,
                "operation_id": operation_id,
                "recalculated": recalculate,
                "block": trial_block_payload(trial_block_row(con, block_id), None),
                "machine_refresh": _trial_machine_refresh_payload(con, [machine_id], lite=True),
            })
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 400


@trial_bp.post("/api/trial/dummy-cards")
def api_trial_create_dummy_card():
    data = request.get_json(force=True, silent=True) or {}
    try:
        with planner_db() as con:
            machine_id = int(data.get("machine_id") or 0)
            machine_row = one(
                con.execute(
                    """
                    SELECT machine_id, machine_no AS machine_code, machine_no, machine_category
                    FROM planner_machines
                    WHERE machine_id = %s AND active = TRUE
                    """,
                    (machine_id,),
                )
            )
            if not machine_row:
                return jsonify({"error": "Machine not found"}), 400
            block = create_dummy_card(
                con,
                title=data.get("title"),
                description=data.get("description"),
                machine_id=machine_id,
                start_datetime=data.get("start_datetime"),
                end_datetime=data.get("end_datetime"),
                duration_minutes=data.get("duration_minutes"),
                time_mode=data.get("time_mode"),
                queue_position=float(data.get("queue_position") or 0),
            )
            machine_id = int(block["machine_id"])
            return jsonify({
                "ok": True,
                "block": trial_block_payload(block, None),
                "machine_refresh": _trial_machine_refresh_payload(con, [machine_id], lite=True),
            })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 400


@trial_bp.put("/api/trial/dummy-cards/<int:block_id>")
def api_trial_update_dummy_card(block_id):
    data = request.get_json(force=True, silent=True) or {}
    try:
        with planner_db() as con:
            existing = trial_block_row(con, block_id)
            if not existing:
                return jsonify({"error": "Run block not found"}), 404
            original_machine_id = int(existing["machine_id"])
            block = update_dummy_card(
                con,
                block_id,
                title=data.get("title") if "title" in data else None,
                description=data.get("description") if "description" in data else None,
                machine_id=int(data.get("machine_id")) if "machine_id" in data else None,
                start_datetime=data.get("start_datetime") if "start_datetime" in data else None,
                end_datetime=data.get("end_datetime") if "end_datetime" in data else None,
                duration_minutes=data.get("duration_minutes") if "duration_minutes" in data else None,
                time_mode=data.get("time_mode") if "time_mode" in data else None,
            )
            machine_ids = {original_machine_id, int(block["machine_id"])}
            return jsonify({
                "ok": True,
                "block": trial_block_payload(block, None),
                "machine_refresh": _trial_machine_refresh_payload(con, sorted(machine_ids), lite=True),
            })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 400


@trial_bp.post("/api/trial/catalog/combine")
def api_trial_combine_catalog_ops():
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        try:
            card = create_planning_card(con, data.get("ps_id"), data.get("ops") or [], data.get("target_qty"))
            return jsonify({"ok": True, "card": card})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400


@trial_bp.post("/api/trial/planning-cards")
def api_trial_create_planning_card():
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        try:
            card = create_planning_card(con, data.get("ps_id"), data.get("ops") or [], data.get("target_qty"))
            return jsonify({"ok": True, "card": card})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400


@trial_bp.post("/api/trial/planning-cards/<int:card_id>/schedule")
def api_trial_schedule_planning_card(card_id):
    data = request.get_json(force=True, silent=True) or {}
    machine_id = int(data.get("machine_id") or 0)
    queue_position = float(data.get("queue_position") or 0)
    recalculate = _parse_recalculate_flag(data)
    with planner_db() as con:
        try:
            if machine_id:
                machine_row = one(
                    con.execute(
                        """
                        SELECT machine_id, machine_no AS machine_code, machine_no, machine_category
                        FROM planner_machines
                        WHERE machine_id = %s AND active = TRUE
                        """,
                        (machine_id,),
                    )
                )
            result = schedule_planning_card(con, card_id, machine_id, queue_position)
            affected_machine_id = int(
                (result.get("group") or {}).get("machine_id")
                or (result.get("card") or {}).get("machine_id")
                or machine_id
            )
            if affected_machine_id and recalculate:
                created_ids = [int(value) for value in (result.get("block_ids") or []) if int(value or 0) > 0]
                tail_by_machine = {affected_machine_id: created_ids[0]} if created_ids else {}
                recalculate_machines(con, [affected_machine_id], tail_by_machine=tail_by_machine)
            refresh_ids = [affected_machine_id] if affected_machine_id else []
            return jsonify({
                "ok": True,
                "recalculated": recalculate,
                **result,
                "machine_refresh": _trial_machine_refresh_payload(con, refresh_ids, lite=True),
            })
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400


@trial_bp.delete("/api/trial/planning-cards/<int:card_id>")
def api_trial_delete_planning_card(card_id):
    with planner_db() as con:
        card = planning_card_row(con, card_id)
        if not card:
            return jsonify({"error": "Combined op card not found"}), 404
        if compact_text(card["planning_status"]).upper() == "SCHEDULED" or int(card.get("scheduled_block_group_id") or 0) > 0:
            return jsonify({"error": "This combined op card is already scheduled. Remove it from the machine schedule first."}), 400
        con.execute("DELETE FROM planner_planning_card WHERE card_id = %s", (int(card_id),))
        return jsonify({"ok": True, "card_id": int(card_id)})


@trial_bp.get("/api/trial/blocks/<int:block_id>/actual-detail")
def api_trial_block_actual_detail(block_id):
    """Lightweight actual entry payload for one block (planner modal)."""
    with planner_db() as con:
        block = trial_block_row(con, block_id)
        if not block:
            return jsonify({"error": "Run block not found"}), 404
        attach_actual_daily_to_blocks(con, [block], with_erp=True)
        segments = rows(
            con.execute(
                """
                SELECT s.segment_id, s.block_id, s.segment_date::text AS segment_date,
                       s.planned_qty, s.qty_done, s.start_datetime, s.end_datetime,
                       s.segment_type, s.minutes_used
                FROM planner_run_block_segment s
                WHERE s.block_id = %s
                ORDER BY s.segment_date, s.segment_id
                """,
                (int(block_id),),
            )
        )
        for seg in segments:
            seg["start_datetime"] = planner_wall_datetime_to_api(seg.get("start_datetime"))
            seg["end_datetime"] = planner_wall_datetime_to_api(seg.get("end_datetime"))
            seg["segment_date"] = compact_text(seg.get("segment_date"))
        actuals = rows(
            con.execute(
                """
                SELECT actual_id, segment_id, block_id, report_date::text AS report_date,
                       output_qty, reject_qty, target_qty_at_report, remarks, reported_at
                FROM planner_production_actual
                WHERE block_id = %s
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                ORDER BY report_date, actual_id
                """,
                (int(block_id),),
            )
        )
        for actual in actuals:
            actual["reported_at"] = compact_text(actual.get("reported_at"))
        return jsonify(
            {
                "block": block,
                "segments": segments,
                "actuals": actuals,
                "actual_daily_rows": block.get("actual_daily_rows") or [],
            }
        )


@trial_bp.put("/api/trial/blocks/<int:block_id>")
def api_trial_update_block(block_id):
    data = request.get_json(force=True, silent=True) or {}
    recalculate = False if "recalculate" not in data else _parse_recalculate_flag(data)
    with planner_db() as con:
        block = trial_block_row(con, block_id)
        if not block:
            return jsonify({"error": "Run block not found"}), 404
        guard = _mpp_planner_block_guard(con, block)
        if guard:
            return guard
        next_total_qty = data.get("total_qty", block["total_qty"])
        next_scheduled_qty = data.get("scheduled_qty", block["scheduled_qty"])
        next_cycle_minutes = data.get("cycle_minutes_per_qty", block["cycle_minutes_per_qty"])
        cycle_error = validate_cycle_minutes(next_total_qty, next_scheduled_qty, next_cycle_minutes)
        if cycle_error:
            return jsonify({"error": cycle_error}), 400
        op_updates = {}
        for key in ("job_no", "operation_name", "compatible_machine_group", "remarks"):
            if key in data:
                op_updates[key] = compact_text(data.get(key))
        for key in ("total_qty", "setup_minutes", "cycle_minutes_per_qty"):
            if key in data:
                op_updates[key] = parse_number(data.get(key), 0)
        if op_updates:
            set_clause = ", ".join(f"{k} = %s" for k in op_updates)
            con.execute(
                f"UPDATE planner_operation SET {set_clause}, updated_at = NOW() WHERE operation_id = %s",
                (*op_updates.values(), int(block["operation_id"])),
            )
            timing_sync = {}
            if "setup_minutes" in op_updates:
                timing_sync["setup_minutes"] = op_updates["setup_minutes"]
            if "cycle_minutes_per_qty" in op_updates:
                timing_sync["cycle_minutes_per_qty"] = op_updates["cycle_minutes_per_qty"]
            if timing_sync:
                from .blocks import sync_catalog_op_timing_fields

                sync_catalog_op_timing_fields(
                    con,
                    int(block["operation_id"]),
                    **timing_sync,
                )
        block_updates = {}
        if any(key in data for key in ("planning_status", "execution_status", "status")):
            planning_status, execution_status = normalize_block_status_inputs(
                data,
                default_planning=compact_text(block["planning_status"]) or "PLANNED",
                default_execution=compact_text(block["execution_status"] or block["status"]) or "NOT_STARTED",
            )
            block_updates["planning_status"] = planning_status
            block_updates["execution_status"] = execution_status
            block_updates["status"] = execution_status
        if "machine_id" in data:
            block_updates["machine_id"] = int(data.get("machine_id") or block["machine_id"])
        if "scheduled_qty" in data:
            block_updates["scheduled_qty"] = max(0.0, parse_number(data.get("scheduled_qty"), block["scheduled_qty"]))
        if "include_setup" in data:
            block_updates["include_setup"] = bool(data.get("include_setup"))
        if "anchor_datetime" in data:
            raw_anchor = compact_text(data.get("anchor_datetime"))
            block_updates["anchor_datetime"] = (
                planner_wall_datetime_from_input(raw_anchor) if raw_anchor else None
            )
            block_updates["allow_pull_forward"] = not bool(raw_anchor)
            if raw_anchor:
                block_updates["planned_start_at"] = block_updates["anchor_datetime"]
        if "actual_good_qty" in data:
            block_updates["actual_good_qty"] = max(0.0, parse_number(data.get("actual_good_qty"), block["actual_good_qty"]))
        if "actual_reject_qty" in data:
            block_updates["actual_reject_qty"] = max(0.0, parse_number(data.get("actual_reject_qty"), block["actual_reject_qty"]))
        if "remarks" in data:
            block_updates["remarks"] = compact_text(data.get("remarks"))
        original_machine_id = int(block["machine_id"])
        new_machine_id = int(block_updates.get("machine_id") or original_machine_id)
        machine_changed = "machine_id" in block_updates and new_machine_id != original_machine_id
        if block_updates:
            set_clause = ", ".join(f"{k} = %s" for k in block_updates)
            con.execute(
                f"UPDATE planner_run_block SET {set_clause}, updated_at = NOW() WHERE block_id = %s",
                (*block_updates.values(), int(block_id)),
            )
        if machine_changed:
            from .operation_sequence import apply_machine_queue_order, compact_machine_lane_queue

            dest_rows = rows(
                con.execute(
                    """
                    SELECT block_id
                    FROM planner_run_block
                    WHERE machine_id = %s
                      AND COALESCE(active, TRUE) = TRUE
                    ORDER BY queue_position, block_id
                    """,
                    (new_machine_id,),
                )
            )
            ordered_ids = [
                int(row["block_id"])
                for row in dest_rows
                if int(row["block_id"]) != int(block_id)
            ]
            ordered_ids.append(int(block_id))
            apply_machine_queue_order(
                con,
                new_machine_id,
                ordered_ids,
                recalculate=recalculate,
            )
            if original_machine_id != new_machine_id:
                compact_machine_lane_queue(con, original_machine_id, recalculate=False)
        elif recalculate:
            recalculate_machine(con, original_machine_id, tail_from_block_id=int(block_id))
        if "machine_id" in block_updates:
            from .preferred_machines_service import sync_preferred_machine_from_block
            from .preferred_machines_route import invalidate_preferred_machines_cache

            sync_preferred_machine_from_block(con, int(block_id), source="BLOCK_UPDATE")
            invalidate_preferred_machines_cache()
        machine_ids = {original_machine_id}
        if "machine_id" in block_updates:
            machine_ids.add(int(block_updates["machine_id"]))
        affected_ids = sorted(machine_ids)
        return jsonify({
            "ok": True,
            "recalculated": recalculate,
            "block_id": int(block_id),
            "machine_refresh": _trial_machine_refresh_payload(con, affected_ids, lite=True),
        })


@trial_bp.post("/api/trial/blocks/<int:block_id>/split")
def api_trial_split_block(block_id):
    data = request.get_json(force=True, silent=True) or {}
    split_qty = parse_number(data.get("split_qty"), 0)
    if split_qty <= 0:
        return jsonify({"error": "Split quantity is required"}), 400
    with planner_db() as con:
        block = trial_block_row(con, block_id)
        if not block:
            return jsonify({"error": "Run block not found"}), 404
        guard = _mpp_planner_block_guard(con, block)
        if guard:
            return guard
        if split_qty >= float(block["scheduled_qty"] or 0):
            return jsonify({"error": "Split quantity must be smaller than the scheduled quantity"}), 400
        remaining = float(block["scheduled_qty"] or 0) - split_qty
        machine_id = int(block["machine_id"])
        current_position = float(block["queue_position"] or 0)
        next_block = one(
            con.execute(
                """
                SELECT block_id, queue_position
                FROM planner_run_block
                WHERE machine_id = %s
                  AND COALESCE(active, TRUE) = TRUE
                  AND queue_position > %s
                  AND block_id <> %s
                ORDER BY queue_position, block_id
                LIMIT 1
                """,
                (machine_id, current_position, int(block_id)),
            )
        )
        if next_block:
            next_position = float(next_block["queue_position"] or 0)
            new_queue_position = (current_position + next_position) / 2.0
        else:
            new_queue_position = current_position + 1.0
        con.execute(
            """
            UPDATE planner_run_block
            SET scheduled_qty = %s,
                calculated_start_datetime = NULL,
                calculated_end_datetime = NULL,
                updated_at = NOW()
            WHERE block_id = %s
            """,
            (split_qty, block_id),
        )
        planning_status, execution_status = normalize_block_status_inputs(
            {"planning_status": block["planning_status"], "execution_status": block["execution_status"], "status": block["status"]},
            default_planning=compact_text(block["planning_status"]) or "PLANNED",
            default_execution=compact_text(block["execution_status"] or block["status"]) or "NOT_STARTED",
        )
        new_cur = con.execute(
            """
            INSERT INTO planner_run_block (
              operation_id, machine_id, queue_position, scheduled_qty, include_setup, status, planning_status, execution_status,
              anchor_datetime, calculated_start_datetime, calculated_end_datetime, actual_good_qty, actual_reject_qty, remarks,
              split_from_block_id, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NULL, NULL, NULL, 0, 0, %s, %s, NOW())
            RETURNING block_id
            """,
            (
                int(block["operation_id"]),
                machine_id,
                float(new_queue_position),
                remaining,
                False,  # remainder does not re-charge setup
                execution_status,
                planning_status,
                execution_status,
                compact_text(block["remarks"]),
                int(block_id),
            ),
        )
        new_block_id = int(one(new_cur)["block_id"])
        from .operation_sequence import sync_operation_sequences_for_machines
        from .scheduler_state import refresh_machine_queue_state

        sync_operation_sequences_for_machines(con, [machine_id])
        refresh_block_actual_status(con, block_id, auto_unschedule=False)
        refresh_block_actual_status(con, new_block_id, auto_unschedule=False)
        refresh_machine_queue_state(con, block_id)
        refresh_machine_queue_state(con, new_block_id)
        # Defer schedule times — same as queue/reorder; user clicks Recalculate schedules.
        return jsonify({
            "ok": True,
            "recalculated": False,
            "block": trial_block_payload(trial_block_row(con, block_id), None),
            "new_block": trial_block_payload(trial_block_row(con, new_block_id), None),
            "machine_refresh": _trial_machine_refresh_payload(con, [machine_id], lite=True),
        })


@trial_bp.post("/api/trial/blocks/<int:block_id>/reorder")
def api_trial_reorder_blocks(block_id):
    data = request.get_json(force=True, silent=True) or {}
    ordered_ids = [int(v) for v in data.get("ordered_ids", []) if v is not None and compact_text(v) != ""]
    if not ordered_ids:
        return jsonify({"error": "ordered_ids are required"}), 400
    recalculate = _parse_recalculate_flag(data)
    with planner_db() as con:
        block = trial_block_row(con, block_id)
        if not block:
            return jsonify({"error": "Run block not found"}), 404
        guard = _mpp_planner_block_guard(con, block)
        if guard:
            return guard
        machine_id = int(data.get("machine_id") or block["machine_id"])
        result = apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=recalculate)
        affected_ids = list(result.get("affected_machine_ids") or [machine_id])
        return jsonify({
            "ok": True,
            "recalculated": recalculate,
            **result,
            "machine_refresh": _trial_machine_refresh_payload(con, affected_ids, lite=True),
        })


@trial_bp.post("/api/trial/queue/reorder-batch")
def api_trial_reorder_queue_batch():
    """Apply queue order for multiple lanes in one transaction + optional stacked recalc."""
    data = request.get_json(force=True, silent=True) or {}
    raw_lanes = data.get("lanes") or data.get("machine_orders") or []
    if not isinstance(raw_lanes, list) or not raw_lanes:
        return jsonify({"error": "lanes are required"}), 400
    recalculate = _parse_recalculate_flag(data)

    lane_orders = []
    for entry in raw_lanes:
        if not isinstance(entry, dict):
            continue
        machine_id = int(entry.get("machine_id") or 0)
        ordered_ids = [
            int(value)
            for value in (entry.get("ordered_ids") or [])
            if value is not None and compact_text(value) != ""
        ]
        if machine_id and ordered_ids:
            lane_orders.append({"machine_id": machine_id, "ordered_ids": ordered_ids})

    if not lane_orders:
        return jsonify({"error": "lanes must include machine_id and ordered_ids"}), 400

    with planner_db() as con:
        from .machines import is_mpp_planner_machine_id, is_mpp_planner_owned_block

        for entry in lane_orders:
            machine_id = int(entry["machine_id"])
            if is_mpp_planner_machine_id(con, machine_id):
                return jsonify({"error": MPP_PLANNER_GUARD_MSG}), 400
            for block_id in entry["ordered_ids"]:
                if is_mpp_planner_owned_block(con, int(block_id)):
                    return jsonify({"error": MPP_PLANNER_GUARD_MSG}), 400
        result = apply_machine_queue_orders(con, lane_orders, recalculate=recalculate)
        affected_ids = list(result.get("affected_machine_ids") or [])
        return jsonify({
            "ok": True,
            "recalculated": recalculate,
            **result,
            "machine_refresh": _trial_machine_refresh_payload(con, affected_ids, lite=True),
        })


def _parse_tail_by_machine(data):
    raw = (data or {}).get("tail_by_machine") or {}
    if not isinstance(raw, dict):
        return {}
    parsed = {}
    for key, value in raw.items():
        try:
            machine_id = int(key)
            block_id = int(value)
        except (TypeError, ValueError):
            continue
        if machine_id > 0 and block_id > 0:
            parsed[machine_id] = block_id
    return parsed


@trial_bp.post("/api/trial/queue/recalculate")
def api_trial_queue_recalculate():
    """Recalculate schedule times for machines after deferred queue reorder."""
    from .operation_sequence import infer_tail_by_machine

    data = request.get_json(force=True, silent=True) or {}
    machine_ids = sorted({
        int(value)
        for value in (data.get("machine_ids") or [])
        if value is not None and int(value or 0) > 0
    })
    if not machine_ids:
        return jsonify({"error": "machine_ids are required"}), 400
    with planner_db() as con:
        tail_by_machine = _parse_tail_by_machine(data)
        missing = [mid for mid in machine_ids if mid not in tail_by_machine]
        if missing:
            tail_by_machine.update(infer_tail_by_machine(con, missing))
        recalculate_machines(
            con,
            machine_ids,
            reason="PLANNER_CHANGE",
            tail_by_machine=tail_by_machine,
        )
        return jsonify({
            "ok": True,
            "machine_ids": machine_ids,
            "recalculated": True,
            "tail_by_machine": {str(k): v for k, v in tail_by_machine.items()},
            "machine_refresh": _trial_machine_refresh_payload(con, machine_ids, lite=True),
        })


@trial_bp.post("/api/trial/blocks/<int:block_id>/combine")
def api_trial_combine_blocks(block_id):
    return jsonify({"error": "Scheduled blocks cannot be combined. Combine operations inside the PS list before scheduling."}), 400


@trial_bp.post("/api/trial/machines/<int:machine_id>/dedupe-queue")
def api_trial_dedupe_machine_queue(machine_id):
    """Remove duplicate queue cards for the same PS/op on one machine (keeps earliest slot)."""
    machine_id = int(machine_id or 0)
    if machine_id <= 0:
        return jsonify({"error": "Machine is required"}), 400
    with planner_db() as con:
        result = dedupe_machine_catalog_queue(con, machine_id)
        removed = result.get("removed_block_ids") or []
        payload = {
            "ok": True,
            "removed": len(removed),
            "removed_block_ids": removed,
        }
        if removed:
            payload["machine_refresh"] = _trial_machine_refresh_payload(con, [machine_id], lite=True)
        return jsonify(payload)


@trial_bp.delete("/api/trial/blocks/<int:block_id>")
def api_trial_delete_block(block_id):
    with planner_db() as con:
        block = trial_block_row(con, block_id)
        if not block:
            return jsonify({"error": "Run block not found"}), 404
        guard = _mpp_planner_block_guard(con, block)
        if guard:
            return guard
        if is_dummy_block_row(block) and not int(block.get("group_id") or 0):
            machine_id = delete_dummy_card(con, block_id)
            return jsonify({
                "ok": True,
                "deleted": True,
                "permanent": True,
                "machine_refresh": _trial_machine_refresh_payload(con, [machine_id], lite=True),
            })

        from .operation_sequence import lane_tail_recalc_block_after_remove, resync_machine_lane_after_remove

        machine_id = int(block["machine_id"])
        operation_id = int(block["operation_id"])
        group_id = int(block.get("group_id") or 0)
        ps_id = compact_text(block.get("job_no") or block.get("source_ps_id") or "")
        base_ps_id = ps_id.split("::", 1)[0] if ps_id else ""

        affected_machine_ids = {machine_id}
        affected_operation_ids = {operation_id}
        removed_by_machine = {machine_id: [int(block_id)]}

        if group_id:
            group_blocks = rows(
                con.execute(
                    "SELECT block_id, operation_id, machine_id FROM planner_run_block WHERE group_id = %s",
                    (group_id,),
                )
            )
            removed_by_machine = {}
            for row in group_blocks:
                mid = int(row.get("machine_id") or 0)
                bid = int(row.get("block_id") or 0)
                if mid and bid:
                    removed_by_machine.setdefault(mid, []).append(bid)
            affected_machine_ids.update(removed_by_machine.keys())
            affected_operation_ids.update(int(row["operation_id"]) for row in group_blocks if int(row.get("operation_id") or 0))

        tail_by_machine = {}
        for mid, removed_ids in removed_by_machine.items():
            tail_id = lane_tail_recalc_block_after_remove(con, int(mid), removed_ids)
            if tail_id:
                tail_by_machine[int(mid)] = tail_id

        if group_id:
            if ps_id and base_ps_id and ps_id != base_ps_id:
                con.execute(
                    """
                    DELETE FROM planner_planning_card
                    WHERE scheduled_block_group_id = %s
                       OR (planning_status = 'SCHEDULED' AND planner_ps_id = ANY(%s))
                    """,
                    (group_id, [ps_id, base_ps_id]),
                )
            elif ps_id:
                con.execute(
                    """
                    DELETE FROM planner_planning_card
                    WHERE scheduled_block_group_id = %s
                       OR (planning_status = 'SCHEDULED' AND planner_ps_id = %s)
                    """,
                    (group_id, ps_id),
                )
            else:
                con.execute("DELETE FROM planner_planning_card WHERE scheduled_block_group_id = %s", (group_id,))
            con.execute("DELETE FROM planner_run_block WHERE group_id = %s", (group_id,))
            con.execute("DELETE FROM planner_run_block_group WHERE group_id = %s", (group_id,))
        else:
            merge_deleted_split_block_qty(con, block)
            con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (int(block_id),))

        for op_id in affected_operation_ids:
            remaining = one(con.execute(
                "SELECT COUNT(*) AS cnt FROM planner_run_block WHERE operation_id = %s",
                (int(op_id),),
            ))
            if int((remaining or {}).get("cnt") or 0) <= 0:
                con.execute("DELETE FROM planner_operation WHERE operation_id = %s", (int(op_id),))

        refresh_ids = sorted(int(mid) for mid in affected_machine_ids if int(mid or 0) > 0)
        for mid in refresh_ids:
            resync_machine_lane_after_remove(
                con,
                mid,
                tail_block_id=tail_by_machine.get(mid),
            )
        return jsonify({
            "ok": True,
            "machine_refresh": _trial_machine_refresh_payload(con, refresh_ids, lite=True),
        })


@trial_bp.route("/api/trial/segments/<int:segment_id>/actual", methods=["PATCH", "POST"])
def api_trial_segment_actual(segment_id):
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        segment = one(
            con.execute(
                """
                SELECT s.*, b.operation_id, b.machine_id AS block_machine_id
                FROM planner_run_block_segment s
                JOIN planner_run_block b ON b.block_id = s.block_id
                WHERE s.segment_id = %s
                """,
                (int(segment_id),),
            )
        )
        if not segment:
            return jsonify({"error": "Planned segment not found"}), 404

        block_id = int(segment["block_id"])
        machine_id = int(segment["machine_id"])
        report_date = compact_text(segment["segment_date"])
        existing = _active_actual_for_segment(con, segment_id)

        output_provided = "output_qty" in data
        reject_provided = "reject_qty" in data
        remarks_provided = "remarks" in data

        output_qty = parse_nullable_number(data.get("output_qty")) if output_provided else None
        reject_qty = parse_nullable_number(data.get("reject_qty")) if reject_provided else None
        remarks = compact_text(data.get("remarks")) if remarks_provided else None
        stored_target_qty = existing["target_qty_at_report"] if existing and existing["target_qty_at_report"] is not None else None
        target_qty = float(stored_target_qty if stored_target_qty is not None else segment["qty_done"] or 0)
        old_output_qty = existing["output_qty"] if existing else None
        old_reject_qty = existing["reject_qty"] if existing else None
        old_good_qty = 0.0 if old_output_qty is None or old_reject_qty is None else max(0.0, float(old_output_qty) - float(old_reject_qty))
        next_output_qty = output_qty if output_provided else (old_output_qty if existing else None)
        next_reject_qty = reject_qty if reject_provided else (old_reject_qty if existing else None)
        new_good_qty = 0.0 if next_output_qty is None or next_reject_qty is None else max(0.0, float(next_output_qty) - float(next_reject_qty))
        output_delta = new_good_qty - old_good_qty
        rework_source = find_rework_source_for_reject(con, block_id) if reject_provided and reject_qty and reject_qty > 0 else None
        output_adjustment = {"changed": False, "applied_qty": 0.0}
        if output_provided and output_delta != 0:
            output_adjustment = apply_output_delta_to_block_tail(con, block_id, report_date, output_delta)

        if existing:
            _void_actual(con, existing["actual_id"])
        _insert_actual(
            con,
            segment_id=int(segment_id),
            block_id=block_id,
            report_date=report_date,
            output_qty=next_output_qty,
            reject_qty=next_reject_qty,
            remarks=remarks if remarks_provided else (existing["remarks"] if existing else ""),
            target_qty=target_qty,
            machine_id=machine_id,
            entry_type="CORRECTION" if existing else "REPORT",
            correction_of_actual_id=int(existing["actual_id"]) if existing else None,
            created_by=compact_text(data.get("created_by")),
        )

        rework = {"created": False, "machine_id": 0}
        removed_rework_machine_ids = set()
        if reject_provided and reject_qty and reject_qty > 0:
            if rework_source:
                rework = create_rework_from_reject(con, int(rework_source["block_id"]), segment_id, reject_qty)
        elif reject_provided:
            removed_rework_machine_ids = delete_rework_from_reject_segment(con, segment_id)

        refresh_block_actual_status(con, block_id)
        affected_machine_ids = {machine_id}
        if rework.get("created") and int(rework.get("machine_id") or 0):
            affected_machine_ids.add(int(rework["machine_id"]))
        affected_machine_ids.update(int(mid) for mid in removed_rework_machine_ids if int(mid or 0))
        before_signatures = {mid: schedule_signature_for_machine(con, mid) for mid in affected_machine_ids}
        for affected_machine_id in affected_machine_ids:
            recalculate_machine(con, affected_machine_id)
        after_signatures = {mid: schedule_signature_for_machine(con, mid) for mid in affected_machine_ids}
        schedule_adjusted = (
            bool(output_adjustment["changed"])
            or bool(rework["created"])
            or bool(removed_rework_machine_ids)
            or any(before_signatures.get(mid) != after_signatures.get(mid) for mid in affected_machine_ids)
        )

        message_parts = []
        if output_provided:
            if output_qty is None:
                message_parts.append(f"Actual output cleared for {report_date}.")
            else:
                message_parts.append(f"Actual output {format_qty(output_qty)} saved for {report_date}.")
        if reject_provided:
            if reject_qty and reject_qty > 0:
                message_parts.append(f"Reject {format_qty(reject_qty)} saved for {report_date}.")
                if not rework["created"]:
                    message_parts.append("Remaining qty updated.")
            elif reject_qty is None:
                message_parts.append(f"Reject cleared for {report_date}.")
            else:
                message_parts.append(f"Reject 0 saved for {report_date}.")
        if remarks_provided and not output_provided and not reject_provided:
            message_parts.append(f"Remark saved for {report_date}.")
        if rework["created"]:
            message_parts.append("Rework block created.")
        if schedule_adjusted:
            message_parts.append("Schedule adjusted.")

        return jsonify(
            {
                "ok": True,
                "segment_id": int(segment_id),
                "block_id": block_id,
                "report_date": report_date,
                "schedule_adjusted": schedule_adjusted,
                "rework_created": bool(rework["created"]),
                "message": " ".join(message_parts).strip() or "Actual saved.",
                "block": trial_block_payload(trial_block_row(con, block_id), con),
            }
        )


@trial_bp.post("/api/trial/blocks/<int:block_id>/actual")
def api_trial_actual(block_id):
    data = request.get_json(force=True, silent=True) or {}
    record_only = compact_text(data.get("record_only")).lower() in {"1", "true", "yes"}
    with planner_db() as con:
        block = trial_block_row(con, block_id)
        if not block:
            return jsonify({"error": "Run block not found"}), 404
        delete_dates = [compact_text(v) for v in (data.get("delete_actual_dates") or []) if compact_text(v)]
        removed_target_dates = [
            compact_text(v) for v in (data.get("removed_target_dates") or []) if compact_text(v)
        ]
        daily_actuals = data.get("daily_actuals") or []
        if not delete_dates and not removed_target_dates and not daily_actuals:
            return jsonify({"error": "No actual rows submitted."}), 400
        saved_count = 0
        deleted_count = 0
        removed_target_count = 0
        removed_target_qty = 0.0
        skipped_count = 0
        adjusted_tail_qty = 0.0
        schedule_adjusted = False
        tail_changes = []
        removed_target_date_set = set(removed_target_dates)

        for report_date in delete_dates:
            existing_rows = rows(
                con.execute(
                    """
                    SELECT *
                    FROM planner_production_actual
                    WHERE block_id = %s
                      AND report_date = %s
                      AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                    """,
                    (int(block_id), report_date),
                )
            )
            for row in existing_rows:
                _void_actual(con, int(row["actual_id"]))
                deleted_count += 1
                if report_date in removed_target_date_set:
                    continue
                old_output = parse_nullable_number(row.get("output_qty")) if row.get("output_qty") is not None else None
                old_reject = parse_nullable_number(row.get("reject_qty")) if row.get("reject_qty") is not None else None
                old_good = _actual_good_qty(old_output, old_reject)
                if old_good is None:
                    old_good = 0.0
                old_target = parse_nullable_number(row.get("target_qty_at_report"))
                if old_target is None:
                    old_target = _planned_target_qty_for_block_date(con, block_id, report_date)
                old_variance = _actual_variance(old_good, old_target)
                variance_delta = 0.0 - float(old_variance)
                if not record_only and abs(variance_delta) > 1e-9:
                    tail_changes.append(
                        {
                            "report_date": report_date,
                            "change_type": "actual_delete",
                            "old_variance": float(old_variance),
                            "new_variance": 0.0,
                            "variance_delta": float(variance_delta),
                        }
                    )

        for report_date in removed_target_dates:
            existing_removed = one(
                con.execute(
                    """
                    SELECT *
                    FROM planner_block_removed_actual_date
                    WHERE block_id = %s
                      AND report_date = %s
                      AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                    ORDER BY removed_date_id DESC
                    LIMIT 1
                    """,
                    (int(block_id), report_date),
                )
            )
            existing_rows = rows(
                con.execute(
                    """
                    SELECT *
                    FROM planner_production_actual
                    WHERE block_id = %s
                      AND report_date = %s
                      AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                    ORDER BY actual_id DESC
                    """,
                    (int(block_id), report_date),
                )
            )
            for row in existing_rows:
                _void_actual(con, int(row["actual_id"]))
                deleted_count += 1
            if existing_removed:
                continue

            target_qty = _planned_target_qty_for_block_date(con, block_id, report_date)
            if target_qty <= 0:
                removed_result = apply_removed_target_date_to_block_tail(
                    con,
                    block_id,
                    report_date,
                    0,
                    shift_to_tail=False,
                )
                if not removed_result.get("changed"):
                    continue
                con.execute(
                    """
                    INSERT INTO planner_block_removed_actual_date (
                      block_id, report_date, target_qty_removed, status, created_at, updated_at
                    ) VALUES (%s, %s, 0, 'ACTIVE', NOW(), NOW())
                    ON CONFLICT (block_id, report_date) DO UPDATE SET
                      target_qty_removed = 0,
                      status = 'ACTIVE',
                      updated_at = NOW()
                    """,
                    (int(block_id), report_date),
                )
                removed_target_count += 1
                continue

            con.execute(
                """
                INSERT INTO planner_block_removed_actual_date (
                  block_id, report_date, target_qty_removed, status, created_at, updated_at
                ) VALUES (%s, %s, %s, 'ACTIVE', NOW(), NOW())
                ON CONFLICT (block_id, report_date) DO UPDATE SET
                  target_qty_removed = EXCLUDED.target_qty_removed,
                  status = 'ACTIVE',
                  updated_at = NOW()
                """,
                (int(block_id), report_date, float(target_qty)),
            )
            removed_result = apply_removed_target_date_to_block_tail(
                con,
                block_id,
                report_date,
                target_qty,
                shift_to_tail=not record_only,
            )
            removed_target_count += 1
            removed_target_qty += float(target_qty)
            if not record_only:
                schedule_adjusted = schedule_adjusted or bool(removed_result.get("changed"))
                tail_changes.append(
                    {
                        "report_date": report_date,
                        "change_type": "removed_target",
                        "removed_target_qty": float(target_qty),
                        "variance_delta": float(target_qty),
                    }
                )

        for row in daily_actuals:
            report_date = compact_text(row.get("report_date"))
            if not report_date:
                skipped_count += 1
                continue
            raw_output = row.get("output_qty") if "output_qty" in row else row.get("actual_good_qty")
            raw_reject = row.get("reject_qty") if "reject_qty" in row else row.get("actual_reject_qty")
            raw_remarks = compact_text(row.get("remarks"))
            raw_target = row.get("target_qty")
            output_provided = "output_qty" in row and compact_text(raw_output) != ""
            reject_provided = "reject_qty" in row and compact_text(raw_reject) != ""
            remarks_provided = raw_remarks != ""
            target_provided = "target_qty" in row and compact_text(raw_target) != ""
            if not output_provided and not reject_provided and not remarks_provided:
                skipped_count += 1
                continue
            output_value = parse_nullable_number(raw_output) if output_provided else None
            reject_value = parse_nullable_number(raw_reject) if reject_provided else None
            remarks_value = raw_remarks
            existing = _active_actual_for_block_date(con, block_id, report_date)
            old_output = parse_nullable_number(existing["output_qty"]) if existing and existing.get("output_qty") is not None else None
            old_reject = parse_nullable_number(existing["reject_qty"]) if existing and existing.get("reject_qty") is not None else None
            old_good = _actual_good_qty(old_output, old_reject)
            if target_provided:
                target_qty = parse_nullable_number(raw_target)
            else:
                existing_target = parse_nullable_number(existing["target_qty_at_report"]) if existing and existing.get("target_qty_at_report") is not None else None
                if existing_target is not None:
                    target_qty = existing_target
                else:
                    target_qty = _planned_target_qty_for_block_date(con, block_id, report_date)
            if target_qty is None:
                target_qty = 0.0
            old_target = parse_nullable_number(existing["target_qty_at_report"]) if existing and existing.get("target_qty_at_report") is not None else None
            if old_target is None:
                old_target = target_qty if existing else _planned_target_qty_for_block_date(con, block_id, report_date)
            old_variance = _actual_variance(old_good, old_target)
            if existing:
                _void_actual(con, existing["actual_id"])
            _insert_actual(
                con,
                segment_id=None,
                block_id=int(block_id),
                report_date=report_date,
                output_qty=output_value,
                reject_qty=reject_value,
                remarks=remarks_value,
                target_qty=float(target_qty),
                machine_id=int(block["machine_id"]),
                entry_type="CORRECTION" if existing else "REPORT",
                correction_of_actual_id=int(existing["actual_id"]) if existing else None,
                created_by=compact_text(row.get("created_by")),
            )
            saved_count += 1
            new_good = _actual_good_qty(output_value, reject_value)
            new_variance = _actual_variance(new_good, target_qty)
            variance_delta = float(new_variance) - float(old_variance)
            if not record_only and abs(variance_delta) > 1e-9:
                tail_changes.append(
                    {
                        "report_date": report_date,
                        "change_type": "actual_save",
                        "old_variance": float(old_variance),
                        "new_variance": float(new_variance),
                        "variance_delta": float(variance_delta),
                    }
                )
        refresh_block_actual_status(con, block_id)
        refresh_block_schedule_bounds(con, block_id)
        if not record_only:
            for change in tail_changes:
                if change.get("change_type") == "removed_target":
                    adjusted_tail_qty += abs(float(change["variance_delta"]))
                    continue
                tail_result = apply_actual_variance_delta_to_block_tail(
                    con,
                    block_id,
                    change["report_date"],
                    change["variance_delta"],
                )
                adjusted_tail_qty += abs(float(change["variance_delta"]))
                schedule_adjusted = schedule_adjusted or bool(tail_result.get("changed"))
            refresh_block_schedule_bounds(con, block_id)
            recalculate_machine(con, int(block["machine_id"]))
        updated_block = trial_block_row(con, block_id)
        block_payload = trial_block_payload(updated_block, con)
        actuals = rows(
            con.execute(
                """
                SELECT actual_id, segment_id, block_id, report_date::text AS report_date,
                       output_qty, reject_qty, target_qty_at_report,
                       remarks, reported_at
                FROM planner_production_actual
                WHERE block_id = %s
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                ORDER BY report_date, actual_id
                """,
                (int(block_id),),
            )
        )
        for actual in actuals:
            actual["report_date"] = compact_text(actual.get("report_date"))
            actual["reported_at"] = compact_text(actual.get("reported_at"))
        return jsonify({
            "ok": True,
            "saved_count": saved_count,
            "deleted_count": deleted_count,
            "removed_target_count": removed_target_count,
            "removed_target_qty": removed_target_qty,
            "skipped_count": skipped_count,
            "changed_count": saved_count + deleted_count + removed_target_count,
            "adjusted_tail_qty": adjusted_tail_qty,
            "schedule_adjusted": False if record_only else bool(schedule_adjusted or adjusted_tail_qty > 0),
            "record_only": record_only,
            "tail_adjustments": tail_changes,
            "block": block_payload,
            "actual_daily_rows": block_payload.get("actual_daily_rows") or [],
            "actuals": [dict(r) for r in actuals],
            "removed_actual_dates": removed_actual_dates_for_block_row(con, updated_block),
        })


@trial_bp.post("/api/trial/recalc")
def api_trial_recalc():
    with planner_db() as con:
        recalculate_all(con)
        return jsonify({"ok": True})
