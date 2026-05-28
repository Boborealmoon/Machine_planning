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
    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}
    result = {}
    for row in rows(
        con.execute(
            """
            WITH stage_outputs AS (
                SELECT ps_id, pp_partial_no, stage_no,
                       MAX(wo_qty_required) AS wo_qty_required,
                       MAX(wo_qty_produced) AS wo_qty_produced,
                       MAX(wo_qty_rejected) AS wo_qty_rejected,
                       MAX(execution_status) AS execution_status
                FROM pp_vouchers_cache
                WHERE stage_no IS NOT NULL
                GROUP BY ps_id, pp_partial_no, stage_no
            )
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
            LEFT JOIN stage_outputs so
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


def _erp_cache_steps_for_ps(con, source_ps_id, pp_partial_no):
    """BOM flow steps from pp_vouchers_cache when no planner_operation_seq is selected."""
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
                """
                SELECT stage_no, stage_desc, op_no,
                       MAX(wo_qty_required) AS wo_qty_required,
                       MAX(wo_qty_produced) AS wo_qty_produced,
                       MAX(wo_qty_rejected) AS wo_qty_rejected,
                       MAX(execution_status) AS execution_status
                FROM pp_vouchers_cache
                WHERE ps_id = %s
                  AND pp_partial_no = %s
                  AND NULLIF(TRIM(COALESCE(stage_desc, '')), '') IS NOT NULL
                GROUP BY stage_no, stage_desc, op_no
                ORDER BY stage_no, op_no
                """,
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


def _resolve_process_sheet_steps(con, ps, flow_steps):
    if flow_steps:
        return flow_steps
    source_ps_id, pp_partial_no = _display_ids(ps)
    erp_steps = _erp_cache_steps_for_ps(con, source_ps_id, pp_partial_no)
    if erp_steps:
        return erp_steps
    planner_ps_id = compact_text(ps.get("ps_id") or ps.get("planner_ps_id"))
    return _scheduled_ops_as_steps(con, planner_ps_id)


def _block_metrics_for_ps_ids(con, ps_ids):
    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}, {}
    metrics = {}
    block_rows = {}
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
            SELECT o.source_ps_id, o.source_op_seq_id, o.source_op_no,
                   b.block_id, b.operation_id, b.machine_id, b.queue_position,
                   b.scheduled_qty, b.status, b.planning_status, b.execution_status,
                   b.calculated_start_datetime, b.calculated_end_datetime,
                   b.anchor_datetime, b.remarks,
                   m.machine_no AS machine_code,
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
            (ps_ids,),
        )
    ):
        ps_id = compact_text(row["source_ps_id"])
        key = _operation_key(row["source_op_seq_id"], row["source_op_no"])
        entry = metrics.setdefault(
            ps_id,
            {"by_op": {}, "planned_qty_total": 0.0, "finished_qty_total": 0.0,
             "reject_qty_total": 0.0, "expected_start": "", "expected_end": ""},
        )
        op_entry = entry["by_op"].setdefault(
            key,
            {"planned_qty": 0.0, "finished_qty": 0.0, "reject_qty": 0.0,
             "actual_report_count": 0, "expected_start": "", "expected_end": "", "block_count": 0},
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
        block_rows.setdefault(ps_id, []).append(row)
    for ps_id, entry in metrics.items():
        entry["planned_qty_total"] = sum(op["planned_qty"] for op in entry["by_op"].values())
        entry["finished_qty_total"] = sum(op["finished_qty"] for op in entry["by_op"].values())
        entry["reject_qty_total"] = sum(op["reject_qty"] for op in entry["by_op"].values())
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
    if erp_finished_qty > 0:
        finished_qty = max(finished_qty, min(total_qty, erp_finished_qty) if total_qty > 0 else erp_finished_qty)
        reject_qty = max(reject_qty, erp_reject_qty)
        remaining_qty = max(0.0, total_qty - finished_qty)
    planner_status = _planner_status(ps, total_qty, planned_qty, finished_qty, len(steps))
    ops = [_step_payload(step, metrics.get("by_op", {})) for step in steps]
    tracked_statuses = _tracked_stage_statuses(ops)
    if not tracked_statuses and compact_text(ps.get("execution_status")):
        tracked_statuses = [compact_text(ps.get("execution_status"))]
    if ps.get("execution_completed") is not None:
        execution_completed = bool(ps.get("execution_completed"))
    else:
        execution_completed = bool(tracked_statuses) and all(_execution_status_completed(status) for status in tracked_statuses)
    so_qty = ps.get("so_det_qty")
    shipped_completed = (
        so_qty is not None
        and shipped_quantity_completed(so_qty, ps.get("qty_shipped"))
    )
    is_completed = shipped_completed
    display_ps_id, pp_partial_no = _display_ids(ps)
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


def _step_payload(step, metrics_by_op):
    key = _operation_key(step.get("op_seq_id"), step.get("op_no"))
    op_metrics = metrics_by_op.get(key, {})
    total_qty = _to_float(step.get("erp_required_qty") or step.get("total_qty"))
    planned_qty = _to_float(op_metrics.get("planned_qty"))
    finished_qty = max(_to_float(op_metrics.get("finished_qty")), _to_float(step.get("erp_finished_qty")))
    reject_qty = max(_to_float(op_metrics.get("reject_qty")), _to_float(step.get("erp_reject_qty")))
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
    }


_PS_SELECT = """
    WITH voucher_partials AS (
        SELECT
            ps_id,
            pp_partial_no,
            MAX(part_no) AS part_no,
            MAX(description) AS description,
            MIN(due_date) AS due_date,
            MIN(order_date) AS order_date,
            MAX(bom_code) AS bom_code,
            MAX(status) AS status,
            MAX(execution_status) AS execution_status,
            MAX(total_qty) AS total_qty,
            MAX(partial_qty) AS partial_qty,
            MAX(wo_qty_required) AS wo_qty_required,
            MAX(wo_qty_produced) AS wo_qty_produced,
            MAX(wo_qty_rejected) AS wo_qty_rejected,
            MAX(source_voucher_no) AS source_voucher_no,
            MAX(qty_shipped) AS qty_shipped,
            MAX(so_det_qty) AS so_det_qty,
            MAX(current_stage_no) AS current_stage_no,
            MAX(current_stage_desc) AS current_stage_desc,
            MAX(current_stage_status) AS current_stage_status,
            COALESCE(
                BOOL_AND(
                    CASE
                        WHEN NULLIF(TRIM(execution_status), '') IS NULL THEN NULL
                        ELSE UPPER(REPLACE(REPLACE(execution_status, '-', '_'), ' ', '_')) IN ('C', 'COMPLETED')
                    END
                ),
                FALSE
            ) AS execution_completed
        FROM pp_vouchers_cache
        GROUP BY ps_id, pp_partial_no
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


def list_process_sheets_payload(con):
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

    result = []
    today = date.today().isoformat()
    for ps in ps_rows:
        ps_id = compact_text(ps["ps_id"])
        steps = _resolve_process_sheet_steps(con, ps, steps_by_ps.get(ps_id, []))
        payload = _process_sheet_payload(
            ps,
            steps,
            metrics_by_ps.get(ps_id, {}),
            material_status_by_ps.get(ps_id, {}),
        )
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
    return result


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
            ps = one(
                con.execute(
                    _PS_SELECT + " WHERE ps.planner_ps_id = %s",
                    (ps_id,),
                )
            )
            if not ps:
                return jsonify({"error": "Process sheet not found"}), 404

            steps_by_ps = _flow_steps_for_ps_ids(con, [ps_id])
            metrics_by_ps, block_rows_by_ps = _block_metrics_for_ps_ids(con, [ps_id])
            material_status_by_ps = material_status_map_for_ps_ids(
                con,
                [ps_id],
                {ps_id: metrics_by_ps.get(ps_id, {}).get("expected_start", "")},
            )
            steps = _resolve_process_sheet_steps(con, dict(ps), steps_by_ps.get(ps_id, []))
            summary = _process_sheet_payload(
                dict(ps),
                steps,
                metrics_by_ps.get(ps_id, {}),
                material_status_by_ps.get(ps_id, {}),
            )

            segments = [
                dict(row)
                for row in rows(
                    con.execute(
                        """
                        SELECT s.*, m.machine_no AS machine_code, o.source_op_seq_id, o.source_op_no
                        FROM planner_run_block_segment s
                        JOIN planner_run_block b ON b.block_id = s.block_id
                        JOIN planner_operation o ON o.operation_id = b.operation_id
                        LEFT JOIN planner_machines m ON m.machine_id = s.machine_id
                        WHERE o.source_ps_id = %s
                        ORDER BY s.start_datetime, s.segment_id
                        """,
                        (ps_id,),
                    )
                )
            ]

            actuals = [
                dict(row)
                for row in rows(
                    con.execute(
                        """
                        SELECT a.actual_id, a.segment_id, a.block_id, a.report_date,
                               a.output_qty, a.reject_qty, a.target_qty_at_report,
                               a.remarks, a.reported_at,
                               o.source_op_seq_id, o.source_op_no
                        FROM planner_production_actual a
                        JOIN planner_run_block b ON b.block_id = a.block_id
                        JOIN planner_operation o ON o.operation_id = b.operation_id
                        WHERE o.source_ps_id = %s
                          AND COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
                        ORDER BY a.report_date, a.actual_id
                        """,
                        (ps_id,),
                    )
                )
            ]
            actuals_by_block = {}
            for row in actuals:
                actuals_by_block.setdefault(int(row.get("block_id") or 0), []).append(row)

            planned_blocks = []
            for block in block_rows_by_ps.get(ps_id, []):
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
                        (ps_id,),
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
                        (ps_id,),
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
