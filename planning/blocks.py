"""planning/blocks.py — scheduling engine (PostgreSQL port of Vanessa's blocks.py).

Key changes vs SQLite original:
  run_block / run_block_segment / operation / machines / etc → planner_* prefix
  machines.machine_code       → planner_machines.machine_no AS machine_code
  process_sheet.ps_id         → planner_process_sheet.planner_ps_id
  operation_seq               → planner_operation_seq
  machine_queue_state         → planner_machine_queue_state
  schedule_alert              → planner_schedule_alert
  production_actual           → planner_production_actual
  rework_link                 → planner_rework_link
  active = 1                  → active = TRUE
  cur.lastrowid               → RETURNING + one(cur)["pk"]
  INSERT OR IGNORE            → INSERT ... ON CONFLICT DO NOTHING
  date_text()                 → imported from utils
  parse_dt_text()             → imported from helpers
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime, timedelta

from .actuals import actual_totals_for_block
from .planner_actuals import actual_summary_for_block_row
from .helpers import one, planner_try_savepoint, rows, parse_dt_text
from .utils import planner_today, planner_timestamptz_for_db
from .machines import capacity_minutes_for_machine_day, machine_work_intervals_for_day
from .scheduler_state import (
    compute_change_summary,
    create_schedule_run,
    find_superseded_run_id,
    refresh_machine_queue_state,
    refresh_operation_state,
    refresh_process_sheet_state,
    refresh_states_for_machine,
    resolve_schedule_alert,
    snapshot_queue_state,
    snapshot_queue_state_all,
    upsert_schedule_alert,
    write_change_summary,
)
from .process_sheets import format_planner_ps_id, parse_planner_ps_id
from .utils import (
    compact_text,
    date_text,
    format_qty,
    planner_wall_datetime_from_input,
    planner_wall_datetime_to_api,
    trial_catalog_op_key,
)


def _catalog_ps_base_partial(source_ps_id: str):
    base, partial = parse_planner_ps_id(compact_text(source_ps_id))
    return base, max(1, int(partial or 1))


def _row_planner_ps_identity(row: dict):
    """Best-effort (source_ps_id, pp_partial_no) from a lane/operation row."""
    planner_ps = compact_text(row.get("planner_ps_id"))
    if planner_ps:
        base, partial = parse_planner_ps_id(planner_ps)
        if base:
            return base, max(1, int(partial or 1))

    try:
        explicit_partial = int(row.get("pp_partial_no") or 0)
    except (TypeError, ValueError):
        explicit_partial = 0

    src = compact_text(row.get("source_ps_id"))
    job = compact_text(row.get("job_no"))
    src_base, src_partial = parse_planner_ps_id(src)
    job_base, job_partial = parse_planner_ps_id(job)
    base = job_base or src_base
    if not base:
        return "", 1

    # job_no is the canonical queue id written on INSERT — prefer its partial.
    if job_base:
        partial = job_partial
    else:
        partial = src_partial
    if job_base and src_base and job_base == src_base:
        partial = job_partial
    if explicit_partial > 0:
        partial = explicit_partial
    return base, max(1, int(partial or 1))


def planner_ps_id_from_block_row(row: dict) -> str:
    """Canonical planner_ps_id for a scheduled block/operation row."""
    base, partial = _row_planner_ps_identity(row)
    return format_planner_ps_id(base, partial)


def attach_block_ps_identity(con, blocks):
    """Attach planner_ps_id + pp_partial_no; fall back to planner_process_sheet when row ids are bare."""
    if not blocks:
        return

    op_ids = sorted({int(b["operation_id"]) for b in blocks if int(b.get("operation_id") or 0) > 0})
    sheet_by_op: dict[int, dict] = {}
    if op_ids:
        for row in rows(
            con.execute(
                """
                SELECT o.operation_id, o.job_no, o.source_ps_id,
                       COALESCE(ps_job.planner_ps_id, ps_src.planner_ps_id) AS sheet_planner_ps_id,
                       COALESCE(ps_job.pp_partial_no, ps_src.pp_partial_no) AS sheet_partial_no
                FROM planner_operation o
                LEFT JOIN planner_process_sheet ps_job ON ps_job.planner_ps_id = o.job_no
                LEFT JOIN planner_process_sheet ps_src ON ps_src.planner_ps_id = o.source_ps_id
                WHERE o.operation_id = ANY(%s)
                """,
                (op_ids,),
            )
        ):
            sheet_by_op[int(row["operation_id"])] = dict(row)

    for block in blocks:
        oid = int(block.get("operation_id") or 0)
        sheet = sheet_by_op.get(oid) if oid else None
        sheet_ps = compact_text((sheet or {}).get("sheet_planner_ps_id"))
        if sheet_ps:
            base, partial = parse_planner_ps_id(sheet_ps)
            if base:
                block["planner_ps_id"] = format_planner_ps_id(base, partial)
                block["pp_partial_no"] = int(sheet.get("sheet_partial_no") or partial or 1)
                continue
        base, partial = _row_planner_ps_identity(block)
        if base:
            block["planner_ps_id"] = format_planner_ps_id(base, partial)
            block["pp_partial_no"] = int(partial or 1)


def _catalog_op_tokens(op_no: str) -> set[str]:
    text = compact_text(op_no).upper()
    tokens: set[str] = set()
    if not text:
        return tokens
    tokens.add(text)
    digits = text[2:] if text.startswith("OP") else text
    if digits.isdigit():
        n = str(int(digits))
        tokens.add(n)
        tokens.add(f"OP{n}")
    return tokens


def _catalog_op_matches_row(source_op_no: str, source_op_seq_id: int, row: dict) -> bool:
    want_tokens = _catalog_op_tokens(source_op_no)
    row_tokens = _catalog_op_tokens(row.get("source_op_no"))
    if want_tokens and row_tokens and want_tokens & row_tokens:
        return True
    op_seq = int(source_op_seq_id or 0)
    row_seq = int(row.get("source_op_seq_id") or 0)
    if op_seq > 0 and row_seq > 0 and op_seq == row_seq:
        return True
    return not compact_text(source_op_no) and op_seq <= 0


def find_active_catalog_lane_block(
    con,
    machine_id,
    source_ps_id,
    source_op_no="",
    source_op_seq_id=0,
):
    """Return an existing active lane block for the same PS/op (prevents double-queue)."""
    machine_id = int(machine_id or 0)
    ps = compact_text(source_ps_id)
    if not machine_id or not ps:
        return None
    want_base, want_partial = _catalog_ps_base_partial(ps)
    candidates = rows(
        con.execute(
            """
            SELECT b.block_id, o.source_ps_id, o.job_no, o.source_op_no, o.source_op_seq_id
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
            ORDER BY b.queue_position, b.block_id
            """,
            (machine_id,),
        )
    )
    for row in candidates:
        row_base, row_partial = _row_planner_ps_identity(row)
        if not row_base:
            continue
        if row_base != want_base:
            continue
        if row_partial != want_partial:
            continue
        if not _catalog_op_matches_row(source_op_no, source_op_seq_id, row):
            continue
        return int(row["block_id"])
    return None


def merge_deleted_split_block_qty(con, block):
    """Return qty merged into a sibling block when removing a queue split (else 0)."""
    if not con or not block:
        return 0.0
    block_id = int(block.get("block_id") or 0)
    operation_id = int(block.get("operation_id") or 0)
    removed_qty = max(0.0, float(block.get("scheduled_qty") or 0))
    if not block_id or not operation_id or removed_qty <= 0:
        return 0.0

    siblings = rows(
        con.execute(
            """
            SELECT block_id, scheduled_qty, split_from_block_id
            FROM planner_run_block
            WHERE operation_id = %s
              AND block_id <> %s
              AND COALESCE(active, TRUE) = TRUE
            ORDER BY block_id
            """,
            (operation_id, block_id),
        )
    )
    if not siblings:
        return 0.0

    split_parent_id = int(block.get("split_from_block_id") or 0)
    target = None
    if split_parent_id:
        target = next((row for row in siblings if int(row["block_id"]) == split_parent_id), None)
    if not target:
        target = siblings[0]

    target_id = int(target["block_id"])
    next_qty = max(0.0, float(target["scheduled_qty"] or 0)) + removed_qty
    con.execute(
        "UPDATE planner_run_block SET scheduled_qty = %s, updated_at = NOW() WHERE block_id = %s",
        (next_qty, target_id),
    )
    op_row = one(
        con.execute(
            "SELECT total_qty FROM planner_operation WHERE operation_id = %s",
            (operation_id,),
        )
    )
    if op_row:
        op_total = max(float(op_row.get("total_qty") or 0), next_qty)
        con.execute(
            "UPDATE planner_operation SET total_qty = %s, updated_at = NOW() WHERE operation_id = %s",
            (op_total, operation_id),
        )
    return removed_qty


def sync_catalog_op_timing_fields(
    con,
    anchor_operation_id,
    setup_minutes=None,
    cycle_minutes_per_qty=None,
):
    """Apply setup/cycle changes to every active run block for the same catalog op."""
    if setup_minutes is None and cycle_minutes_per_qty is None:
        return 0
    anchor = one(
        con.execute(
            """
            SELECT operation_id, source_ps_id, job_no, source_op_no, source_op_seq_id
            FROM planner_operation
            WHERE operation_id = %s
            """,
            (int(anchor_operation_id),),
        )
    )
    if not anchor:
        return 0
    anchor_ps = compact_text(anchor.get("source_ps_id") or anchor.get("job_no"))
    if not anchor_ps:
        return 0
    anchor_key = trial_catalog_op_key(
        anchor_ps,
        anchor.get("source_op_no"),
        anchor.get("source_op_seq_id"),
    )
    want_base, want_partial = _catalog_ps_base_partial(anchor_ps)
    fields = []
    params = []
    if setup_minutes is not None:
        fields.append("setup_minutes = %s")
        params.append(float(setup_minutes))
    if cycle_minutes_per_qty is not None:
        fields.append("cycle_minutes_per_qty = %s")
        params.append(float(cycle_minutes_per_qty))
    if not fields:
        return 0

    siblings = rows(
        con.execute(
            """
            SELECT DISTINCT o.operation_id, o.source_ps_id, o.job_no,
                   o.source_op_no, o.source_op_seq_id
            FROM planner_operation o
            JOIN planner_run_block b ON b.operation_id = o.operation_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
            """
        )
    )
    updated = 0
    set_clause = ", ".join(fields)
    for row in siblings:
        raw_ps = compact_text(row.get("source_ps_id") or row.get("job_no"))
        if not raw_ps:
            continue
        row_base, row_partial = _catalog_ps_base_partial(raw_ps)
        if row_base != want_base:
            continue
        if "::" in anchor_ps and "::" in raw_ps and row_partial != want_partial:
            continue
        if not _catalog_op_matches_row(
            anchor.get("source_op_no"),
            int(anchor.get("source_op_seq_id") or 0),
            row,
        ):
            continue
        row_key = trial_catalog_op_key(
            raw_ps,
            row.get("source_op_no"),
            row.get("source_op_seq_id"),
        )
        if row_key != anchor_key:
            continue
        op_id = int(row["operation_id"])
        con.execute(
            f"UPDATE planner_operation SET {set_clause}, updated_at = NOW() WHERE operation_id = %s",
            (*params, op_id),
        )
        card_set = []
        card_params = []
        if setup_minutes is not None:
            card_set.append("setup_minutes = %s")
            card_params.append(float(setup_minutes))
        if cycle_minutes_per_qty is not None:
            card_set.append("cycle_minutes_per_qty = %s")
            card_params.append(float(cycle_minutes_per_qty))
        if card_set:
            con.execute(
                f"""
                UPDATE planner_planning_card_operation pco
                SET {", ".join(card_set)}
                FROM planner_planning_card pc
                WHERE pc.card_id = pco.card_id
                  AND COALESCE(pco.source_ps_id, '') = %s
                  AND COALESCE(pco.source_op_no, '') = COALESCE(%s, '')
                  AND COALESCE(pco.source_op_seq_id, 0) = COALESCE(%s, 0)
                """,
                (
                    *card_params,
                    raw_ps,
                    compact_text(row.get("source_op_no")),
                    int(row.get("source_op_seq_id") or 0),
                ),
            )
        updated += 1
    return updated


def dedupe_machine_catalog_queue(con, machine_id):
    """Remove duplicate active queue rows for the same PS/op on one machine (keeps earliest)."""
    machine_id = int(machine_id or 0)
    if machine_id <= 0:
        return {"removed_block_ids": []}
    block_rows = rows(
        con.execute(
            """
            SELECT b.block_id, b.operation_id, b.queue_position,
                   o.source_ps_id, o.job_no, o.source_op_no, o.source_op_seq_id
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
            ORDER BY b.queue_position, b.block_id
            """,
            (machine_id,),
        )
    )
    buckets = {}
    for row in block_rows:
        raw_ps = compact_text(row.get("source_ps_id") or row.get("job_no"))
        base, partial = _catalog_ps_base_partial(raw_ps)
        key = (base, partial, compact_text(row.get("source_op_no")), int(row.get("source_op_seq_id") or 0))
        buckets.setdefault(key, []).append(row)

    removed = []
    for items in buckets.values():
        if len(items) < 2:
            continue
        for dup in items[1:]:
            dup_id = int(dup["block_id"])
            op_id = int(dup["operation_id"])
            con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (dup_id,))
            remaining = one(
                con.execute(
                    "SELECT COUNT(*) AS cnt FROM planner_run_block WHERE operation_id = %s",
                    (op_id,),
                )
            )
            if int((remaining or {}).get("cnt") or 0) <= 0:
                con.execute("DELETE FROM planner_operation WHERE operation_id = %s", (op_id,))
            removed.append(dup_id)

    if removed:
        from .operation_sequence import compact_machine_lane_queue

        compact_machine_lane_queue(con, machine_id, recalculate=False)
        recalculate_machine(con, machine_id)
    return {"removed_block_ids": removed}


def trial_block_row(con, block_id):
    return one(
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
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )


def _merge_actual_daily_rows(removed_dates, planned_rows, actual_rows):
    """Build daily actual rows from pre-fetched planned/actual/removed data."""
    row_map = {}
    for row in planned_rows:
        report_date = compact_text(row.get("segment_date") or "")
        if not report_date or report_date in removed_dates:
            continue
        row_map[report_date] = {
            "report_date": report_date,
            "original_report_date": "",
            "target_qty": float(row.get("target_qty") or 0),
            "output_qty": "",
            "reject_qty": "",
            "remarks": "",
            "is_planned_row": True,
            "is_existing_actual": False,
            "actual_id": None,
            "locked_date": True,
            "start_datetime": planner_wall_datetime_to_api(row.get("start_datetime") or ""),
            "end_datetime": planner_wall_datetime_to_api(row.get("end_datetime") or ""),
        }

    for row in actual_rows:
        report_date = compact_text(row.get("report_date") or "")
        if not report_date or report_date in removed_dates:
            continue
        output_value = row.get("output_qty")
        reject_value = row.get("reject_qty")
        actual_payload = {
            "report_date": report_date,
            "original_report_date": report_date,
            "target_qty": float(row.get("target_qty_at_report") or row_map.get(report_date, {}).get("target_qty") or 0),
            "output_qty": "" if output_value is None else str(output_value),
            "reject_qty": "" if reject_value is None else str(reject_value),
            "remarks": compact_text(row.get("remarks") or ""),
            "is_planned_row": report_date in row_map,
            "is_existing_actual": True,
            "actual_id": int(row.get("actual_id") or 0),
            "locked_date": True,
        }
        if report_date in row_map:
            row_map[report_date].update(actual_payload)
        else:
            row_map[report_date] = actual_payload
            row_map[report_date]["locked_date"] = True

    return sorted(
        row_map.values(),
        key=lambda item: (compact_text(item.get("report_date") or ""), int(item.get("actual_id") or 0)),
    )


def actual_daily_rows_maps_for_block_ids(con, block_ids):
    """Batch-fetch daily actual rows for many blocks (no ERP enrichment)."""
    ids = sorted({int(block_id) for block_id in (block_ids or []) if int(block_id) > 0})
    if not con or not ids:
        return {}

    removed_by_block = defaultdict(set)
    for row in rows(
        con.execute(
            """
            SELECT block_id, report_date::text AS report_date
            FROM planner_block_removed_actual_date
            WHERE block_id = ANY(%s)
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            ORDER BY block_id, report_date
            """,
            (ids,),
        )
    ):
        block_id = int(row.get("block_id") or 0)
        report_date = compact_text(row.get("report_date") or "")
        if block_id and report_date:
            removed_by_block[block_id].add(report_date)

    planned_by_block = defaultdict(list)
    for row in rows(
        con.execute(
            """
            SELECT block_id,
                   segment_date::text AS segment_date,
                   COALESCE(SUM(COALESCE(qty_done, planned_qty, 0)), 0) AS target_qty,
                   MIN(start_datetime) AS start_datetime,
                   MAX(end_datetime) AS end_datetime
            FROM planner_run_block_segment
            WHERE block_id = ANY(%s)
              AND COALESCE(segment_type, '') = 'production'
              AND segment_date IS NOT NULL
            GROUP BY block_id, segment_date
            ORDER BY block_id, segment_date
            """,
            (ids,),
        )
    ):
        planned_by_block[int(row.get("block_id") or 0)].append(row)

    actual_by_block = defaultdict(list)
    for row in rows(
        con.execute(
            """
            SELECT block_id, actual_id, report_date::text AS report_date,
                   output_qty, reject_qty, remarks, target_qty_at_report
            FROM planner_production_actual
            WHERE block_id = ANY(%s)
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            ORDER BY block_id, report_date, actual_id
            """,
            (ids,),
        )
    ):
        actual_by_block[int(row.get("block_id") or 0)].append(row)

    return {
        block_id: _merge_actual_daily_rows(
            removed_by_block.get(block_id, set()),
            planned_by_block.get(block_id, []),
            actual_by_block.get(block_id, []),
        )
        for block_id in ids
    }


def actual_daily_rows_for_block_row(con, block_row):
    if not con or not block_row:
        return []

    block_id = int(block_row["block_id"])
    return actual_daily_rows_maps_for_block_ids(con, [block_id]).get(block_id, [])


def actual_daily_rows_for_block_row_with_erp(con, block_row):
    daily_rows = actual_daily_rows_for_block_row(con, block_row)
    try:
        con.execute("SAVEPOINT erp_actual_enrich")
        from .erp_actuals import enrich_actual_daily_rows_with_erp

        enriched, recon = enrich_actual_daily_rows_with_erp(con, block_row, daily_rows)
        con.execute("RELEASE SAVEPOINT erp_actual_enrich")
        return enriched, recon
    except Exception:
        try:
            con.execute("ROLLBACK TO SAVEPOINT erp_actual_enrich")
        except Exception:
            pass
        return daily_rows, None


def attach_actual_daily_to_blocks(con, block_rows, *, with_erp=False):
    """Attach actual_daily_rows (and optional erp_reconciliation) to block dicts in place."""
    if not con or not block_rows:
        return

    block_ids = [int(row.get("block_id") or 0) for row in block_rows if int(row.get("block_id") or 0)]
    daily_maps = actual_daily_rows_maps_for_block_ids(con, block_ids)

    enrich_fn = None
    effective_totals_fn = None
    shop_totals_by_block = {}
    if with_erp:
        try:
            from .actuals import actual_totals_for_block_ids
            from .erp_actuals import (
                effective_actual_totals_for_block,
                enrich_actual_daily_rows_with_erp,
                ensure_erp_snapshot_table,
            )

            ensure_erp_snapshot_table(con)
            shop_totals_by_block = actual_totals_for_block_ids(con, block_ids)
            enrich_fn = enrich_actual_daily_rows_with_erp
            effective_totals_fn = effective_actual_totals_for_block
        except Exception:
            enrich_fn = None
            effective_totals_fn = None
            shop_totals_by_block = {}

    for block_row in block_rows:
        block_id = int(block_row.get("block_id") or 0)
        if not block_id:
            continue
        daily_rows = daily_maps.get(block_id, [])
        block_row["erp_reconciliation"] = None
        if enrich_fn:
            anchor_dates = [
                compact_text(row.get("report_date"))
                for row in daily_rows
                if compact_text(row.get("report_date"))
            ]
            shop_totals = shop_totals_by_block.get(block_id)

            def _enrich(
                rows=daily_rows,
                row=block_row,
                bid=block_id,
                dates=anchor_dates,
                totals=shop_totals,
            ):
                enriched, erp_recon = enrich_fn(
                    con,
                    row,
                    rows,
                    anchor_dates=dates,
                    shop_totals=totals,
                )
                if erp_recon and effective_totals_fn:
                    row["effective_actuals"] = effective_totals_fn(con, row, erp_recon)
                return enriched, erp_recon

            enriched = planner_try_savepoint(
                con,
                f"erp_daily_{block_id}",
                _enrich,
                default=(daily_rows, None),
            )
            if enriched:
                daily_rows, erp_recon = enriched
                block_row["erp_reconciliation"] = erp_recon
        block_row["actual_daily_rows"] = daily_rows


def removed_actual_dates_for_block_row(con, block_row):
    if not con or not block_row:
        return []
    block_id = int(block_row["block_id"])
    return [
        compact_text(row["report_date"] or "")
        for row in rows(
            con.execute(
                """
                SELECT report_date::text AS report_date
                FROM planner_block_removed_actual_date
                WHERE block_id = %s
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                ORDER BY report_date
                """,
                (block_id,),
            )
        )
        if compact_text(row["report_date"] or "")
    ]


def _actual_good_qty(output_qty, reject_qty):
    if output_qty is None and reject_qty is None:
        return None
    return max(0.0, float(output_qty or 0) - float(reject_qty or 0))


def _actual_variance(good_qty, target_qty):
    if good_qty is None:
        return 0.0
    return float(good_qty or 0) - float(target_qty or 0)


def apply_actual_variance_delta_to_block_tail(con, block_id, actual_date_text, variance_delta):
    variance_delta = float(variance_delta or 0)
    if abs(variance_delta) < 1e-9:
        return {"changed": False, "applied_qty": 0.0, "variance_delta": 0.0}

    block = trial_block_row(con, block_id)
    if not block:
        return {"changed": False, "applied_qty": 0.0, "variance_delta": variance_delta}

    actual_date = parse_dt_text(actual_date_text).date() if actual_date_text else date.today()
    if variance_delta > 0:
        result = apply_output_delta_to_block_tail(con, block_id, actual_date_text, variance_delta)
        refresh_block_schedule_bounds(con, block_id)
        return {
            "changed": bool(result.get("changed")),
            "applied_qty": abs(variance_delta),
            "variance_delta": variance_delta,
            "direction": "shave",
        }

    changed = add_shortfall_to_tail_with_capacity(con, block_id, actual_date, abs(variance_delta))
    refresh_block_schedule_bounds(con, block_id)
    return {
        "changed": bool(changed),
        "applied_qty": abs(variance_delta),
        "variance_delta": variance_delta,
        "direction": "add",
    }


def apply_removed_target_date_to_block_tail(con, block_id, report_date_text, target_qty_removed=None, shift_to_tail=True):
    block = trial_block_row(con, block_id)
    if not block:
        return {"changed": False, "removed_qty": 0.0}

    report_date = compact_text(report_date_text)
    if not report_date:
        return {"changed": False, "removed_qty": 0.0}

    removed_qty = float(target_qty_removed or 0)
    if removed_qty <= 0:
        removed_qty = float(
            one(
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
            )["target_qty"]
            or 0
        )

    if removed_qty <= 0:
        deleted = con.execute(
            """
            DELETE FROM planner_run_block_segment
            WHERE block_id = %s
              AND COALESCE(segment_type, '') = 'production'
              AND segment_date = %s::date
            """,
            (int(block_id), report_date),
        )
        changed = bool(getattr(deleted, "rowcount", 0))
        return {"changed": changed, "removed_qty": 0.0}

    con.execute(
        """
        DELETE FROM planner_run_block_segment
        WHERE block_id = %s
          AND COALESCE(segment_type, '') = 'production'
          AND segment_date = %s::date
        """,
        (int(block_id), report_date),
    )

    if not shift_to_tail:
        return {"changed": True, "removed_qty": float(removed_qty)}

    report_dt = parse_dt_text(report_date) if report_date else None
    changed = add_shortfall_to_tail_with_capacity(
        con,
        block_id,
        report_dt.date() if report_dt else date.today(),
        removed_qty,
    )
    return {"changed": bool(changed), "removed_qty": float(removed_qty)}


def _queue_state_for_block(con, block_id):
    if not con:
        return None
    return one(
        con.execute(
            "SELECT * FROM planner_machine_queue_state WHERE block_id = %s",
            (int(block_id),),
        )
    )


def trial_block_payload(block, con=None):
    if not block:
        return None
    ps_base, pp_partial_no = _row_planner_ps_identity(block)
    canonical_ps_id = format_planner_ps_id(ps_base, pp_partial_no) if ps_base else ""
    planning_status = block.get("planning_status", "UNPLANNED") or "UNPLANNED"
    execution_status = block.get("execution_status", block.get("status", "NOT_STARTED")) or "NOT_STARTED"
    queue_state = _queue_state_for_block(con, block["block_id"]) if con else None
    predicted_start_at = (queue_state["predicted_start_at"] if queue_state and queue_state["predicted_start_at"] else block.get("calculated_start_datetime") or block.get("planned_start_at") or "")
    predicted_end_at = (queue_state["predicted_end_at"] if queue_state and queue_state["predicted_end_at"] else block.get("calculated_end_datetime") or block.get("planned_end_at") or "")
    remaining_qty = float(queue_state["remaining_qty"] if queue_state and queue_state["remaining_qty"] is not None else max(0.0, float(block["scheduled_qty"] or 0) - max(0.0, float(block["actual_good_qty"] or 0))))
    good_qty = float(queue_state["good_qty"] if queue_state and queue_state["good_qty"] is not None else float(block["actual_good_qty"] or 0))
    reject_qty = float(queue_state["reject_qty"] if queue_state and queue_state["reject_qty"] is not None else float(block["actual_reject_qty"] or 0))
    schedule_status = queue_state["schedule_status"] if queue_state and queue_state["schedule_status"] else planning_status

    # Normalise datetime fields to strings for JSON serialisation (Singapore wall clock)
    def _dt_str(v):
        return planner_wall_datetime_to_api(v)

    payload = {
        "block_id": int(block["block_id"]),
        "operation_id": int(block["operation_id"]),
        "machine_id": int(block["machine_id"]),
        "queue_position": float(block["queue_position"] or 0),
        "operation_sequence_id": int(block.get("operation_sequence_id") or 0),
        "sequence_no": int(block.get("sequence_no") or block.get("queue_position") or 0),
        "scheduled_qty": float(block["scheduled_qty"] or 0),
        "include_setup": int(block["include_setup"] or 0),
        "status": execution_status,
        "planning_status": planning_status,
        "execution_status": execution_status,
        "anchor_datetime": planner_wall_datetime_to_api(block["anchor_datetime"]),
        "planned_start_at": _dt_str(block.get("planned_start_at")),
        "planned_end_at": _dt_str(block.get("planned_end_at")),
        "allow_pull_forward": int(block.get("allow_pull_forward") if block.get("allow_pull_forward") is not None else 1),
        "active": int(block.get("active") if block.get("active") is not None else 1),
        "is_fresh_monday_item": int(block.get("is_fresh_monday_item") or 0),
        "last_schedule_run_id": int(block.get("last_schedule_run_id") or 0),
        "planned_qty_original": float(block.get("planned_qty_original") or 0),
        "split_from_block_id": int(block.get("split_from_block_id") or 0),
        "scheduler_note": block.get("scheduler_note") or "",
        "calculated_start_datetime": _dt_str(block["calculated_start_datetime"]),
        "calculated_end_datetime": _dt_str(block["calculated_end_datetime"]),
        "predicted_start_at": _dt_str(predicted_start_at),
        "predicted_end_at": _dt_str(predicted_end_at),
        "actual_good_qty": good_qty,
        "actual_reject_qty": reject_qty,
        "good_qty": good_qty,
        "reject_qty": reject_qty,
        "remaining_qty": remaining_qty,
        "schedule_status": schedule_status,
        "remarks": block["remarks"] or "",
        "job_no": block["job_no"] or canonical_ps_id or "",
        "operation_name": block["operation_name"] or "",
        "total_qty": float(block["total_qty"] or 0),
        "setup_minutes": float(block["setup_minutes"] or 0),
        "cycle_minutes_per_qty": float(block["cycle_minutes_per_qty"] or 0),
        "compatible_machine_group": block["compatible_machine_group"] or "",
        "source_ps_id": canonical_ps_id or block["source_ps_id"] or "",
        "pp_partial_no": pp_partial_no,
        "source_op_seq_id": int(block["source_op_seq_id"] or 0),
        "source_op_no": block["source_op_no"] or "",
        "visual_start_datetime": _dt_str(block["calculated_start_datetime"]),
        "visual_end_datetime": _dt_str(block["calculated_end_datetime"]),
        "machine_code": block["machine_code"] or "",
        "machine_category": block["machine_category"] or "",
        "shift_profile": block["shift_profile"] or "",
        "block_type": block.get("block_type", "ORIGINAL") or "ORIGINAL",
        "source_reject_block_id": int(block.get("source_reject_block_id") or 0),
        "source_reject_segment_id": int(block.get("source_reject_segment_id") or 0),
        "group_id": int(block.get("group_id") or 0),
        "group_label": block.get("group_label") or "",
        "group_type": block.get("group_type") or "",
        "actual_daily_rows": [],
        "erp_reconciliation": None,
        "removed_actual_dates": removed_actual_dates_for_block_row(con, block) if con else [],
        "actual_start_at": "",
        "actual_end_at": "",
        "actual_row_count": 0,
    }
    if con:
        daily_rows, erp_recon = actual_daily_rows_for_block_row_with_erp(con, block)
        payload["actual_daily_rows"] = daily_rows
        payload["erp_reconciliation"] = erp_recon
        if erp_recon:
            from .erp_actuals import effective_actual_totals_for_block

            payload["effective_actuals"] = effective_actual_totals_for_block(con, block, erp_recon)
        summary = actual_summary_for_block_row(con, block, float(block["scheduled_qty"] or 0))
        payload["actual_start_at"] = compact_text(summary.get("actual_start_at") or "")
        payload["actual_end_at"] = compact_text(summary.get("actual_end_at") or "")
        payload["actual_row_count"] = int(summary.get("actual_row_count") or 0)
    return payload


def schedule_signature_for_machine(con, machine_id):
    return [
        (
            int(row["block_id"]),
            str(row["calculated_start_datetime"] or ""),
            str(row["calculated_end_datetime"] or ""),
        )
        for row in rows(
            con.execute(
                """
                SELECT block_id, calculated_start_datetime, calculated_end_datetime
                FROM planner_run_block
                WHERE machine_id = %s
                  AND COALESCE(active, TRUE) = TRUE
                ORDER BY queue_position, block_id
                """,
                (int(machine_id),),
            )
        )
    ]


def next_capacity_date_for_machine(con, machine_id, after_date: date):
    probe = after_date + timedelta(days=1)
    for _ in range(370):
        cap = capacity_minutes_for_machine_day(con, machine_id, probe)
        if int(cap["capacity_minutes"] or 0) > 0:
            return probe, cap
        probe += timedelta(days=1)
    cap = capacity_minutes_for_machine_day(con, machine_id, probe)
    return probe, cap


def dependency_finish_for_block(con, block):
    source_ps_id = compact_text(block.get("source_ps_id") or "")
    source_op_seq_id = int(block.get("source_op_seq_id") or 0)
    if not source_ps_id or not source_op_seq_id:
        return None
    has_operation_seq = one(
        con.execute("SELECT to_regclass('public.planner_operation_seq') AS table_name")
    )
    if not (has_operation_seq and has_operation_seq.get("table_name")):
        prev_row = one(
            con.execute(
                """
                SELECT MAX(COALESCE(b.calculated_end_datetime, q.predicted_end_at, b.planned_end_at, b.anchor_datetime)) AS dependency_finish
                FROM planner_run_block b
                JOIN planner_operation o ON o.operation_id = b.operation_id
                LEFT JOIN planner_machine_queue_state q ON q.block_id = b.block_id
                WHERE COALESCE(o.source_ps_id, '') = %s
                  AND COALESCE(b.active, TRUE) = TRUE
                  AND COALESCE(o.source_op_seq_id, 0) < %s
                """,
                (source_ps_id, source_op_seq_id),
            )
        )
        finish_val = prev_row["dependency_finish"] if prev_row else None
        if not finish_val:
            return None
        return parse_dt_text(finish_val)
    current_step = one(
        con.execute(
            "SELECT seq_no FROM planner_operation_seq WHERE op_seq_id = %s",
            (source_op_seq_id,),
        )
    )
    if not current_step:
        return None
    prev_row = one(
        con.execute(
            """
            SELECT MAX(COALESCE(b.calculated_end_datetime, q.predicted_end_at, b.planned_end_at, b.anchor_datetime)) AS dependency_finish
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_operation_seq s ON s.op_seq_id = o.source_op_seq_id
            LEFT JOIN planner_machine_queue_state q ON q.block_id = b.block_id
            WHERE COALESCE(o.source_ps_id, '') = %s
              AND COALESCE(b.active, TRUE) = TRUE
              AND s.seq_no < %s
            """,
            (source_ps_id, int(current_step["seq_no"] or 0)),
        )
    )
    finish_val = prev_row["dependency_finish"] if prev_row else None
    if not finish_val:
        return None
    return parse_dt_text(finish_val)


def add_future_segments_after_date(con, block_id, after_date: date, qty_to_add, schedule_run_id=None):
    block = trial_block_row(con, block_id)
    if not block:
        return False

    machine_id = int(block["machine_id"])
    cycle_time = max(0.0, float(block["cycle_minutes_per_qty"] or 0))
    if cycle_time <= 0:
        return False

    remaining_qty = float(qty_to_add or 0)
    if remaining_qty <= 0:
        return False

    work_date = after_date + timedelta(days=1)
    changed = False
    safety = 0

    while remaining_qty > 0 and safety < 370:
        safety += 1
        intervals = machine_work_intervals_for_day(con, machine_id, work_date)
        if not intervals:
            work_date += timedelta(days=1)
            continue
        for interval_start, interval_end in intervals:
            if remaining_qty <= 0:
                break
            available_minutes = max(0.0, (interval_end - interval_start).total_seconds() / 60.0)
            max_qty_today = math.floor(available_minutes / cycle_time)
            if max_qty_today <= 0:
                continue
            qty_today = min(remaining_qty, max_qty_today)
            minutes_used = qty_today * cycle_time
            end_dt = interval_start + timedelta(minutes=minutes_used)
            con.execute(
                """
                INSERT INTO planner_run_block_segment (
                  block_id, machine_id, schedule_run_id, segment_date, segment_type,
                  qty_done, planned_qty, minutes_used, planned_minutes, segment_status, start_datetime, end_datetime, is_actual
                ) VALUES (%s, %s, %s, %s, 'production', %s, %s, %s, %s, 'PLANNED', %s, %s, FALSE)
                """,
                (
                    int(block_id),
                    machine_id,
                    int(schedule_run_id) if schedule_run_id is not None else None,
                    date_text(work_date),
                    qty_today,
                    qty_today,
                    minutes_used,
                    minutes_used,
                    interval_start,
                    end_dt,
                ),
            )
            remaining_qty -= qty_today
            changed = True
        work_date += timedelta(days=1)

    return changed


def add_shortfall_to_tail_with_capacity(con, block_id, actual_date, qty_to_add):
    block = trial_block_row(con, block_id)
    if not block:
        return False

    machine_id = int(block["machine_id"])
    cycle_time = max(0.0, float(block["cycle_minutes_per_qty"] or 0))
    if cycle_time <= 0:
        return False

    remaining_to_add = float(qty_to_add or 0)
    if remaining_to_add <= 0:
        return False

    changed = False
    tail = one(
        con.execute(
            """
            SELECT *
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND segment_type = 'production'
              AND segment_date > %s
              AND segment_id NOT IN (
                SELECT segment_id
                FROM planner_production_actual
                WHERE segment_id IS NOT NULL
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
              )
            ORDER BY segment_date DESC, end_datetime DESC, segment_id DESC
            LIMIT 1
            """,
            (int(block_id), date_text(actual_date)),
        )
    )

    if tail:
        tail_date = tail["segment_date"] if isinstance(tail["segment_date"], date) else date.fromisoformat(str(tail["segment_date"]))
        cap = capacity_minutes_for_machine_day(con, machine_id, tail_date)
        capacity_minutes = int(cap["capacity_minutes"] or 0)
        max_qty_for_tail_day = math.floor(capacity_minutes / cycle_time) if cycle_time > 0 else 0
        current_qty = float(tail["qty_done"] or 0)
        available_qty_on_tail = max(0.0, max_qty_for_tail_day - current_qty)
        add_to_tail = min(remaining_to_add, available_qty_on_tail)

        if add_to_tail > 0:
            new_qty = current_qty + add_to_tail
            new_minutes = new_qty * cycle_time
            start_dt = parse_dt_text(tail["start_datetime"]) if not isinstance(tail["start_datetime"], datetime) else tail["start_datetime"]
            end_dt = start_dt + timedelta(minutes=new_minutes) if start_dt else parse_dt_text(tail["end_datetime"])
            con.execute(
                """
                UPDATE planner_run_block_segment
                SET qty_done = %s, minutes_used = %s, end_datetime = %s
                WHERE segment_id = %s
                """,
                (new_qty, new_minutes, end_dt, int(tail["segment_id"])),
            )
            remaining_to_add -= add_to_tail
            changed = True

        if remaining_to_add > 0:
            changed = add_future_segments_after_date(con, block_id, tail_date, remaining_to_add) or changed
    else:
        changed = add_future_segments_after_date(con, block_id, actual_date, remaining_to_add)

    return changed


def refresh_block_schedule_bounds(con, block_id):
    block = trial_block_row(con, block_id)
    if not block:
        return
    bounds = one(
        con.execute(
            """
            SELECT MIN(start_datetime) AS start_datetime, MAX(end_datetime) AS end_datetime
            FROM planner_run_block_segment
            WHERE block_id = %s
            """,
            (int(block_id),),
        )
    ) or {}

    future = one(
        con.execute(
            """
            SELECT COALESCE(SUM(qty_done), 0) AS future_qty
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND segment_type = 'production'
              AND segment_id NOT IN (
                SELECT segment_id
                FROM planner_production_actual
                WHERE segment_id IS NOT NULL
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
              )
            """,
            (int(block_id),),
        )
    ) or {}

    totals = actual_totals_for_block(con, block_id)
    required_qty = float(block["scheduled_qty"] or 0)
    valid_done = max(0.0, float(totals["output_qty"] or 0) - float(totals["reject_qty"] or 0))
    remaining_required = max(0.0, required_qty - valid_done)
    future_qty = float(future.get("future_qty") or 0)

    if remaining_required <= 0:
        planning_status = "PLANNED"
    elif future_qty <= 0:
        planning_status = "UNPLANNED"
    elif future_qty + 1e-9 >= remaining_required:
        planning_status = "PLANNED"
    else:
        planning_status = "PARTIALLY_PLANNED"

    con.execute(
        """
        UPDATE planner_run_block
        SET calculated_start_datetime = %s, calculated_end_datetime = %s,
            planning_status = %s, updated_at = NOW()
        WHERE block_id = %s
        """,
        (
            planner_timestamptz_for_db(bounds.get("start_datetime")),
            planner_timestamptz_for_db(bounds.get("end_datetime")),
            planning_status,
            int(block_id),
        ),
    )


def apply_output_delta_to_block_tail(con, block_id, actual_date_text, delta_qty):
    delta_qty = float(delta_qty or 0)
    if delta_qty == 0:
        return {"changed": False, "applied_qty": 0.0}

    block = trial_block_row(con, block_id)
    if not block:
        return {"changed": False, "applied_qty": 0.0}

    if isinstance(actual_date_text, date):
        actual_date = actual_date_text
    elif actual_date_text:
        dt = parse_dt_text(str(actual_date_text))
        actual_date = dt.date() if dt else date.today()
    else:
        actual_date = date.today()

    if delta_qty < 0:
        return {"changed": False, "applied_qty": abs(delta_qty)}

    remaining_to_shave = float(delta_qty)
    if remaining_to_shave <= 0:
        return {"changed": False, "applied_qty": 0.0}

    cycle_time = max(0.0, float(block["cycle_minutes_per_qty"] or 0))
    if cycle_time <= 0:
        return {"changed": False, "applied_qty": 0.0}

    future_segments = rows(
        con.execute(
            """
            SELECT *
            FROM planner_run_block_segment
            WHERE block_id = %s
              AND segment_type = 'production'
              AND segment_date > %s
              AND segment_id NOT IN (
                SELECT segment_id
                FROM planner_production_actual
                WHERE segment_id IS NOT NULL
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
              )
            ORDER BY segment_date DESC, end_datetime DESC, segment_id DESC
            """,
            (int(block_id), date_text(actual_date)),
        )
    )

    changed = False
    for seg in future_segments:
        if remaining_to_shave <= 0:
            break

        seg_qty = float(seg["qty_done"] or 0)
        shave = min(seg_qty, remaining_to_shave)
        new_qty = seg_qty - shave

        if new_qty <= 0:
            con.execute(
                "DELETE FROM planner_run_block_segment WHERE segment_id = %s",
                (int(seg["segment_id"]),),
            )
        else:
            new_minutes = new_qty * cycle_time
            start_dt = parse_dt_text(seg["start_datetime"])
            end_dt = start_dt + timedelta(minutes=new_minutes) if start_dt else parse_dt_text(seg["end_datetime"])
            con.execute(
                """
                UPDATE planner_run_block_segment
                SET qty_done = %s, minutes_used = %s, end_datetime = %s
                WHERE segment_id = %s
                """,
                (new_qty, new_minutes, end_dt, int(seg["segment_id"])),
            )

        remaining_to_shave -= shave
        changed = True

    return {"changed": changed, "applied_qty": delta_qty}


def find_rework_source_for_reject(con, reject_block_id):
    reject_block = trial_block_row(con, reject_block_id)
    if not reject_block:
        return None

    source_ps_id = compact_text(reject_block["source_ps_id"])
    source_op_seq_id = int(reject_block["source_op_seq_id"] or 0)
    reject_done = compact_text(reject_block["execution_status"] or reject_block["status"]).upper() == "DONE"
    if not source_ps_id or not source_op_seq_id:
        return reject_block if reject_done else None

    reject_step = one(
        con.execute(
            "SELECT bom_id AS bom_id, seq_no FROM planner_operation_seq WHERE op_seq_id = %s",
            (source_op_seq_id,),
        )
    )
    if not reject_step:
        return reject_block if reject_done else None

    affected_rows = rows(
        con.execute(
            """
            SELECT b.*
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_operation_seq pfs ON pfs.op_seq_id = o.source_op_seq_id
            WHERE o.source_ps_id = %s
              AND COALESCE(b.block_type, 'ORIGINAL') = 'ORIGINAL'
              AND pfs.bom_id = %s
              AND pfs.seq_no <= %s
              AND COALESCE(b.execution_status, b.status, '') = 'DONE'
            ORDER BY pfs.seq_no, pfs.op_seq_id, b.block_id
            """,
            (source_ps_id, int(reject_step["bom_id"] or 0), int(reject_step["seq_no"] or 0)),
        )
    )
    return affected_rows[0] if affected_rows else None


def rework_op_for_block(con, block_id):
    block = trial_block_row(con, block_id)
    if not block:
        return None

    source_ps_id = compact_text(block["source_ps_id"])
    source_op_seq_id = int(block["source_op_seq_id"] or 0)
    step = None
    if source_op_seq_id:
        step = one(
            con.execute(
                """
                SELECT op_seq_id, bom_id, seq_no, op_no, op_type, machine_category,
                       preferred_machine, cycle_time, setup_time, is_last_op
                FROM planner_operation_seq WHERE op_seq_id = %s
                """,
                (source_op_seq_id,),
            )
        )
    if not step and source_ps_id:
        step = one(
            con.execute(
                """
                SELECT pfs.*
                FROM planner_process_sheet ps
                JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
                WHERE ps.planner_ps_id = %s
                ORDER BY pfs.seq_no, pfs.op_seq_id
                LIMIT 1
                """,
                (source_ps_id,),
            )
        )
    if not step:
        return {
            "source_ps_id": source_ps_id,
            "source_op_seq_id": source_op_seq_id,
            "source_op_no": block["source_op_no"] or "",
            "operation_name": f"{block['operation_name'] or ''} REWORK".strip(),
            "machine_id": int(block["machine_id"] or 0),
            "machine_category": block["compatible_machine_group"] or block["machine_category"] or "",
            "cycle_minutes_per_qty": float(block["cycle_minutes_per_qty"] or 0),
            "setup_minutes": float(block["setup_minutes"] or 0),
        }

    machine = None
    preferred_machine = compact_text(step["preferred_machine"])
    if preferred_machine:
        machine = one(
            con.execute(
                "SELECT * FROM planner_machines WHERE machine_no = %s AND active = TRUE",
                (preferred_machine,),
            )
        )
    if not machine:
        machine = one(
            con.execute(
                """
                SELECT * FROM planner_machines
                WHERE machine_category = %s AND active = TRUE
                ORDER BY machine_id LIMIT 1
                """,
                (compact_text(step["machine_category"]) or "UNKNOWN",),
            )
        )
    if not machine:
        machine = one(
            con.execute(
                "SELECT * FROM planner_machines WHERE active = TRUE ORDER BY machine_id LIMIT 1",
            )
        )

    return {
        "source_ps_id": source_ps_id,
        "source_op_seq_id": int(step["op_seq_id"] or 0),
        "source_op_no": step["op_no"] or "",
        "operation_name": f"{step['op_no'] or ''} {step['op_type'] or ''} REWORK".strip(),
        "machine_id": int(machine["machine_id"]) if machine else 0,
        "machine_category": step["machine_category"] or "",
        "cycle_minutes_per_qty": float(step["cycle_time"] or 0),
        "setup_minutes": float(step["setup_time"] or 0),
    }


def _normalize_preserved_actual_bounds_row(row):
    if not row:
        return None
    start_dt = row.get("start_datetime")
    end_dt = row.get("end_datetime")
    actual_count = int(row.get("actual_count") or 0)
    if actual_count <= 0 or not start_dt or not end_dt:
        return None
    if not isinstance(start_dt, datetime):
        start_dt = parse_dt_text(str(start_dt))
    if not isinstance(end_dt, datetime):
        end_dt = parse_dt_text(str(end_dt))
    if not start_dt or not end_dt:
        return None
    return {"start_datetime": start_dt, "end_datetime": end_dt}


def preserved_actual_bounds_for_blocks(con, block_ids):
    """Batch version of preserved_actual_bounds_for_block for machine recalculation."""
    ids = sorted({int(value) for value in (block_ids or []) if int(value or 0) > 0})
    if not ids:
        return {}
    out = {}
    for row in rows(
        con.execute(
            """
            SELECT
              s.block_id,
              MIN(s.start_datetime) AS start_datetime,
              MAX(s.end_datetime) AS end_datetime,
              COUNT(
                CASE
                  WHEN a.actual_id IS NOT NULL
                   AND (a.output_qty IS NOT NULL OR a.reject_qty IS NOT NULL)
                  THEN 1
                END
              ) AS actual_count
            FROM planner_run_block_segment s
            LEFT JOIN planner_production_actual a
              ON a.segment_id = s.segment_id
             AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
            WHERE s.block_id = ANY(%s)
              AND (
                (
                  a.actual_id IS NOT NULL
                  AND (a.output_qty IS NOT NULL OR a.reject_qty IS NOT NULL)
                )
                OR (
                  s.segment_type = 'setup'
                  AND s.block_id IN (
                    SELECT DISTINCT block_id
                    FROM planner_production_actual
                    WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
                      AND (output_qty IS NOT NULL OR reject_qty IS NOT NULL)
                  )
                )
              )
            GROUP BY s.block_id
            """,
            (ids,),
        )
    ):
        bounds = _normalize_preserved_actual_bounds_row(row)
        if bounds:
            out[int(row["block_id"])] = bounds
    return out


def preserved_actual_bounds_for_block(con, block_id):
    cached = preserved_actual_bounds_for_blocks(con, [int(block_id)])
    return cached.get(int(block_id))


def latest_actual_date_for_block(con, block_id):
    row = one(
        con.execute(
            """
            SELECT MAX(s.segment_date) AS latest_actual_date
            FROM planner_run_block_segment s
            JOIN planner_production_actual a ON a.segment_id = s.segment_id
            WHERE s.block_id = %s
              AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
              AND (a.output_qty IS NOT NULL OR a.reject_qty IS NOT NULL)
            """,
            (int(block_id),),
        )
    ) or {}
    val = row.get("latest_actual_date")
    if not val:
        return None
    if isinstance(val, date):
        return val
    try:
        return date.fromisoformat(str(val))
    except ValueError:
        return None


def delete_rework_from_reject_segment(con, reject_segment_id):
    rework_rows = rows(
        con.execute(
            """
            SELECT block_id, operation_id, machine_id
            FROM planner_run_block
            WHERE block_type = 'REWORK' AND source_reject_segment_id = %s
            """,
            (int(reject_segment_id),),
        )
    )
    machine_ids = set()
    for row in rework_rows:
        machine_ids.add(int(row["machine_id"] or 0))
        con.execute(
            "DELETE FROM planner_run_block WHERE block_id = %s",
            (int(row["block_id"]),),
        )
        remaining = one(
            con.execute(
                "SELECT COUNT(*) AS cnt FROM planner_run_block WHERE operation_id = %s",
                (int(row["operation_id"]),),
            )
        )
        if int((remaining or {}).get("cnt") or 0) <= 0:
            con.execute(
                "DELETE FROM planner_operation WHERE operation_id = %s",
                (int(row["operation_id"]),),
            )
    return {machine_id for machine_id in machine_ids if machine_id}


def create_rework_from_reject(con, rework_source_block_id, reject_segment_id, reject_qty):
    reject_qty = max(0.0, float(reject_qty or 0))
    if reject_qty <= 0:
        return {"created": False, "machine_id": 0}

    rework_source_block = trial_block_row(con, rework_source_block_id)
    if not rework_source_block:
        return {"created": False, "machine_id": 0}

    existing_rework = one(
        con.execute(
            """
            SELECT b.block_id, b.machine_id, b.operation_id
            FROM planner_run_block b
            WHERE b.block_type = 'REWORK' AND b.source_reject_segment_id = %s
            LIMIT 1
            """,
            (int(reject_segment_id),),
        )
    )
    if existing_rework:
        con.execute(
            "UPDATE planner_run_block SET scheduled_qty = %s, updated_at = NOW() WHERE block_id = %s",
            (reject_qty, int(existing_rework["block_id"])),
        )
        con.execute(
            "UPDATE planner_operation SET total_qty = %s, updated_at = NOW() WHERE operation_id = %s",
            (reject_qty, int(existing_rework["operation_id"])),
        )
        return {"created": False, "machine_id": int(existing_rework["machine_id"] or 0)}

    first_op = rework_op_for_block(con, rework_source_block_id)
    if not first_op or not first_op["machine_id"]:
        return {"created": False, "machine_id": 0}

    machine_id = int(first_op["machine_id"])
    queue_position = 1 + float(
        one(
            con.execute(
                "SELECT COALESCE(MAX(queue_position), 0) AS mx FROM planner_run_block WHERE machine_id = %s",
                (machine_id,),
            )
        )["mx"]
        or 0
    )

    op_cur = con.execute(
        """
        INSERT INTO planner_operation (
          job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty, compatible_machine_group,
          source_ps_id, source_op_seq_id, source_op_no, status, remarks, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'ACTIVE', %s, NOW())
        RETURNING operation_id
        """,
        (
            rework_source_block["job_no"],
            first_op["operation_name"],
            reject_qty,
            first_op["setup_minutes"],
            first_op["cycle_minutes_per_qty"],
            first_op["machine_category"],
            first_op["source_ps_id"],
            first_op["source_op_seq_id"],
            first_op["source_op_no"],
            f"REWORK from reject on block {rework_source_block_id}",
        ),
    )
    operation_id = int(one(op_cur)["operation_id"])

    block_cur = con.execute(
        """
        INSERT INTO planner_run_block (
          operation_id, machine_id, queue_position, scheduled_qty, include_setup,
          status, planning_status, execution_status,
          anchor_datetime, calculated_start_datetime, calculated_end_datetime,
          actual_good_qty, actual_reject_qty, remarks,
          block_type, source_reject_block_id, source_reject_segment_id, updated_at
        ) VALUES (%s, %s, %s, %s, TRUE, 'NOT_STARTED', 'PLANNED', 'NOT_STARTED',
                  NULL, NULL, NULL, 0, 0, %s, 'REWORK', %s, %s, NOW())
        RETURNING block_id
        """,
        (
            operation_id,
            machine_id,
            queue_position,
            reject_qty,
            f"REWORK qty {format_qty(reject_qty)} created from reject on {rework_source_block['job_no']}",
            int(rework_source_block_id),
            int(reject_segment_id),
        ),
    )
    rework_block_id = int(one(block_cur)["block_id"])

    source_actual = one(
        con.execute(
            """
            SELECT actual_id
            FROM planner_production_actual
            WHERE segment_id = %s
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            ORDER BY actual_id DESC
            LIMIT 1
            """,
            (int(reject_segment_id),),
        )
    )
    con.execute(
        """
        INSERT INTO planner_rework_link (
          source_actual_id, source_block_id, rework_block_id, reject_qty, created_at
        ) VALUES (%s, %s, %s, %s, NOW())
        ON CONFLICT DO NOTHING
        """,
        (
            int(source_actual["actual_id"]) if source_actual else None,
            int(rework_source_block_id),
            rework_block_id,
            reject_qty,
        ),
    )
    return {"created": True, "machine_id": machine_id}


def _next_interval_after(con, machine_id, current_dt, interval_cache=None):
    probe = current_dt.date()
    safety = 0
    while safety < 365:
        safety += 1
        intervals = machine_work_intervals_for_day(con, machine_id, probe, interval_cache=interval_cache)
        for start_dt, end_dt in intervals:
            if end_dt <= current_dt:
                continue
            if start_dt >= current_dt:
                return start_dt, end_dt
            if start_dt <= current_dt < end_dt:
                return current_dt, end_dt
        probe += timedelta(days=1)
        current_dt = datetime.combine(probe, datetime.min.time())
    return None, None


def _schedule_setup_across_intervals(con, machine_id, block_id, schedule_run_id, start_dt, remaining_setup, interval_cache=None):
    current_dt = start_dt
    first_start = None
    end_dt = None
    safety = 0
    remaining = float(remaining_setup or 0)
    while remaining > 0 and safety < 365:
        safety += 1
        interval_start, interval_end = _next_interval_after(con, machine_id, current_dt, interval_cache=interval_cache)
        if not interval_start or not interval_end:
            break
        if current_dt < interval_start:
            current_dt = interval_start
        if first_start is None:
            first_start = current_dt
        available = max(0.0, (interval_end - current_dt).total_seconds() / 60.0)
        if available <= 0:
            current_dt = interval_end
            continue
        use = min(remaining, available)
        seg_end = current_dt + timedelta(minutes=use)
        con.execute(
            """
            INSERT INTO planner_run_block_segment (
              block_id, machine_id, schedule_run_id, segment_date, segment_type, qty_done, planned_qty,
              minutes_used, planned_minutes, segment_status, start_datetime, end_datetime, is_actual
            ) VALUES (%s, %s, %s, %s, 'setup', 0, 0, %s, %s, 'PLANNED', %s, %s, FALSE)
            """,
            (
                int(block_id),
                int(machine_id),
                int(schedule_run_id),
                date_text(current_dt.date()),
                use,
                use,
                current_dt,
                seg_end,
            ),
        )
        remaining -= use
        current_dt = seg_end
        end_dt = seg_end
    return first_start, current_dt, end_dt, remaining


def _schedule_production_across_intervals(con, machine_id, block, schedule_run_id, start_dt, remaining_qty, cycle_time, interval_cache=None):
    current_dt = start_dt
    first_start = None
    end_dt = None
    remaining = float(remaining_qty or 0)
    cycle_time = max(0.0, float(cycle_time or 0))
    safety = 0
    while remaining > 0 and safety < 365:
        safety += 1
        interval_start, interval_end = _next_interval_after(con, machine_id, current_dt, interval_cache=interval_cache)
        if not interval_start or not interval_end:
            break
        if current_dt < interval_start:
            current_dt = interval_start
        if first_start is None:
            first_start = current_dt
        available = max(0.0, (interval_end - current_dt).total_seconds() / 60.0)
        if available <= 0:
            current_dt = interval_end
            continue
        if cycle_time <= 0:
            break
        qty = min(remaining, math.floor(available / cycle_time))
        if qty <= 0:
            current_dt = interval_end
            continue
        use = qty * cycle_time
        seg_end = current_dt + timedelta(minutes=use)
        con.execute(
            """
            INSERT INTO planner_run_block_segment (
              block_id, machine_id, schedule_run_id, segment_date, segment_type, qty_done, planned_qty,
              minutes_used, planned_minutes, segment_status, start_datetime, end_datetime, is_actual
            ) VALUES (%s, %s, %s, %s, 'production', %s, %s, %s, %s, 'PLANNED', %s, %s, FALSE)
            """,
            (
                int(block["block_id"]),
                int(machine_id),
                int(schedule_run_id),
                date_text(current_dt.date()),
                qty,
                qty,
                use,
                use,
                current_dt,
                seg_end,
            ),
        )
        remaining -= qty
        current_dt = seg_end
        end_dt = seg_end
    return first_start, current_dt, end_dt, remaining


def _schedule_combined_production_across_intervals(con, machine_id, members, schedule_run_id, start_dt, remaining_qty, interval_cache=None):
    current_dt = start_dt
    first_start = None
    end_dt = None
    remaining = float(remaining_qty or 0)
    combined_cycle = sum(float(member["cycle_minutes_per_qty"] or 0) for member in members)
    safety = 0
    while remaining > 0 and safety < 365:
        safety += 1
        interval_start, interval_end = _next_interval_after(con, machine_id, current_dt, interval_cache=interval_cache)
        if not interval_start or not interval_end:
            break
        if current_dt < interval_start:
            current_dt = interval_start
        if first_start is None:
            first_start = current_dt
        available = max(0.0, (interval_end - current_dt).total_seconds() / 60.0)
        if available <= 0:
            current_dt = interval_end
            continue
        if combined_cycle <= 0:
            break
        qty = min(remaining, math.floor(available / combined_cycle))
        if qty <= 0:
            current_dt = interval_end
            continue
        group_use = qty * combined_cycle
        seg_end = current_dt + timedelta(minutes=group_use)
        for idx, member in enumerate(members):
            member_cycle = max(0.0, float(member["cycle_minutes_per_qty"] or 0))
            member_minutes = qty * member_cycle
            member_end = current_dt + timedelta(minutes=member_minutes)
            con.execute(
                """
                INSERT INTO planner_run_block_segment (
                  block_id, machine_id, schedule_run_id, segment_date, segment_type, qty_done, planned_qty,
                  minutes_used, planned_minutes, segment_status, start_datetime, end_datetime, is_actual
                ) VALUES (%s, %s, %s, %s, 'production', %s, %s, %s, %s, 'PLANNED', %s, %s, FALSE)
                """,
                (
                    int(member["block_id"]),
                    int(machine_id),
                    int(schedule_run_id),
                    date_text(current_dt.date()),
                    qty,
                    qty,
                    member_minutes,
                    member_minutes,
                    current_dt,
                    member_end,
                ),
            )
            if idx == len(members) - 1:
                end_dt = seg_end
        remaining -= qty
        current_dt = seg_end
    return first_start, current_dt, end_dt, remaining


def _leader_end_datetime(leader, preserved_bounds_by_block, naive_schedule_dt):
    block_id = int(leader["block_id"])
    bounds = preserved_bounds_by_block.get(block_id)
    if bounds and bounds.get("end_datetime"):
        return naive_schedule_dt(bounds["end_datetime"])
    return naive_schedule_dt(leader.get("calculated_end_datetime"))


def _naive_schedule_dt(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo is not None else value
    return parse_dt_text(value)


def _sync_block_planned_dates(con, block_id, start_dt, end_dt, *, anchor_dt=None):
    """Mirror recalculated bounds onto planned_start_at/planned_end_at for catalog/master feedback."""
    start_dt = _naive_schedule_dt(start_dt)
    end_dt = _naive_schedule_dt(end_dt)
    if not start_dt or not end_dt:
        return
    if anchor_dt is None:
        row = one(
            con.execute(
                "SELECT anchor_datetime FROM planner_run_block WHERE block_id = %s",
                (int(block_id),),
            )
        )
        anchor_dt = row["anchor_datetime"] if row else None
    anchor_dt = _naive_schedule_dt(anchor_dt)
    planned_start = max(start_dt, anchor_dt) if anchor_dt else start_dt
    con.execute(
        """
        UPDATE planner_run_block
        SET planned_start_at = %s, planned_end_at = %s, updated_at = NOW()
        WHERE block_id = %s
        """,
        (
            planner_timestamptz_for_db(planned_start),
            planner_timestamptz_for_db(end_dt),
            int(block_id),
        ),
    )


def _resolve_block_candidate_start(
    predecessor_end_dt,
    anchor_dt,
    dependency_finish,
    planned_start,
    allow_pull,
    is_fresh,
    *,
    queue_fallback_dt=None,
):
    """Anchor supersedes scheduled timing; without anchor, chain from the previous queue job end."""
    predecessor_end_dt = _naive_schedule_dt(predecessor_end_dt)
    anchor_dt = _naive_schedule_dt(anchor_dt)
    dependency_finish = _naive_schedule_dt(dependency_finish)
    planned_start = _naive_schedule_dt(planned_start)

    effective_anchor = anchor_dt
    if not effective_anchor and allow_pull == 0 and planned_start:
        effective_anchor = planned_start

    if effective_anchor:
        candidate_start = effective_anchor
        if predecessor_end_dt and predecessor_end_dt > candidate_start:
            candidate_start = predecessor_end_dt
    elif predecessor_end_dt:
        candidate_start = predecessor_end_dt
    else:
        candidate_start = queue_fallback_dt

    if dependency_finish and candidate_start and dependency_finish > candidate_start:
        candidate_start = dependency_finish
    elif dependency_finish and not candidate_start:
        candidate_start = dependency_finish

    # Scheduled pull-forward clamp applies only when no explicit anchor is set.
    if (
        not anchor_dt
        and planned_start
        and candidate_start
        and candidate_start < planned_start
        and (allow_pull == 0 or is_fresh == 1)
    ):
        candidate_start = planned_start
    return candidate_start


def is_dummy_block_row(block) -> bool:
    return compact_text((block or {}).get("block_type")).upper() == "DUMMY"


def _parse_dummy_card_times(start_text, end_text=None, duration_minutes=None):
    start_dt = planner_wall_datetime_from_input(compact_text(start_text))
    if not start_dt:
        raise ValueError("Start date/time is required")

    end_text_clean = compact_text(end_text) if end_text is not None else ""
    if end_text_clean:
        end_dt = planner_wall_datetime_from_input(end_text_clean)
        if not end_dt:
            raise ValueError("End date/time is required")
        if end_dt <= start_dt:
            raise ValueError("End must be after start")
        return start_dt, end_dt

    if duration_minutes is not None:
        try:
            mins = float(duration_minutes)
        except (TypeError, ValueError):
            mins = 0
        if mins <= 0:
            raise ValueError("Duration must be greater than 0 minutes")
        return start_dt, start_dt + timedelta(minutes=mins)

    raise ValueError("Provide either end date/time or duration in minutes")


def create_dummy_card(
    con,
    *,
    title,
    description="",
    machine_id,
    start_datetime,
    end_datetime=None,
    duration_minutes=None,
    queue_position=0,
):
    title_text = compact_text(title)
    if not title_text:
        raise ValueError("Title is required")
    machine_id = int(machine_id or 0)
    if not machine_id:
        raise ValueError("Machine is required")
    start_dt, end_dt = _parse_dummy_card_times(
        start_datetime, end_datetime, duration_minutes
    )
    description_text = compact_text(description)

    op_cur = con.execute(
        """
        INSERT INTO planner_operation (
          job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty,
          status, remarks, updated_at
        ) VALUES (%s, %s, 0, 0, 0, 'ACTIVE', %s, NOW())
        RETURNING operation_id
        """,
        (title_text, description_text or title_text, description_text),
    )
    operation_id = int(one(op_cur)["operation_id"])

    queue_position = float(queue_position or 0)
    if queue_position <= 0:
        queue_position = 1 + float(
            one(
                con.execute(
                    "SELECT COALESCE(MAX(queue_position), 0) AS mx FROM planner_run_block WHERE machine_id = %s",
                    (machine_id,),
                )
            )["mx"]
            or 0
        )

    block_cur = con.execute(
        """
        INSERT INTO planner_run_block (
          operation_id, machine_id, queue_position, scheduled_qty, include_setup, status,
          planning_status, execution_status, block_type,
          anchor_datetime, planned_start_at, planned_end_at,
          calculated_start_datetime, calculated_end_datetime,
          allow_pull_forward, remarks, updated_at
        ) VALUES (
          %s, %s, %s, 0, FALSE, 'PLANNED', 'PLANNED', 'NOT_STARTED', 'DUMMY',
          %s, %s, %s, %s, %s, FALSE, %s, NOW()
        )
        RETURNING block_id
        """,
        (
            operation_id,
            machine_id,
            queue_position,
            start_dt,
            start_dt,
            end_dt,
            start_dt,
            end_dt,
            description_text,
        ),
    )
    block_id = int(one(block_cur)["block_id"])
    return trial_block_row(con, block_id)


def update_dummy_card(
    con,
    block_id,
    *,
    title=None,
    description=None,
    machine_id=None,
    start_datetime=None,
    end_datetime=None,
    duration_minutes=None,
):
    block = trial_block_row(con, block_id)
    if not block:
        raise ValueError("Run block not found")
    if not is_dummy_block_row(block):
        raise ValueError("Not a dummy card")

    op_updates = {}
    if title is not None:
        title_text = compact_text(title)
        if not title_text:
            raise ValueError("Title is required")
        op_updates["job_no"] = title_text
    if description is not None:
        description_text = compact_text(description)
        op_updates["operation_name"] = description_text or op_updates.get("job_no") or block["job_no"]
        op_updates["remarks"] = description_text

    if op_updates:
        set_clause = ", ".join(f"{k} = %s" for k in op_updates)
        con.execute(
            f"UPDATE planner_operation SET {set_clause}, updated_at = NOW() WHERE operation_id = %s",
            (*op_updates.values(), int(block["operation_id"])),
        )

    block_updates = {}
    if machine_id is not None:
        next_machine_id = int(machine_id or 0)
        if not next_machine_id:
            raise ValueError("Machine is required")
        block_updates["machine_id"] = next_machine_id

    if start_datetime is not None or end_datetime is not None or duration_minutes is not None:
        current_start = block.get("planned_start_at") or block.get("anchor_datetime")
        current_end = block.get("planned_end_at") or block.get("calculated_end_datetime")
        start_bind = (
            planner_wall_datetime_from_input(compact_text(start_datetime))
            if start_datetime is not None
            else (current_start if isinstance(current_start, datetime) else parse_dt_text(current_start))
        )
        if duration_minutes is not None:
            try:
                mins = float(duration_minutes)
            except (TypeError, ValueError):
                mins = 0
            if mins <= 0:
                raise ValueError("Duration must be greater than 0 minutes")
            if not start_bind:
                raise ValueError("Start date/time is required")
            end_bind = start_bind + timedelta(minutes=mins)
        else:
            end_bind = (
                planner_wall_datetime_from_input(compact_text(end_datetime))
                if end_datetime is not None
                else (current_end if isinstance(current_end, datetime) else parse_dt_text(current_end))
            )
            if not start_bind or not end_bind:
                raise ValueError("Start and end date/time are required")
            if end_bind <= start_bind:
                raise ValueError("End must be after start")
        block_updates["anchor_datetime"] = start_bind
        block_updates["planned_start_at"] = start_bind
        block_updates["planned_end_at"] = end_bind
        block_updates["calculated_start_datetime"] = start_bind
        block_updates["calculated_end_datetime"] = end_bind

    if block_updates:
        set_clause = ", ".join(f"{k} = %s" for k in block_updates)
        con.execute(
            f"UPDATE planner_run_block SET {set_clause}, updated_at = NOW() WHERE block_id = %s",
            (*block_updates.values(), int(block_id)),
        )

    return trial_block_row(con, block_id)


def recalculate_machine(con, machine_id, reason="PLANNER_CHANGE", schedule_run_id=None, tail_from_block_id=None):
    own_run = schedule_run_id is None
    if own_run:
        old_snap = snapshot_queue_state(con, machine_id)
        schedule_run_id = create_schedule_run(
            con,
            reason=reason,
            scope_type="MACHINE",
            machine_id=int(machine_id),
            notes=f"Recalculate machine {machine_id}",
        )
    blocks = rows(
        con.execute(
            """
            SELECT b.*, o.job_no, o.operation_name, o.total_qty, o.setup_minutes, o.cycle_minutes_per_qty,
                   o.compatible_machine_group, o.source_ps_id, o.source_op_seq_id AS source_op_seq_id, o.source_op_no,
                   m.machine_no AS machine_code, m.machine_category, m.shift_profile
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
            ORDER BY b.queue_position, b.block_id
            """,
            (int(machine_id),),
        )
    )
    if not blocks:
        return

    today_start = datetime.combine(planner_today(), datetime.min.time()).replace(
        hour=8, minute=30, second=0, microsecond=0
    )

    combined_groups = {}
    queue_items = []
    for block in blocks:
        group_id = int(block["group_id"] or 0)
        if group_id > 0:
            combined_groups.setdefault(group_id, []).append(block)
        else:
            queue_items.append({"members": [block], "combined": False})
    for members in combined_groups.values():
        members.sort(key=lambda row: (float(row["queue_position"] or 0), int(row["block_id"] or 0)))
        queue_items.append({"members": members, "combined": len(members) > 1})

    def item_sort_key(item):
        leader = item["members"][0]
        return (float(leader["queue_position"] or 0), int(leader["block_id"] or 0))

    queue_items.sort(key=item_sort_key)

    start_item_idx = 0
    tail_block_id = int(tail_from_block_id or 0)
    if tail_block_id:
        for idx, item in enumerate(queue_items):
            member_ids = [int(member["block_id"]) for member in item["members"]]
            if tail_block_id in member_ids:
                start_item_idx = idx
                break

    if start_item_idx >= len(queue_items):
        from .operation_sequence import sync_machine_operation_sequence

        sync_machine_operation_sequence(con, int(machine_id))
        refresh_states_for_machine(con, int(machine_id), schedule_run_id=schedule_run_id)
        return

    rebuild_block_ids = [
        int(member["block_id"])
        for item in queue_items[start_item_idx:]
        for member in item["members"]
        if not is_dummy_block_row(member)
    ]
    if rebuild_block_ids:
        con.execute(
            """
            DELETE FROM planner_run_block_segment
            WHERE block_id = ANY(%s)
              AND segment_id NOT IN (
                SELECT segment_id
                FROM planner_production_actual
                WHERE segment_id IS NOT NULL
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
              )
              AND NOT (
                segment_type = 'setup'
                AND block_id IN (
                  SELECT DISTINCT block_id
                  FROM planner_production_actual
                  WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
                    AND (output_qty IS NOT NULL OR reject_qty IS NOT NULL)
                )
              )
            """,
            (rebuild_block_ids,),
        )

    all_block_ids = [
        int(member["block_id"])
        for item in queue_items
        for member in item["members"]
    ]
    preserved_bounds_by_block = preserved_actual_bounds_for_blocks(con, all_block_ids)

    interval_cache = {}
    queue_cursor_end = None

    def update_block_schedule_window(block_id, start_dt, end_dt, planning_status=None, *, anchor_dt=None):
        start_bind = planner_timestamptz_for_db(start_dt)
        end_bind = planner_timestamptz_for_db(end_dt)
        start_text = start_dt.strftime("%Y-%m-%d %H:%M:%S") if start_dt else None
        end_text = end_dt.strftime("%Y-%m-%d %H:%M:%S") if end_dt else None
        con.execute(
            """
            UPDATE planner_run_block
            SET calculated_start_datetime = %s, calculated_end_datetime = %s,
                last_schedule_run_id = %s,
                planned_qty_original = CASE WHEN COALESCE(planned_qty_original, 0) <= 0 THEN scheduled_qty ELSE planned_qty_original END,
                planning_status = COALESCE(%s, CASE
                  WHEN COALESCE(planning_status, '') = 'UNPLANNED' THEN 'PLANNED'
                  ELSE planning_status
                END),
                status = COALESCE(execution_status, status, 'NOT_STARTED'),
                updated_at = NOW()
            WHERE block_id = %s
            """,
            (
                start_bind,
                end_bind,
                int(schedule_run_id) if schedule_run_id is not None else None,
                planning_status,
                int(block_id),
            ),
        )
        if start_text and end_text:
            _sync_block_planned_dates(
                con,
                int(block_id),
                start_dt,
                end_dt,
                anchor_dt=anchor_dt,
            )
        if not start_text or not end_text:
            upsert_schedule_alert(
                con,
                schedule_run_id=schedule_run_id,
                block_id=block_id,
                operation_id=int(block["operation_id"]),
                ps_id=compact_text(block.get("source_ps_id")),
                machine_id=int(machine_id),
                alert_type="NO_CAPACITY",
                severity="WARN",
                message="No capacity found while recalculating.",
                planned_at=block.get("planned_end_at") or block.get("calculated_end_datetime") or "",
                predicted_at="",
                delay_minutes=0,
                status="OPEN",
            )
        else:
            for alert in rows(
                con.execute(
                    """
                    SELECT alert_id FROM planner_schedule_alert
                    WHERE block_id = %s AND alert_type = 'NO_CAPACITY' AND status IN ('OPEN', 'ACKNOWLEDGED')
                    """,
                    (int(block_id),),
                )
            ):
                resolve_schedule_alert(con, int(alert["alert_id"]))
            old_end = block.get("planned_end_at") or block.get("calculated_end_datetime")
            old_end_str = old_end.strftime("%Y-%m-%d %H:%M:%S") if isinstance(old_end, datetime) else compact_text(old_end)
            if old_end_str and old_end_str != end_text:
                upsert_schedule_alert(
                    con,
                    schedule_run_id=schedule_run_id,
                    block_id=block_id,
                    operation_id=int(block["operation_id"]),
                    ps_id=compact_text(block.get("source_ps_id")),
                    machine_id=int(machine_id),
                    alert_type="PREDICTED_END_CHANGED",
                    severity="INFO",
                    message="Predicted end changed after recalculation.",
                    old_value=old_end_str,
                    new_value=end_text,
                    planned_at=old_end_str,
                    predicted_at=end_text,
                    delay_minutes=0,
                    status="OPEN",
                )

    for rel_idx, item in enumerate(queue_items[start_item_idx:]):
        members = item["members"]
        leader = members[0]
        is_combined = bool(item["combined"])
        if rel_idx == 0 and start_item_idx > 0:
            predecessor_end = _leader_end_datetime(
                queue_items[start_item_idx - 1]["members"][0],
                preserved_bounds_by_block,
                _naive_schedule_dt,
            )
        else:
            predecessor_end = queue_cursor_end

        if not is_combined:
            block = leader
            if is_dummy_block_row(block):
                continue
            planned_start = parse_dt_text(block["planned_start_at"])
            anchor_dt = parse_dt_text(block["anchor_datetime"])
            dependency_finish = dependency_finish_for_block(con, block)
            allow_pull = int(block.get("allow_pull_forward") if block.get("allow_pull_forward") is not None else 1)
            is_fresh = int(block.get("is_fresh_monday_item") or 0)
            current_dt = _resolve_block_candidate_start(
                predecessor_end,
                anchor_dt,
                dependency_finish,
                planned_start,
                allow_pull,
                is_fresh,
                queue_fallback_dt=today_start,
            )

            actual_bounds = preserved_bounds_by_block.get(int(block["block_id"]))
            if actual_bounds:
                update_block_schedule_window(
                    block["block_id"],
                    actual_bounds["start_datetime"],
                    actual_bounds["end_datetime"],
                    None,
                )
                totals = actual_totals_for_block(con, block["block_id"])
                reported_output = max(0.0, float(totals["output_qty"] or 0) - float(totals["reject_qty"] or 0))
                scheduled_qty = max(0.0, float(block["scheduled_qty"] or 0))
                remaining_qty = max(0.0, scheduled_qty - reported_output)
                latest_actual_date = latest_actual_date_for_block(con, int(block["block_id"]))
                if remaining_qty > 0 and latest_actual_date:
                    add_future_segments_after_date(con, int(block["block_id"]), latest_actual_date, remaining_qty, schedule_run_id=schedule_run_id)
                refresh_block_schedule_bounds(con, int(block["block_id"]))
                refreshed = trial_block_row(con, int(block["block_id"]))
                refreshed_end = refreshed["calculated_end_datetime"] if refreshed else None
                if refreshed_end and not isinstance(refreshed_end, datetime):
                    refreshed_end = parse_dt_text(refreshed_end)
                current_dt = refreshed_end or actual_bounds["end_datetime"]
                queue_cursor_end = current_dt
                continue

            raw_reported_output = max(0.0, float(block["actual_good_qty"] or 0))
            reported_reject = max(0.0, float(block["actual_reject_qty"] or 0))
            reported_output = max(0.0, raw_reported_output - reported_reject)
            scheduled_qty = max(0.0, float(block["scheduled_qty"] or 0))
            remaining_qty = max(0.0, scheduled_qty - reported_output)
            if remaining_qty <= 0:
                remaining_qty = scheduled_qty

            setup_minutes = float(block["setup_minutes"] or 0) if int(block["include_setup"] or 0) == 1 else 0.0
            remaining_setup = 0.0 if (reported_output > 0 or reported_reject > 0) else setup_minutes
            cycle_time = max(0.0, float(block["cycle_minutes_per_qty"] or 0))
            if cycle_time <= 0:
                remaining_qty = 0.0
            start_dt = None
            end_dt = None
            if remaining_setup > 0:
                setup_start, current_dt, setup_end, remaining_setup = _schedule_setup_across_intervals(
                    con, machine_id, int(block["block_id"]), schedule_run_id, current_dt, remaining_setup,
                    interval_cache=interval_cache,
                )
                start_dt = start_dt or setup_start
                end_dt = setup_end or end_dt
            if remaining_qty > 0 and cycle_time > 0:
                prod_start, current_dt, prod_end, remaining_qty = _schedule_production_across_intervals(
                    con, machine_id, block, schedule_run_id, current_dt, remaining_qty, cycle_time,
                    interval_cache=interval_cache,
                )
                start_dt = start_dt or prod_start
                end_dt = prod_end or end_dt

            update_block_schedule_window(
                block["block_id"],
                start_dt,
                end_dt,
                None,
                anchor_dt=anchor_dt,
            )
            queue_cursor_end = current_dt
            continue

        # Combined group
        setup_minutes = max((float(member["setup_minutes"] or 0) for member in members), default=0.0)
        combined_cycle = sum(float(member["cycle_minutes_per_qty"] or 0) for member in members)
        scheduled_qty = max((float(member["scheduled_qty"] or 0) for member in members), default=0.0)
        leader_planned_start = parse_dt_text(leader["planned_start_at"])
        leader_anchor = parse_dt_text(leader["anchor_datetime"])
        leader_dependency_finish = dependency_finish_for_block(con, leader)
        leader_allow_pull = int(leader.get("allow_pull_forward") if leader.get("allow_pull_forward") is not None else 1)
        leader_is_fresh = int(leader.get("is_fresh_monday_item") or 0)
        current_dt = _resolve_block_candidate_start(
            predecessor_end,
            leader_anchor,
            leader_dependency_finish,
            leader_planned_start,
            leader_allow_pull,
            leader_is_fresh,
            queue_fallback_dt=today_start,
        )

        actual_bounds_by_block = {
            int(member["block_id"]): preserved_bounds_by_block.get(int(member["block_id"]))
            for member in members
        }
        if any(actual_bounds_by_block.values()):
            max_end = None
            for member in members:
                member_id = int(member["block_id"])
                actual_bounds = actual_bounds_by_block.get(member_id)
                if actual_bounds:
                    update_block_schedule_window(member_id, actual_bounds["start_datetime"], actual_bounds["end_datetime"], None)
                totals = actual_totals_for_block(con, member_id)
                reported_output = max(0.0, float(totals["output_qty"] or 0) - float(totals["reject_qty"] or 0))
                member_scheduled_qty = max(0.0, float(member["scheduled_qty"] or 0))
                remaining_qty = max(0.0, member_scheduled_qty - reported_output)
                latest_actual_date = latest_actual_date_for_block(con, member_id)
                if remaining_qty > 0 and latest_actual_date:
                    add_future_segments_after_date(con, member_id, latest_actual_date, remaining_qty, schedule_run_id=schedule_run_id)
                refresh_block_schedule_bounds(con, member_id)
                refreshed = trial_block_row(con, member_id)
                refreshed_end = refreshed["calculated_end_datetime"] if refreshed else None
                if refreshed_end and not isinstance(refreshed_end, datetime):
                    refreshed_end = parse_dt_text(refreshed_end)
                if refreshed_end and (max_end is None or refreshed_end > max_end):
                    max_end = refreshed_end
            current_dt = max_end or current_dt
            queue_cursor_end = current_dt
            continue

        remaining_setup = setup_minutes if int(leader["include_setup"] or 0) == 1 else 0.0
        remaining_qty = scheduled_qty
        start_dt = None
        end_dt = None
        if remaining_setup > 0:
            setup_start, current_dt, setup_end, remaining_setup = _schedule_setup_across_intervals(
                con, machine_id, int(leader["block_id"]), schedule_run_id, current_dt, remaining_setup,
                interval_cache=interval_cache,
            )
            start_dt = start_dt or setup_start
            end_dt = setup_end or end_dt
        if remaining_qty > 0 and combined_cycle > 0:
            group_start, current_dt, group_end, remaining_qty = _schedule_combined_production_across_intervals(
                con, machine_id, members, schedule_run_id, current_dt, remaining_qty,
                interval_cache=interval_cache,
            )
            start_dt = start_dt or group_start
            end_dt = group_end or end_dt

        for member in members[1:]:
            refresh_block_schedule_bounds(con, int(member["block_id"]))
        if start_dt and end_dt:
            update_block_schedule_window(
                leader["block_id"],
                start_dt,
                end_dt,
                None,
                anchor_dt=leader_anchor,
            )
        else:
            refresh_block_schedule_bounds(con, int(leader["block_id"]))
        refreshed_leader = trial_block_row(con, int(leader["block_id"]))
        refreshed_end = refreshed_leader["calculated_end_datetime"] if refreshed_leader else None
        if refreshed_end and not isinstance(refreshed_end, datetime):
            refreshed_end = parse_dt_text(refreshed_end)
        if refreshed_end and refreshed_end > current_dt:
            current_dt = refreshed_end
        queue_cursor_end = current_dt

    from .operation_sequence import sync_machine_operation_sequence, sync_planning_cards_for_machine

    sync_machine_operation_sequence(con, int(machine_id))
    sync_planning_cards_for_machine(con, int(machine_id))
    refresh_states_for_machine(con, int(machine_id), schedule_run_id=schedule_run_id)

    if own_run:
        new_snap = snapshot_queue_state(con, machine_id)
        summary = compute_change_summary(old_snap, new_snap, machine_id=machine_id)
        superseded_id = find_superseded_run_id(con, schedule_run_id, int(machine_id), "MACHINE")
        if superseded_id:
            write_change_summary(con, superseded_id, summary)


def recalculate_machines(con, machine_ids, reason="PLANNER_CHANGE", tail_by_machine=None):
    """Recalculate several machine lanes under one schedule run (stacked recalc)."""
    machine_ids = sorted({int(mid) for mid in (machine_ids or []) if int(mid or 0) > 0})
    if not machine_ids:
        return

    tail_by_machine = tail_by_machine or {}
    old_snaps = snapshot_queue_state_all(con, machine_ids)
    schedule_run_id = create_schedule_run(
        con,
        reason=reason,
        scope_type="MACHINE",
        machine_id=None,
        notes=f"Recalculate machines {','.join(str(mid) for mid in machine_ids)}",
    )
    for machine_id in machine_ids:
        recalculate_machine(
            con,
            machine_id,
            reason=reason,
            schedule_run_id=schedule_run_id,
            tail_from_block_id=tail_by_machine.get(int(machine_id)),
        )

    by_machine = {}
    total_shifted = total_added = total_removed = 0
    for mid in machine_ids:
        new_snap = snapshot_queue_state(con, mid)
        msummary = compute_change_summary(old_snaps[int(mid)], new_snap, machine_id=mid)
        if msummary["blocks_shifted"] or msummary["blocks_added"] or msummary["blocks_removed"]:
            by_machine[str(int(mid))] = msummary
            total_shifted += len(msummary["blocks_shifted"])
            total_added += len(msummary["blocks_added"])
            total_removed += len(msummary["blocks_removed"])
            superseded_id = find_superseded_run_id(con, schedule_run_id, int(mid), "MACHINE")
            if superseded_id:
                write_change_summary(con, superseded_id, msummary)

    if len(machine_ids) > 1 and by_machine:
        batch_summary = {
            "scope": "MACHINE_BATCH",
            "machines_changed": len(by_machine),
            "total_blocks_shifted": total_shifted,
            "total_blocks_added": total_added,
            "total_blocks_removed": total_removed,
            "by_machine": by_machine,
        }
        superseded_id = find_superseded_run_id(con, schedule_run_id, None, "MACHINE")
        if superseded_id:
            write_change_summary(con, superseded_id, batch_summary)


def recalculate_all(con):
    machine_ids = [
        row["machine_id"]
        for row in rows(
            con.execute(
                "SELECT machine_id FROM planner_machines WHERE active = TRUE ORDER BY machine_id"
            )
        )
    ]
    old_snaps = snapshot_queue_state_all(con, machine_ids)
    schedule_run_id = create_schedule_run(
        con, reason="MANUAL_RECALCULATE", scope_type="FULL", machine_id=None, notes="Recalculate all machines"
    )
    for machine_id in machine_ids:
        recalculate_machine(con, machine_id, reason="MANUAL_RECALCULATE", schedule_run_id=schedule_run_id)

    by_machine = {}
    total_shifted = total_added = total_removed = 0
    for mid in machine_ids:
        new_snap = snapshot_queue_state(con, mid)
        msummary = compute_change_summary(old_snaps[int(mid)], new_snap, machine_id=mid)
        if msummary["blocks_shifted"] or msummary["blocks_added"] or msummary["blocks_removed"]:
            by_machine[str(int(mid))] = msummary
            total_shifted += len(msummary["blocks_shifted"])
            total_added += len(msummary["blocks_added"])
            total_removed += len(msummary["blocks_removed"])

    full_summary = {
        "scope": "FULL",
        "machines_changed": len(by_machine),
        "total_blocks_shifted": total_shifted,
        "total_blocks_added": total_added,
        "total_blocks_removed": total_removed,
        "by_machine": by_machine,
    }
    superseded_id = find_superseded_run_id(con, schedule_run_id, None, "FULL")
    if superseded_id:
        write_change_summary(con, superseded_id, full_summary)


def refresh_block_group_label(con, group_id):
    group_id = int(group_id or 0)
    if not group_id:
        return ""
    members = rows(
        con.execute(
            """
            SELECT b.block_id, b.queue_position, o.operation_name, o.source_op_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.group_id = %s
            ORDER BY b.queue_position, b.block_id
            """,
            (group_id,),
        )
    )
    label = " + ".join(
        compact_text(row["source_op_no"] or row["operation_name"] or f"Block {row['block_id']}")
        for row in members
        if compact_text(row["source_op_no"] or row["operation_name"])
    )
    if " + " in label:
        label = " & ".join(part.strip() for part in label.split(" + ") if part.strip())
    if not label:
        label = "Combined"
    con.execute(
        "UPDATE planner_run_block_group SET group_label = %s WHERE group_id = %s",
        (label, group_id),
    )
    return label
