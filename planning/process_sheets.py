"""
planning/process_sheets.py — Process Sheets API blueprint (PostgreSQL port).

Key SQL adaptations from Vanessa's SQLite version:
  - process_sheet        → planner_process_sheet  (planner_ps_id aliased as ps_id)
  - parts JOIN           → pp_vouchers_cache JOIN  (ERP sync table)
  - bom_variation        → planner_bom_variation   (inventory_code, not part_id)
  - operation_seq        → planner_operation_seq
  - operation            → planner_operation
  - run_block            → planner_run_block        (active BOOLEAN, not INTEGER)
  - run_block_segment    → planner_run_block_segment
  - production_actual    → planner_production_actual
  - machines             → planner_machines         (machine_no aliased as machine_code)
  - planning_card        → planner_planning_card    (planner_ps_id FK)
  - material_requirement → planner_material_requirement
  - IN (?,?,...) with individual ? → = ANY(%s) with list parameter
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, jsonify, request

from db import planner_db_connect_error
from .helpers import one, rows, planner_db
from .materials import material_requirement_payload, material_status_map_for_ps_ids
from .utils import compact_text, shipped_quantity_completed

process_sheets_bp = Blueprint("planner_process_sheets", __name__)


def _to_float(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _operation_key(source_op_seq_id, source_op_no):
    return (int(source_op_seq_id or 0), compact_text(source_op_no))


def _display_ids(ps):
    ps_id = compact_text(ps.get("ps_id") or ps.get("planner_ps_id"))
    source_ps_id = compact_text(ps.get("source_ps_id"))
    pp_partial_no = compact_text(ps.get("pp_partial_no"))
    if not source_ps_id and "::" in ps_id:
        source_ps_id, pp_partial_no = ps_id.rsplit("::", 1)
    return source_ps_id or ps_id, pp_partial_no


def _planner_ps_identity(ps_id):
    source_ps_id, pp_partial_no = parse_planner_ps_id(ps_id)
    planner_ps_id = format_planner_ps_id(source_ps_id, pp_partial_no)
    return source_ps_id, int(pp_partial_no), planner_ps_id


def _operation_belongs_to_planner_ps(op_source_ps_id, op_job_no, planner_ps_id):
    target_source, target_partial, _ = _planner_ps_identity(planner_ps_id)
    for candidate in (compact_text(op_source_ps_id), compact_text(op_job_no)):
        if not candidate:
            continue
        cand_source, cand_partial = parse_planner_ps_id(candidate)
        if cand_source == target_source and int(cand_partial) == int(target_partial):
            return True
    return False


def parse_planner_ps_id(planner_ps_id):
    """Split planner_ps_id into (source_ps_id, pp_partial_no)."""
    raw = compact_text(planner_ps_id)
    if not raw:
        return "", 1
    if "::" not in raw:
        return raw, 1
    base, partial_text = raw.split("::", 1)
    try:
        partial_no = int(partial_text)
    except (TypeError, ValueError):
        partial_no = 1
    return base or raw, max(1, partial_no)


def format_planner_ps_id(source_ps_id, pp_partial_no=1):
    """Canonical planner_ps_id / catalog ps_id (suffix only when partial > 1)."""
    source_ps_id = compact_text(source_ps_id)
    try:
        partial_no = max(1, int(pp_partial_no or 1))
    except (TypeError, ValueError):
        partial_no = 1
    if not source_ps_id:
        return ""
    if partial_no > 1:
        return f"{source_ps_id}::{partial_no}"
    return source_ps_id


def _ensure_planner_overlay_columns(con):
    """Apply overlay-column migrations on demand when they have not been added yet."""
    try:
        con.execute(
            """
            ALTER TABLE planner_process_sheet
            ADD COLUMN IF NOT EXISTS coway_proposed_edd DATE
            """
        )
        con.execute(
            """
            ALTER TABLE planner_process_sheet
            ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT ''
            """
        )
    except Exception:
        pass


def _ensure_coway_proposed_edd_column(con):
    _ensure_planner_overlay_columns(con)


def ensure_planner_process_sheet(con, planner_ps_id):
    """Ensure a planner_process_sheet row exists for an ERP-sourced ps id.

    The trial catalog sidebar reads pp_vouchers_cache directly; scheduling writes
    planner_planning_card rows that FK to planner_process_sheet. Materialize on demand.
    """
    planner_ps_id = compact_text(planner_ps_id)
    if not planner_ps_id:
        return None

    existing = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if existing:
        return existing

    source_ps_id, pp_partial_no = parse_planner_ps_id(planner_ps_id)
    cache_row = one(
        con.execute(
            """
            SELECT ps_id, pp_partial_no, part_no, bom_code, total_qty, partial_qty, status
            FROM pp_vouchers_cache
            WHERE ps_id = %s AND pp_partial_no = %s
            LIMIT 1
            """,
            (source_ps_id, pp_partial_no),
        )
    )
    if not cache_row and source_ps_id != planner_ps_id:
        cache_row = one(
            con.execute(
                """
                SELECT ps_id, pp_partial_no, part_no, bom_code, total_qty, partial_qty, status
                FROM pp_vouchers_cache
                WHERE ps_id = %s AND pp_partial_no = 1
                LIMIT 1
                """,
                (planner_ps_id,),
            )
        )
        if cache_row:
            source_ps_id = compact_text(cache_row["ps_id"]) or planner_ps_id
            pp_partial_no = int(cache_row.get("pp_partial_no") or 1)

    if not cache_row:
        raise ValueError(
            f"Process sheet {planner_ps_id} was not found in ERP cache. Sync ERP and try again."
        )

    inventory_code = compact_text(cache_row.get("part_no"))
    selected_bom_id = None
    bom_code = compact_text(cache_row.get("bom_code"))
    if inventory_code and bom_code:
        flow = one(
            con.execute(
                """
                SELECT bom_id FROM planner_bom_variation
                WHERE inventory_code = %s AND bom_code = %s
                LIMIT 1
                """,
                (inventory_code, bom_code),
            )
        )
        if flow:
            selected_bom_id = int(flow["bom_id"])
    if not selected_bom_id and inventory_code:
        flow = one(
            con.execute(
                """
                SELECT bom_id FROM planner_bom_variation
                WHERE inventory_code = %s
                ORDER BY is_default DESC, bom_id
                LIMIT 1
                """,
                (inventory_code,),
            )
        )
        if flow:
            selected_bom_id = int(flow["bom_id"])

    planned_qty = _to_float(cache_row.get("partial_qty") or cache_row.get("total_qty"))

    con.execute(
        """
        INSERT INTO planner_process_sheet (
          planner_ps_id, source_ps_id, pp_partial_no, inventory_code,
          selected_bom_id, planner_status, status, planned_qty, finished_qty,
          created_at, updated_at
        ) VALUES (%s, %s, %s, %s, %s, 'UNPLANNED', 'ACTIVE', %s, 0, NOW(), NOW())
        ON CONFLICT (planner_ps_id) DO NOTHING
        """,
        (
            planner_ps_id,
            source_ps_id,
            pp_partial_no,
            inventory_code,
            selected_bom_id,
            planned_qty,
        ),
    )
    return one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )


def _flow_steps_for_ps_ids(con, ps_ids):
    from planning.erp_wo_merge import ERP_STAGE_OUTPUTS_CTE

    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}
    result = {}
    for row in rows(
        con.execute(
            f"""
            WITH {ERP_STAGE_OUTPUTS_CTE}
            SELECT ps.planner_ps_id AS ps_id,
                   pfs.op_seq_id, pfs.seq_no, pfs.op_no, pfs.op_type,
                   pfs.machine_category, pfs.preferred_machine,
                   pfs.cycle_time, pfs.setup_time, pfs.is_last_op,
                   pfs.source_stage_no,
                   COALESCE(so.wo_qty_required, 0) AS erp_required_qty,
                   COALESCE(so.wo_qty_produced, 0) AS erp_finished_qty,
                   COALESCE(so.wo_qty_rejected, 0) AS erp_reject_qty,
                   so.execution_status AS erp_execution_status
            FROM planner_process_sheet ps
            JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
            LEFT JOIN erp_stage_outputs so
                   ON so.ps_id = ps.source_ps_id
                  AND so.pp_partial_no = ps.pp_partial_no
                  AND so.stage_no = pfs.source_stage_no
            WHERE ps.planner_ps_id = ANY(%s)
            ORDER BY ps.planner_ps_id, pfs.seq_no, pfs.op_seq_id
            """,
            (ps_ids,),
        )
    ):
        ps_id = compact_text(row.pop("ps_id"))
        result.setdefault(ps_id, []).append(row)
    return result


def _erp_cache_steps_batch(con, partial_keys):
    """Batch-fetch ERP cache steps for many (source_ps_id, pp_partial_no) pairs."""
    from planning.erp_wo_merge import ERP_CACHE_STEPS_SELECT, ERP_CACHE_STEPS_WHERE_PARTIALS

    keys = []
    for source_ps_id, pp_partial_no in partial_keys or []:
        source_ps_id = compact_text(source_ps_id)
        if not source_ps_id:
            continue
        try:
            partial = int(pp_partial_no or 1)
        except (TypeError, ValueError):
            partial = 1
        keys.append((source_ps_id, partial))
    if not keys:
        return {}

    values_sql = ", ".join(["(%s, %s)"] * len(keys))
    params = [part for pair in keys for part in pair]
    grouped: dict[tuple[str, int], list] = {}
    for row in rows(
        con.execute(
            ERP_CACHE_STEPS_SELECT + ERP_CACHE_STEPS_WHERE_PARTIALS.format(values_sql=values_sql),
            params,
        )
    ):
        cache_key = (compact_text(row.get("ps_id")), int(row.get("pp_partial_no") or 1))
        grouped.setdefault(cache_key, []).append(row)

    out = {}
    for cache_key, cache_rows in grouped.items():
        steps = []
        for idx, row in enumerate(cache_rows):
            stage_desc = compact_text(row.get("stage_desc"))
            stage_no = int(row.get("stage_no") or 0)
            op_no = compact_text(row.get("op_no")) or (str(stage_no) if stage_no else str(idx + 1))
            op_type = stage_desc.split()[0] if stage_desc else ""
            steps.append(
                {
                    "op_seq_id": stage_no or idx + 1,
                    "seq_no": idx + 1,
                    "op_no": op_no,
                    "op_type": op_type,
                    "machine_category": op_type.upper(),
                    "preferred_machine": "",
                    "cycle_time": 0,
                    "setup_time": 0,
                    "is_last_op": 0,
                    "source_stage_no": stage_no,
                    "erp_required_qty": row.get("wo_qty_required"),
                    "erp_finished_qty": row.get("wo_qty_produced"),
                    "erp_reject_qty": row.get("wo_qty_rejected"),
                    "erp_execution_status": row.get("execution_status"),
                }
            )
        out[cache_key] = steps
    return out


def _erp_cache_steps_for_ps(con, source_ps_id, pp_partial_no):
    """BOM flow steps from pp_vouchers_cache when no planner_operation_seq is selected."""
    from planning.erp_wo_merge import ERP_CACHE_STEPS_SELECT, ERP_CACHE_STEPS_WHERE_SINGLE

    source_ps_id = compact_text(source_ps_id)
    if not source_ps_id:
        return []
    try:
        pp_partial_no = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1

    steps = []
    for idx, row in enumerate(
        rows(
            con.execute(
                ERP_CACHE_STEPS_SELECT + ERP_CACHE_STEPS_WHERE_SINGLE,
                (source_ps_id, pp_partial_no),
            )
        )
    ):
        stage_desc = compact_text(row.get("stage_desc"))
        stage_no = int(row.get("stage_no") or 0)
        op_no = compact_text(row.get("op_no")) or (str(stage_no) if stage_no else str(idx + 1))
        op_type = stage_desc.split()[0] if stage_desc else ""
        steps.append(
            {
                "op_seq_id": stage_no or idx + 1,
                "seq_no": idx + 1,
                "op_no": op_no,
                "op_type": op_type,
                "machine_category": op_type.upper(),
                "preferred_machine": "",
                "cycle_time": 0,
                "setup_time": 0,
                "is_last_op": 0,
                "source_stage_no": stage_no,
                "erp_required_qty": row.get("wo_qty_required"),
                "erp_finished_qty": row.get("wo_qty_produced"),
                "erp_reject_qty": row.get("wo_qty_rejected"),
                "erp_execution_status": row.get("execution_status"),
            }
        )
    return steps


def _scheduled_ops_as_steps(con, planner_ps_id):
    """Planner operations created by scheduling when BOM flow steps are absent."""
    planner_ps_id = compact_text(planner_ps_id)
    if not planner_ps_id:
        return []

    steps = []
    for idx, row in enumerate(
        rows(
            con.execute(
                """
                SELECT operation_id, operation_name, source_op_no, source_op_seq_id,
                       total_qty, compatible_machine_group
                FROM planner_operation
                WHERE source_ps_id = %s
                  AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
                ORDER BY source_op_seq_id, source_op_no, operation_id
                """,
                (planner_ps_id,),
            )
        )
    ):
        op_no = compact_text(row.get("source_op_no")) or compact_text(row.get("operation_name"))
        op_name = compact_text(row.get("operation_name")) or op_no
        group = compact_text(row.get("compatible_machine_group"))
        steps.append(
            {
                "op_seq_id": int(row.get("source_op_seq_id") or row.get("operation_id") or idx + 1),
                "seq_no": idx + 1,
                "op_no": op_no or str(idx + 1),
                "op_type": op_name,
                "machine_category": group.upper() if group else "",
                "preferred_machine": "",
                "cycle_time": 0,
                "setup_time": 0,
                "is_last_op": 0,
                "source_stage_no": int(row.get("source_op_seq_id") or 0),
                "erp_required_qty": row.get("total_qty"),
                "erp_finished_qty": 0,
                "erp_reject_qty": 0,
                "erp_execution_status": "",
            }
        )
    return steps


def _resolve_process_sheet_steps(con, ps, flow_steps, erp_steps_cache=None):
    if flow_steps:
        return flow_steps
    source_ps_id, pp_partial_no = _display_ids(ps)
    try:
        partial_int = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        partial_int = 1
    cache_key = (compact_text(source_ps_id), partial_int)
    if erp_steps_cache is not None and cache_key in erp_steps_cache:
        erp_steps = erp_steps_cache[cache_key]
    else:
        erp_steps = _erp_cache_steps_for_ps(con, source_ps_id, pp_partial_no)
    if erp_steps:
        return erp_steps
    planner_ps_id = compact_text(ps.get("ps_id") or ps.get("planner_ps_id"))
    return _scheduled_ops_as_steps(con, planner_ps_id)


def _block_metrics_for_ps_ids(con, ps_ids):
    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}, {}
    source_ids = set()
    for ps_id in ps_ids:
        source_ps_id, _, _ = _planner_ps_identity(ps_id)
        source_ids.add(source_ps_id)
        source_ids.add(ps_id)
    metrics = {ps_id: {"by_op": {}, "machines": set(), "queued_machine_map": {},
                       "planned_qty_total": 0.0, "finished_qty_total": 0.0,
                       "reject_qty_total": 0.0, "expected_start": "", "expected_end": ""}
               for ps_id in ps_ids}
    block_rows = {ps_id: [] for ps_id in ps_ids}
    for row in rows(
        con.execute(
            """
            WITH actual_by_block AS (
                SELECT
                    block_id,
                    COALESCE(SUM(COALESCE(output_qty, 0)), 0) AS output_qty,
                    COALESCE(SUM(COALESCE(reject_qty, 0)), 0) AS reject_qty,
                    COALESCE(SUM(COALESCE(output_qty, 0) - COALESCE(reject_qty, 0)), 0) AS good_qty,
                    COUNT(actual_id) AS actual_report_count
                FROM planner_production_actual
                WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
                GROUP BY block_id
            ),
            segment_bounds AS (
                SELECT
                    block_id,
                    MIN(CASE WHEN segment_type = 'production' THEN start_datetime END) AS expected_start,
                    MAX(CASE WHEN segment_type = 'production' THEN end_datetime END) AS expected_end
                FROM planner_run_block_segment
                GROUP BY block_id
            )
            SELECT o.source_ps_id, o.job_no, o.source_op_seq_id, o.source_op_no,
                   b.block_id, b.operation_id, b.machine_id, b.queue_position,
                   b.scheduled_qty, b.status, b.planning_status, b.execution_status,
                   b.calculated_start_datetime, b.calculated_end_datetime,
                   b.anchor_datetime, b.remarks,
                   m.machine_no AS machine_code,
                   m.machine_category,
                   COALESCE(ab.output_qty, 0) AS output_qty,
                   COALESCE(ab.reject_qty, 0) AS reject_qty,
                   COALESCE(ab.good_qty, 0) AS good_qty,
                   COALESCE(ab.actual_report_count, 0) AS actual_report_count,
                   sb.expected_start,
                   sb.expected_end
            FROM planner_operation o
            JOIN planner_run_block b ON b.operation_id = o.operation_id
            LEFT JOIN planner_machines m ON m.machine_id = b.machine_id
            LEFT JOIN actual_by_block ab ON ab.block_id = b.block_id
            LEFT JOIN segment_bounds sb ON sb.block_id = b.block_id
            WHERE o.source_ps_id = ANY(%s)
              AND b.active = TRUE
              AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
            ORDER BY o.source_ps_id, o.source_op_seq_id, o.source_op_no,
                     b.queue_position, b.block_id
            """,
            (list(source_ids),),
        )
    ):
        matched_ps_id = ""
        for planner_ps_id in ps_ids:
            if _operation_belongs_to_planner_ps(
                row.get("source_ps_id"),
                row.get("job_no"),
                planner_ps_id,
            ):
                matched_ps_id = planner_ps_id
                break
        if not matched_ps_id:
            continue
        key = _operation_key(row["source_op_seq_id"], row["source_op_no"])
        entry = metrics[matched_ps_id]
        op_entry = entry["by_op"].setdefault(
            key,
            {"planned_qty": 0.0, "finished_qty": 0.0, "reject_qty": 0.0,
             "actual_report_count": 0, "expected_start": "", "expected_end": "",
             "block_count": 0, "machines": set()},
        )
        scheduled_qty = _to_float(row["scheduled_qty"])
        good_qty = _to_float(row["good_qty"])
        reject_qty = _to_float(row["reject_qty"])
        actual_report_count = int(row.get("actual_report_count") or 0)
        op_entry["planned_qty"] += scheduled_qty
        op_entry["finished_qty"] += good_qty
        op_entry["reject_qty"] += reject_qty
        op_entry["actual_report_count"] += actual_report_count
        op_entry["block_count"] += 1
        machine_code = compact_text(row.get("machine_code"))
        machine_category = compact_text(row.get("machine_category"))
        if machine_code:
            op_entry["machines"].add(machine_code)
            entry["machines"].add(machine_code)
            entry["queued_machine_map"][machine_code] = machine_category or entry["queued_machine_map"].get(machine_code, "")
        start_text = compact_text(row.get("expected_start") or row.get("calculated_start_datetime") or "")
        end_text = compact_text(row.get("expected_end") or row.get("calculated_end_datetime") or "")
        if start_text and (not op_entry["expected_start"] or start_text < op_entry["expected_start"]):
            op_entry["expected_start"] = start_text
        if end_text and (not op_entry["expected_end"] or end_text > op_entry["expected_end"]):
            op_entry["expected_end"] = end_text
        if start_text and (not entry["expected_start"] or start_text < entry["expected_start"]):
            entry["expected_start"] = start_text
        if end_text and (not entry["expected_end"] or end_text > entry["expected_end"]):
            entry["expected_end"] = end_text
        block_rows[matched_ps_id].append(row)
    for ps_id, entry in metrics.items():
        entry["planned_qty_total"] = sum(op["planned_qty"] for op in entry["by_op"].values())
        entry["finished_qty_total"] = sum(op["finished_qty"] for op in entry["by_op"].values())
        entry["reject_qty_total"] = sum(op["reject_qty"] for op in entry["by_op"].values())
        entry["queued_machines"] = sorted(entry.pop("machines", set()))
        machine_map = entry.pop("queued_machine_map", {})
        entry["queued_machine_details"] = [
            {
                "machine_code": code,
                "machine_category": compact_text(machine_map.get(code)),
            }
            for code in entry["queued_machines"]
        ]
        for op_entry in entry["by_op"].values():
            op_entry["queued_machines"] = sorted(op_entry.pop("machines", set()))
    return metrics, block_rows


def _last_operation_steps(steps):
    last_steps = [step for step in steps if bool(step.get("is_last_op"))]
    if last_steps:
        return last_steps
    if not steps:
        return []
    return [max(steps, key=lambda s: (int(s.get("seq_no") or 0), int(s.get("op_seq_id") or 0)))]


def _summary_quantities(total_qty, steps, metrics):
    by_op = metrics.get("by_op", {})
    total_qty = _to_float(total_qty)
    last_steps = _last_operation_steps(steps)
    preferred_keys = [_operation_key(s.get("op_seq_id"), s.get("op_no")) for s in last_steps]
    selected = [by_op[k] for k in preferred_keys if k in by_op]
    if selected:
        planned_qty = sum(_to_float(op["planned_qty"]) for op in selected)
        finished_qty = sum(_to_float(op["finished_qty"]) for op in selected)
        reject_qty = sum(_to_float(op["reject_qty"]) for op in selected)
    else:
        planned_qty = max([_to_float(op["planned_qty"]) for op in by_op.values()] or [0.0])
        finished_qty = max([_to_float(op["finished_qty"]) for op in by_op.values()] or [0.0])
        reject_qty = sum(_to_float(op["reject_qty"]) for op in by_op.values())
    planned_qty = min(total_qty, planned_qty) if total_qty > 0 else planned_qty
    finished_qty = min(total_qty, finished_qty) if total_qty > 0 else finished_qty
    return planned_qty, finished_qty, reject_qty, max(0.0, total_qty - finished_qty)


def _planner_status(ps, total_qty, planned_qty, finished_qty, step_count):
    status = compact_text(ps.get("planner_status")).upper()
    if status:
        return status
    if finished_qty >= _to_float(total_qty) and _to_float(total_qty) > 0:
        return "COMPLETED"
    if planned_qty <= 0:
        return "NEEDS_REVIEW" if step_count <= 0 else "UNPLANNED"
    if planned_qty < _to_float(total_qty):
        return "PARTIALLY_PLANNED"
    return "PLANNED"


def _execution_status_completed(value):
    return compact_text(value).upper().replace("-", "_").replace(" ", "_") in {"C", "COMPLETED"}


def _tracked_stage_statuses(ops):
    return [
        compact_text(op.get("execution_status"))
        for op in ops
        if compact_text(op.get("execution_status"))
    ]


def _route_label(ps):
    erp = compact_text(ps.get("erp_bom_code"))
    selected = compact_text(ps.get("selected_flow_code"))
    if erp and selected:
        if erp.upper() == selected.upper():
            return erp
        return f"ERP {erp} · Planner {selected}"
    if erp:
        return f"ERP {erp}"
    if selected:
        return selected
    return "No flow selected"


def _warnings(ps, is_completed, material_status):
    warnings = []
    due_date = compact_text(ps.get("due_date"))
    if due_date and due_date < date.today().isoformat() and not is_completed:
        warnings.append("OVERDUE")
    if not int(ps.get("selected_bom_id") or 0):
        warnings.append("NO_FLOW")
    severity = compact_text((material_status or {}).get("severity"))
    if severity in {"late", "warning", "pending"}:
        warnings.append("MATERIAL")
    return warnings


def _process_sheet_payload(ps, steps, metrics, material_status):
    raw_planned_qty = _to_float(metrics.get("planned_qty_total"))
    raw_finished_qty = _to_float(metrics.get("finished_qty_total"))
    source_total_qty = _to_float(ps.get("total_qty") or ps.get("planned_qty"))
    partial_qty = _to_float(ps.get("partial_qty"))
    erp_required_qty = _to_float(ps.get("wo_qty_required"))
    display_qty = partial_qty or source_total_qty
    total_qty = display_qty
    planned_qty, finished_qty, reject_qty, remaining_qty = _summary_quantities(
        total_qty, steps, metrics
    )
    erp_finished_qty = _to_float(ps.get("wo_qty_produced"))
    erp_reject_qty = _to_float(ps.get("wo_qty_rejected"))
    planner_status = _planner_status(ps, total_qty, planned_qty, finished_qty, len(steps))
    ops = [_step_payload(step, metrics.get("by_op", {}), total_qty) for step in steps]
    tracked_statuses = _tracked_stage_statuses(ops)
    if not tracked_statuses and compact_text(ps.get("execution_status")):
        tracked_statuses = [compact_text(ps.get("execution_status"))]
    if steps:
        execution_completed = all(
            _execution_status_completed(compact_text(step.get("erp_execution_status") or ""))
            for step in steps
        )
    elif ps.get("execution_completed") is not None:
        execution_completed = bool(ps.get("execution_completed"))
    else:
        execution_completed = bool(tracked_statuses) and all(
            _execution_status_completed(status) for status in tracked_statuses
        )
    if erp_finished_qty > 0 and execution_completed:
        finished_qty = max(finished_qty, min(total_qty, erp_finished_qty) if total_qty > 0 else erp_finished_qty)
        reject_qty = max(reject_qty, erp_reject_qty)
        remaining_qty = max(0.0, total_qty - finished_qty)
    so_qty = ps.get("so_det_qty")
    qty_shipped = _to_float(ps.get("qty_shipped"))
    has_partial_erp_evidence = bool(
        compact_text(ps.get("current_stage_status"))
        or execution_completed
        or any(compact_text(step.get("erp_execution_status")) for step in (steps or []))
    )
    partial_shipped_completed = (
        has_partial_erp_evidence
        and total_qty > 0
        and qty_shipped >= (total_qty - 0.0001)
    )
    shipped_completed = partial_shipped_completed or (
        so_qty is not None
        and shipped_quantity_completed(so_qty, ps.get("qty_shipped"))
    )
    qty_tolerance = 0.0001
    if steps:
        production_completed = execution_completed
    else:
        production_completed = (
            (total_qty > 0 and finished_qty >= (total_qty - qty_tolerance))
            or (execution_completed and remaining_qty <= qty_tolerance)
        )
    is_completed = shipped_completed or production_completed
    display_ps_id, pp_partial_no = _display_ids(ps)
    queued_machines = list(metrics.get("queued_machines") or [])
    queued_machine_details = list(metrics.get("queued_machine_details") or [])
    is_queued = bool(queued_machines) or raw_planned_qty > 0
    return {
        "ps_id": ps.get("ps_id") or ps.get("planner_ps_id"),
        "source_ps_id": compact_text(ps.get("source_ps_id")) or display_ps_id,
        "pp_partial_no": pp_partial_no,
        "display_ps_id": display_ps_id,
        "part_id": 0,
        "inventory_code": compact_text(ps.get("inventory_code") or ""),
        "part_name": compact_text(ps.get("part_no") or ps.get("part_name") or ""),
        "part_no": compact_text(ps.get("part_no") or ""),
        "part_desc": compact_text(ps.get("part_desc") or ps.get("description") or ""),
        "due_date": compact_text(ps.get("due_date") or ""),
        "coway_proposed_edd": compact_text(ps.get("coway_proposed_edd") or ""),
        "remarks": compact_text(ps.get("remarks") or ""),
        "order_date": compact_text(ps.get("order_date") or ""),
        "total_qty": source_total_qty,
        "partial_qty": partial_qty,
        "wo_req_qty": partial_qty,
        "total_wo_qty": source_total_qty,
        "display_qty": display_qty,
        "wo_qty_required": erp_required_qty,
        "status": compact_text(ps.get("status") or ""),
        "execution_status": compact_text(ps.get("execution_status") or ""),
        "planner_status": planner_status,
        "execution_completed": execution_completed,
        "production_completed": production_completed,
        "shipped_completed": shipped_completed,
        "is_completed": is_completed,
        "selected_bom_id": int(ps.get("selected_bom_id") or 0),
        "selected_flow_code": compact_text(ps.get("selected_flow_code") or ""),
        "erp_bom_code": compact_text(ps.get("erp_bom_code") or ""),
        "route_label": _route_label(ps),
        "planned_qty": planned_qty,
        "finished_qty": finished_qty,
        "reject_qty": reject_qty,
        "remaining_qty": remaining_qty,
        "output_debug": {
            "total_qty": total_qty,
            "raw_planned_qty": raw_planned_qty,
            "raw_finished_qty": raw_finished_qty,
            "erp_required_qty": erp_required_qty,
            "erp_finished_qty": erp_finished_qty,
            "erp_reject_qty": erp_reject_qty,
            "displayed_planned_qty": planned_qty,
            "displayed_finished_qty": finished_qty,
        },
        "expected_start": metrics.get("expected_start", ""),
        "expected_end": metrics.get("expected_end", ""),
        "is_queued": is_queued,
        "queued_machines": queued_machines,
        "queued_machine_details": queued_machine_details,
        "warnings": _warnings(ps, is_completed, material_status),
        "material_status": material_status,
        "source_voucher_no": compact_text(ps.get("source_voucher_no") or ""),
        "qty_shipped": _to_float(ps.get("qty_shipped")),
        "so_det_qty": _to_float(ps.get("so_det_qty")) if ps.get("so_det_qty") is not None else None,
        "current_stage_no": int(ps.get("current_stage_no") or 0),
        "current_stage_desc": compact_text(ps.get("current_stage_desc") or ""),
        "current_stage_status": compact_text(ps.get("current_stage_status") or ""),
        "ops": ops,
    }


def _step_payload(step, metrics_by_op, work_qty=0):
    key = _operation_key(step.get("op_seq_id"), step.get("op_no"))
    op_metrics = metrics_by_op.get(key, {})
    work_qty = _to_float(work_qty)
    erp_stage_req = _to_float(step.get("erp_required_qty"))
    # Stage-level ERP wo_qty_required is often the full WO; partial work uses partial_qty.
    if work_qty > 0:
        total_qty = work_qty
    elif erp_stage_req > 0:
        total_qty = erp_stage_req
    else:
        total_qty = _to_float(step.get("total_qty"))
    planned_qty = _to_float(op_metrics.get("planned_qty"))
    finished_qty = max(_to_float(op_metrics.get("finished_qty")), _to_float(step.get("erp_finished_qty")))
    reject_qty = max(_to_float(op_metrics.get("reject_qty")), _to_float(step.get("erp_reject_qty")))
    queued_machines = list(op_metrics.get("queued_machines") or [])
    machine_code = queued_machines[0] if queued_machines else ""
    return {
        "op_seq_id": int(step.get("op_seq_id") or 0),
        "seq_no": int(step.get("seq_no") or 0),
        "op_no": step.get("op_no") or "",
        "op_type": step.get("op_type") or "",
        "machine_category": step.get("machine_category") or "",
        "preferred_machine": step.get("preferred_machine") or "",
        "cycle_time": _to_float(step.get("cycle_time")),
        "setup_time": _to_float(step.get("setup_time")),
        "is_last_op": int(bool(step.get("is_last_op"))),
        "stage_no": int(step.get("source_stage_no") or 0),
        "execution_status": compact_text(step.get("erp_execution_status") or ""),
        "required_qty": total_qty,
        "wo_qty_required": total_qty,
        "wo_qty_produced": _to_float(step.get("erp_finished_qty")),
        "wo_qty_rejected": _to_float(step.get("erp_reject_qty")),
        "planned_qty": planned_qty,
        "finished_qty": finished_qty,
        "reject_qty": reject_qty,
        "remaining_qty": max(0.0, total_qty - finished_qty) if total_qty else 0.0,
        "expected_start": op_metrics.get("expected_start", ""),
        "expected_end": op_metrics.get("expected_end", ""),
        "block_count": int(op_metrics.get("block_count") or 0),
        "machine_code": machine_code,
        "queued_machines": queued_machines,
    }


def _apply_partial_shipped_rollup(rows):
    """Allocate shipped qty across partials of the same source PS in order."""
    if not rows:
        return
    qty_tolerance = 0.0001
    by_source = {}
    for row in rows:
        source = compact_text(row.get("source_ps_id") or row.get("display_ps_id") or row.get("ps_id"))
        if not source:
            continue
        by_source.setdefault(source.split("::", 1)[0], []).append(row)

    for source_rows in by_source.values():
        source_rows.sort(key=lambda item: int(item.get("pp_partial_no") or 1))
        shipped_total = max(_to_float(item.get("qty_shipped")) for item in source_rows)
        shipped_left = max(0.0, shipped_total)
        for item in source_rows:
            req_qty = max(0.0, _to_float(item.get("display_qty") or item.get("wo_req_qty") or item.get("partial_qty")))
            if req_qty <= 0:
                continue
            covered_qty = min(req_qty, shipped_left)
            shipped_left = max(0.0, shipped_left - covered_qty)
            if covered_qty + qty_tolerance < req_qty:
                continue
            production_done = bool(item.get("production_completed")) or bool(item.get("execution_completed"))
            if not production_done:
                continue
            item["finished_qty"] = max(_to_float(item.get("finished_qty")), req_qty)
            item["remaining_qty"] = 0.0
            item["shipped_completed"] = True
            item["is_completed"] = True


def _ps_select_sql():
    from planning.erp_wo_merge import ERP_STAGE_OUTPUTS_CTE

    return f"""
    WITH {ERP_STAGE_OUTPUTS_CTE},
    voucher_partials AS (
        SELECT
            c.ps_id,
            c.pp_partial_no,
            MAX(c.part_no) AS part_no,
            MAX(c.description) AS description,
            MIN(c.due_date) AS due_date,
            MIN(c.order_date) AS order_date,
            MAX(c.bom_code) AS bom_code,
            MAX(c.status) AS status,
            MAX(COALESCE(e.execution_status, c.execution_status)) AS execution_status,
            MAX(c.total_qty) AS total_qty,
            MAX(c.partial_qty) AS partial_qty,
            MAX(COALESCE(e.wo_qty_required, c.wo_qty_required)) AS wo_qty_required,
            MAX(COALESCE(e.wo_qty_produced, c.wo_qty_produced)) AS wo_qty_produced,
            MAX(COALESCE(e.wo_qty_rejected, c.wo_qty_rejected)) AS wo_qty_rejected,
            MAX(c.source_voucher_no) AS source_voucher_no,
            MAX(c.qty_shipped) AS qty_shipped,
            MAX(c.so_det_qty) AS so_det_qty,
            MAX(c.current_stage_no) AS current_stage_no,
            MAX(c.current_stage_desc) AS current_stage_desc,
            MAX(c.current_stage_status) AS current_stage_status,
            COALESCE(
                BOOL_AND(
                    CASE
                        WHEN NULLIF(TRIM(COALESCE(e.execution_status, c.execution_status)), '') IS NULL THEN NULL
                        ELSE UPPER(REPLACE(REPLACE(COALESCE(e.execution_status, c.execution_status), '-', '_'), ' ', '_')) IN ('C', 'COMPLETED')
                    END
                ),
                FALSE
            ) AS execution_completed
        FROM pp_vouchers_cache c
        LEFT JOIN erp_stage_outputs e
               ON e.ps_id = c.ps_id
              AND e.pp_partial_no = c.pp_partial_no
              AND e.stage_no = c.stage_no
        GROUP BY c.ps_id, c.pp_partial_no
    )
    SELECT
        ps.planner_ps_id AS ps_id,
        ps.source_ps_id,
        ps.pp_partial_no,
        ps.inventory_code,
        ps.selected_bom_id,
        ps.planner_status,
        ps.status,
        ps.planned_qty,
        ps.finished_qty,
        ps.coway_proposed_edd,
        ps.remarks,
        ps.created_at,
        ps.updated_at,
        v.total_qty,
        v.partial_qty,
        v.wo_qty_required,
        v.wo_qty_produced,
        v.wo_qty_rejected,
        v.execution_completed,
        v.execution_status,
        v.due_date,
        v.order_date,
        v.part_no,
        v.part_no         AS part_name,
        v.description     AS part_desc,
        sf.bom_code       AS selected_flow_code,
        sf.bom_desc       AS selected_flow_name,
        v.bom_code        AS erp_bom_code,
        v.source_voucher_no,
        v.qty_shipped,
        v.so_det_qty,
        v.current_stage_no,
        v.current_stage_desc,
        v.current_stage_status
    FROM planner_process_sheet ps
    LEFT JOIN voucher_partials v
           ON v.ps_id = ps.source_ps_id
          AND v.pp_partial_no = ps.pp_partial_no
    LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
"""


_PS_SELECT = _ps_select_sql()


def _erp_wo_completion_map(con, source_ps_ids):
    """True per (source_ps_id, pp_partial_no) when every synced ERP WO stage is Completed."""
    ids = [compact_text(ps_id) for ps_id in source_ps_ids if compact_text(ps_id)]
    if not ids:
        return {}
    out = {}
    for row in rows(
        con.execute(
            """
            SELECT source_mps_no, pp_partial_no,
                   BOOL_AND(COALESCE(execution_status, '') = 'C') AS all_complete,
                   COUNT(*)::INTEGER AS stage_count
            FROM mfg_wo_status
            WHERE source_mps_no = ANY(%s)
            GROUP BY source_mps_no, pp_partial_no
            """,
            (ids,),
        )
    ):
        key = (compact_text(row["source_mps_no"]), int(row.get("pp_partial_no") or 1))
        stage_count = int(row.get("stage_count") or 0)
        out[key] = stage_count > 0 and bool(row.get("all_complete"))
    return out


def _board_item_source_partial(item):
    """(source_ps_id, pp_partial_no) for board rows — matches process_sheet_board_identity_key."""
    source = compact_text(
        item.get("source_ps_id") or item.get("display_ps_id") or item.get("ps_id") or ""
    ).split("::")[0]
    try:
        partial = int(item.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        partial = 1
    ps_id = compact_text(item.get("ps_id") or "")
    if not item.get("pp_partial_no") and "::" in ps_id:
        try:
            partial = int(ps_id.rsplit("::", 1)[1])
        except ValueError:
            pass
    return source, max(1, partial)


def enrich_board_planner_fields(con, items):
    """Attach planner overlay fields when board rows omit them (common on ERP-only lines)."""
    if not items:
        return items
    _ensure_planner_overlay_columns(con)
    indices_by_key = {}
    source_ids = set()
    for idx, item in enumerate(items):
        source, partial = _board_item_source_partial(item)
        if not source:
            continue
        key = (source, partial)
        indices_by_key.setdefault(key, []).append(idx)
        source_ids.add(source)
    if not source_ids:
        return items
    overlay_by_key = {}
    for row in rows(
        con.execute(
            """
            SELECT source_ps_id, pp_partial_no, coway_proposed_edd, remarks
            FROM planner_process_sheet
            WHERE source_ps_id = ANY(%s)
              AND (
                    coway_proposed_edd IS NOT NULL
                 OR NULLIF(TRIM(remarks), '') IS NOT NULL
              )
            """,
            (list(source_ids),),
        )
    ):
        key = (compact_text(row.get("source_ps_id")), int(row.get("pp_partial_no") or 1))
        overlay_by_key[key] = {
            "coway_proposed_edd": compact_text(row.get("coway_proposed_edd")),
            "remarks": compact_text(row.get("remarks")),
        }
    for key, indices in indices_by_key.items():
        overlay = overlay_by_key.get(key)
        if not overlay:
            continue
        for idx in indices:
            if not compact_text(items[idx].get("coway_proposed_edd")) and overlay["coway_proposed_edd"]:
                items[idx]["coway_proposed_edd"] = overlay["coway_proposed_edd"]
            if not compact_text(items[idx].get("remarks")) and overlay["remarks"]:
                items[idx]["remarks"] = overlay["remarks"]
    return items


def enrich_board_coway_proposed_edd(con, items):
    """Backward-compatible alias for enrich_board_planner_fields."""
    return enrich_board_planner_fields(con, items)


def process_sheet_board_identity_key(item):
    """Match client itemIdentityKey() for planner/ERP row deduplication."""
    source = compact_text(
        item.get("source_ps_id") or item.get("display_ps_id") or item.get("ps_id") or ""
    ).split("::")[0]
    try:
        partial = int(item.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        partial = 1
    ps_id = compact_text(item.get("ps_id") or "")
    if not item.get("pp_partial_no") and "::" in ps_id:
        try:
            partial = int(ps_id.rsplit("::", 1)[1])
        except ValueError:
            pass
    return f"{source}::{partial}"


def list_process_sheets_payload(con):
    _ensure_planner_overlay_columns(con)
    search = compact_text(request.args.get("search")).lower()
    status_filter = compact_text(request.args.get("status")).upper()
    planner_filter = compact_text(request.args.get("planner_status")).upper()
    show_completed = compact_text(request.args.get("show_completed")).lower() in {"1", "true", "yes", "on"}
    overdue_only = compact_text(request.args.get("overdue_only")).lower() in {"1", "true", "yes", "on"}

    ps_rows = [
        dict(row)
        for row in rows(
            con.execute(
                _PS_SELECT + " ORDER BY COALESCE(v.due_date::TEXT, ''), ps.planner_ps_id"
            )
        )
    ]
    ps_ids = [row["ps_id"] for row in ps_rows]
    steps_by_ps = _flow_steps_for_ps_ids(con, ps_ids)
    metrics_by_ps, _ = _block_metrics_for_ps_ids(con, ps_ids)
    material_status_by_ps = material_status_map_for_ps_ids(
        con,
        ps_ids,
        {ps_id: metrics_by_ps.get(ps_id, {}).get("expected_start", "") for ps_id in ps_ids},
    )
    wo_complete_by_partial = _erp_wo_completion_map(
        con,
        {compact_text(row.get("source_ps_id")) for row in ps_rows if compact_text(row.get("source_ps_id"))},
    )

    erp_step_keys = []
    for ps in ps_rows:
        ps_id = compact_text(ps["ps_id"])
        if steps_by_ps.get(ps_id):
            continue
        source_ps_id, pp_partial_no = _display_ids(ps)
        try:
            partial_int = int(pp_partial_no or 1)
        except (TypeError, ValueError):
            partial_int = 1
        if compact_text(source_ps_id):
            erp_step_keys.append((compact_text(source_ps_id), partial_int))
    erp_steps_cache = _erp_cache_steps_batch(con, erp_step_keys)

    result = []
    today = date.today().isoformat()
    for ps in ps_rows:
        ps_id = compact_text(ps["ps_id"])
        steps = _resolve_process_sheet_steps(con, ps, steps_by_ps.get(ps_id, []), erp_steps_cache)
        payload = _process_sheet_payload(
            ps,
            steps,
            metrics_by_ps.get(ps_id, {}),
            material_status_by_ps.get(ps_id, {}),
        )
        wo_key = (compact_text(ps.get("source_ps_id")), int(ps.get("pp_partial_no") or 1))
        if wo_complete_by_partial.get(wo_key):
            payload["erp_all_wo_complete"] = True
        haystack = " ".join(
            compact_text(payload.get(k)).lower()
            for k in ("ps_id", "source_ps_id", "display_ps_id", "pp_partial_no",
                      "part_name", "part_no", "part_desc", "selected_flow_code",
                      "status", "planner_status", "inventory_code")
        )
        if search and search not in haystack:
            continue
        if status_filter and compact_text(payload["status"]).upper() != status_filter:
            continue
        if planner_filter and compact_text(payload["planner_status"]).upper() != planner_filter:
            continue
        if not show_completed and payload["is_completed"]:
            continue
        if overdue_only and not (
            payload["due_date"] and payload["due_date"] < today and not payload["is_completed"]
        ):
            continue
        result.append(payload)
    _apply_partial_shipped_rollup(result)
    return result


def _parse_optional_date_field(value):
    if value is None:
        return None
    text = compact_text(value)
    if not text:
        return None
    if len(text) >= 10:
        text = text[:10]
    try:
        date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("coway_proposed_edd must be YYYY-MM-DD") from exc
    return text


def _update_coway_proposed_edd(con, ps_id, proposed):
    _ensure_coway_proposed_edd_column(con)
    _, _, canonical_ps_id = _planner_ps_identity(ps_id)
    try:
        ensure_planner_process_sheet(con, canonical_ps_id)
    except ValueError as exc:
        return None, str(exc)
    con.execute(
        """
        UPDATE planner_process_sheet
        SET coway_proposed_edd = %s, updated_at = NOW()
        WHERE planner_ps_id = %s
        """,
        (proposed, canonical_ps_id),
    )
    row = one(
        con.execute(
            "SELECT coway_proposed_edd FROM planner_process_sheet WHERE planner_ps_id = %s",
            (canonical_ps_id,),
        )
    )
    return {
        "ps_id": canonical_ps_id,
        "coway_proposed_edd": compact_text((row or {}).get("coway_proposed_edd")),
    }, None


def _update_remarks(con, ps_id, remarks_text):
    _ensure_planner_overlay_columns(con)
    _, _, canonical_ps_id = _planner_ps_identity(ps_id)
    try:
        ensure_planner_process_sheet(con, canonical_ps_id)
    except ValueError as exc:
        return None, str(exc)
    con.execute(
        """
        UPDATE planner_process_sheet
        SET remarks = %s, updated_at = NOW()
        WHERE planner_ps_id = %s
        """,
        (remarks_text, canonical_ps_id),
    )
    row = one(
        con.execute(
            "SELECT remarks FROM planner_process_sheet WHERE planner_ps_id = %s",
            (canonical_ps_id,),
        )
    )
    return {
        "ps_id": canonical_ps_id,
        "remarks": compact_text((row or {}).get("remarks")),
    }, None


@process_sheets_bp.post("/api/trial/process-sheets/coway-proposed-edd")
@process_sheets_bp.post("/api/process-sheets/coway-proposed-edd")
def api_process_sheet_coway_proposed_edd_post():
    data = request.get_json(force=True, silent=True) or {}
    ps_id = compact_text(data.get("ps_id"))
    if not ps_id:
        return jsonify({"error": "ps_id is required"}), 400
    try:
        proposed = _parse_optional_date_field(data.get("coway_proposed_edd"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        with planner_db() as con:
            payload, err = _update_coway_proposed_edd(con, ps_id, proposed)
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.patch("/api/trial/process-sheets/<path:ps_id>/coway-proposed-edd")
@process_sheets_bp.put("/api/trial/process-sheets/<path:ps_id>/coway-proposed-edd")
@process_sheets_bp.patch("/api/process-sheets/<path:ps_id>/coway-proposed-edd")
@process_sheets_bp.put("/api/process-sheets/<path:ps_id>/coway-proposed-edd")
def api_process_sheet_coway_proposed_edd(ps_id):
    ps_id = compact_text(ps_id)
    data = request.get_json(force=True, silent=True) or {}
    try:
        if "coway_proposed_edd" in data:
            raw = data.get("coway_proposed_edd")
        else:
            raw = data.get("value")
        proposed = _parse_optional_date_field(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        with planner_db() as con:
            payload, err = _update_coway_proposed_edd(con, ps_id, proposed)
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.post("/api/trial/process-sheets/remarks")
@process_sheets_bp.post("/api/process-sheets/remarks")
def api_process_sheet_remarks_post():
    data = request.get_json(force=True, silent=True) or {}
    ps_id = compact_text(data.get("ps_id"))
    if not ps_id:
        return jsonify({"error": "ps_id is required"}), 400
    remarks_text = compact_text(data.get("remarks"))
    try:
        with planner_db() as con:
            payload, err = _update_remarks(con, ps_id, remarks_text)
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.patch("/api/trial/process-sheets/<path:ps_id>/remarks")
@process_sheets_bp.put("/api/trial/process-sheets/<path:ps_id>/remarks")
@process_sheets_bp.patch("/api/process-sheets/<path:ps_id>/remarks")
@process_sheets_bp.put("/api/process-sheets/<path:ps_id>/remarks")
def api_process_sheet_remarks(ps_id):
    ps_id = compact_text(ps_id)
    data = request.get_json(force=True, silent=True) or {}
    if "remarks" in data:
        remarks_text = compact_text(data.get("remarks"))
    else:
        remarks_text = compact_text(data.get("value"))
    try:
        with planner_db() as con:
            payload, err = _update_remarks(con, ps_id, remarks_text)
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.get("/api/trial/process-sheets")
@process_sheets_bp.get("/api/process-sheets")
def api_process_sheets():
    try:
        with planner_db() as con:
            return jsonify(list_process_sheets_payload(con))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.get("/api/trial/process-sheets/<path:ps_id>/details")
@process_sheets_bp.get("/api/process-sheets/<path:ps_id>/details")
def api_process_sheet_details(ps_id):
    ps_id = compact_text(ps_id)
    try:
        with planner_db() as con:
            _ensure_coway_proposed_edd_column(con)
            _, _, canonical_ps_id = _planner_ps_identity(ps_id)
            ps = one(
                con.execute(
                    _PS_SELECT + " WHERE ps.planner_ps_id = %s",
                    (canonical_ps_id,),
                )
            )
            if not ps:
                try:
                    ensure_planner_process_sheet(con, canonical_ps_id)
                except ValueError as exc:
                    return jsonify({"error": str(exc)}), 404
                ps = one(
                    con.execute(
                        _PS_SELECT + " WHERE ps.planner_ps_id = %s",
                        (canonical_ps_id,),
                    )
                )
            if not ps:
                return jsonify({"error": "Process sheet not found"}), 404

            source_ps_id, _, _ = _planner_ps_identity(canonical_ps_id)
            steps_by_ps = _flow_steps_for_ps_ids(con, [canonical_ps_id])
            metrics_by_ps, block_rows_by_ps = _block_metrics_for_ps_ids(con, [canonical_ps_id])
            material_status_by_ps = material_status_map_for_ps_ids(
                con,
                [canonical_ps_id],
                {canonical_ps_id: metrics_by_ps.get(canonical_ps_id, {}).get("expected_start", "")},
            )
            steps = _resolve_process_sheet_steps(con, dict(ps), steps_by_ps.get(canonical_ps_id, []))
            summary = _process_sheet_payload(
                dict(ps),
                steps,
                metrics_by_ps.get(canonical_ps_id, {}),
                material_status_by_ps.get(canonical_ps_id, {}),
            )

            segment_rows = rows(
                con.execute(
                    """
                    SELECT s.*, m.machine_no AS machine_code, o.source_ps_id, o.job_no,
                           o.source_op_seq_id, o.source_op_no
                    FROM planner_run_block_segment s
                    JOIN planner_run_block b ON b.block_id = s.block_id
                    JOIN planner_operation o ON o.operation_id = b.operation_id
                    LEFT JOIN planner_machines m ON m.machine_id = s.machine_id
                    WHERE o.source_ps_id = %s
                       OR o.source_ps_id LIKE %s || '::%%'
                    ORDER BY s.start_datetime, s.segment_id
                    """,
                    (source_ps_id, source_ps_id),
                )
            )
            segments = [
                dict(row)
                for row in segment_rows
                if _operation_belongs_to_planner_ps(
                    row.get("source_ps_id"),
                    row.get("job_no"),
                    canonical_ps_id,
                )
            ]

            actual_rows = rows(
                con.execute(
                    """
                    SELECT a.actual_id, a.segment_id, a.block_id, a.report_date,
                           a.output_qty, a.reject_qty, a.target_qty_at_report,
                           a.remarks, a.reported_at,
                           o.source_ps_id, o.job_no, o.source_op_seq_id, o.source_op_no
                    FROM planner_production_actual a
                    JOIN planner_run_block b ON b.block_id = a.block_id
                    JOIN planner_operation o ON o.operation_id = b.operation_id
                    WHERE (o.source_ps_id = %s OR o.source_ps_id LIKE %s || '::%%')
                      AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
                    ORDER BY a.report_date, a.actual_id
                    """,
                    (source_ps_id, source_ps_id),
                )
            )
            actuals = [
                dict(row)
                for row in actual_rows
                if _operation_belongs_to_planner_ps(
                    row.get("source_ps_id"),
                    row.get("job_no"),
                    canonical_ps_id,
                )
            ]
            actuals_by_block = {}
            for row in actuals:
                actuals_by_block.setdefault(int(row.get("block_id") or 0), []).append(row)

            planned_blocks = []
            for block in block_rows_by_ps.get(canonical_ps_id, []):
                item = dict(block)
                item["actuals"] = actuals_by_block.get(int(item.get("block_id") or 0), [])
                planned_blocks.append(item)

            cards = [
                dict(row)
                for row in rows(
                    con.execute(
                        """
                        SELECT *, planner_ps_id AS ps_id
                        FROM planner_planning_card
                        WHERE planner_ps_id = %s
                        ORDER BY card_id
                        """,
                        (canonical_ps_id,),
                    )
                )
            ]

            requirements = [
                material_requirement_payload(row)
                for row in rows(
                    con.execute(
                        """
                        SELECT *, planner_ps_id AS ps_id
                        FROM planner_material_requirement
                        WHERE planner_ps_id = %s
                        ORDER BY requirement_id
                        """,
                        (canonical_ps_id,),
                    )
                )
            ]

            return jsonify({
                "summary": summary,
                "segments": segments,
                "planned_blocks": planned_blocks,
                "cards": cards,
                "requirements": requirements,
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
