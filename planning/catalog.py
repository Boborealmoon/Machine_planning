"""planning/catalog.py — process-sheet catalog & planning-card helpers (PostgreSQL port).

Key changes vs SQLite original:
  process_sheet / parts JOIN  → planner_process_sheet + pp_vouchers_cache JOIN
  ps.ps_id                    → ps.planner_ps_id (aliased AS ps_id in queries)
  bom_variation.part_id       → planner_bom_variation.inventory_code
  operation_seq               → planner_operation_seq
  machines.machine_code       → planner_machines.machine_no AS machine_code
  planning_card.ps_id         → planner_planning_card.planner_ps_id (aliased AS ps_id)
  planning_card_operation     → planner_planning_card_operation
  run_block_group             → planner_run_block_group
  run_block                   → planner_run_block
  operation                   → planner_operation
  cur.lastrowid               → RETURNING + one(cur)["pk"]
  active = 1                  → active = TRUE
  Bug fix: combined_group_summary returned undefined `paired_output_qty` → now `paired_good_qty`
"""
from __future__ import annotations

import os
import re

from .actuals import actual_totals_for_block
from .blocks import trial_block_row  # noqa: F401  (re-exported for route convenience)
from .catalog_sql import catalog_erp_cache_with_clause
from .helpers import one, rows
from .process_sheets import (
    apply_flow_step_qty_cascade,
    ensure_planner_process_sheet,
    format_planner_ps_id,
    is_temp_planner_ps_id,
    manual_qty_by_ps_ids,
    material_in_map_for_planner_ps_ids,
    parse_planner_ps_id,
    temp_planner_ps_display_label,
    _repair_temp_ps_bom_if_missing,
)
from .utils import compact_text, parse_number, planner_wall_datetime_to_api, shipped_quantity_completed, trial_catalog_op_key


# ---------------------------------------------------------------------------
# Catalog: process sheets with remaining operations
# ---------------------------------------------------------------------------

def _base_ps_id(ps_id):
    ps_id = compact_text(ps_id)
    return ps_id.split("::", 1)[0] if "::" in ps_id else ps_id


def _canonical_catalog_ps_id(ps_id):
    """Normalize PS ids so catalog op keys match planner_operation.source_ps_id."""
    source, partial = parse_planner_ps_id(ps_id)
    return format_planner_ps_id(source, partial) if source else compact_text(ps_id)


def _catalog_op_qty_ps_ids(ps_id):
    """Planner PS id variants for lane qty lookup — never mix other partials."""
    source, partial = parse_planner_ps_id(ps_id)
    raw = compact_text(ps_id)
    if not source:
        return [raw] if raw else []
    ids = []
    for pid in (format_planner_ps_id(source, partial), raw):
        if pid and pid not in ids:
            ids.append(pid)
    # Legacy unsuffixed source_ps_id rows count as partial 1 only.
    if partial <= 1 and source not in ids:
        ids.append(source)
    return ids


def _planned_qty_for_catalog_op(planned_qty_by_op, ps_id, op_no, op_seq_id):
    """Lookup planned queue qty for one partial (not sibling partials on the same PS)."""
    keys = [
        trial_catalog_op_key(pid, op_no, op_seq_id)
        for pid in _catalog_op_qty_ps_ids(ps_id)
    ]
    return max(float(planned_qty_by_op.get(key, 0) or 0) for key in keys) if keys else 0.0


def _catalog_ps_id(row):
    """Planner/catalog identity — one row per (source_ps_id, pp_partial_no)."""
    planner_ps_id = compact_text(row.get("planner_ps_id"))
    if planner_ps_id:
        return planner_ps_id
    source_ps_id = compact_text(row.get("ps_id"))
    return format_planner_ps_id(source_ps_id, row.get("pp_partial_no"))


def _temp_reject_qty(item):
    """Reject/rework qty entered when the [Temp] PS was created."""
    return float(item.get("reject_qty") or item.get("planned_qty") or 0)


def _catalog_launch_qty(item):
    """Work quantity that drives op cascade — temp rows use reject qty, not source ERP."""
    if item.get("is_temp_ps"):
        reject_qty = _temp_reject_qty(item)
        if reject_qty > 0:
            return reject_qty
    return float(item.get("partial_qty") or item.get("total_qty") or 0)


def _sanitize_temp_ps_catalog_item(item):
    """Temp rework lines must not inherit source PS shipment/ERP completion."""
    if not item.get("is_temp_ps"):
        return item
    reject_qty = _temp_reject_qty(item)
    if reject_qty > 0:
        item["total_qty"] = reject_qty
        item["partial_qty"] = reject_qty
    item["pp_partial_no"] = int(item.get("source_pp_partial_no") or 1)
    item["shipped_completed"] = False
    item["execution_completed"] = False
    item["is_completed"] = False
    item["erp_all_wo_complete"] = False
    item["pending_do"] = False
    item["qty_shipped"] = 0
    item["execution_status"] = None
    item["current_stage_status"] = ""
    item["current_stage_desc"] = ""
    item["status"] = compact_text(item.get("planner_status") or item.get("status") or "ACTIVE")
    for op in item.get("ops") or []:
        op["pp_partial_no"] = item["pp_partial_no"]
        required = float(op.get("required_qty") or op.get("total_qty") or 0)
        planned = float(op.get("planned_qty") or 0)
        op["erp_finished_qty"] = 0.0
        op["erp_reject_qty"] = 0.0
        op["execution_status"] = ""
        op["remaining_qty"] = max(0.0, required - planned)
        op["total_qty"] = op["remaining_qty"]
    for card in item.get("op_cards") or []:
        card["pp_partial_no"] = item["pp_partial_no"]
        required = float(card.get("required_qty") or card.get("target_qty") or 0)
        planned = float(card.get("planned_qty") or 0)
        card["erp_finished_qty"] = 0.0
        card["execution_status"] = ""
        card["remaining_qty"] = max(0.0, required - planned)
        card["target_qty"] = card["remaining_qty"]
        nested = card.get("op")
        if isinstance(nested, dict):
            nested["erp_finished_qty"] = 0.0
            nested["execution_status"] = ""
            nested["remaining_qty"] = card["remaining_qty"]
            nested["total_qty"] = card["remaining_qty"]
    return item


def _bom_op_stage_keys(con):
    return {
        (compact_text(row["inventory_code"]), compact_text(row["bom_code"]))
        for row in rows(
            con.execute(
                """
                SELECT DISTINCT inventory_code, bom_code
                FROM bom_op_stage
                WHERE COALESCE(inventory_code, '') <> ''
                  AND COALESCE(bom_code, '') <> ''
                """
            )
        )
    }


def _bom_stage_check(inventory_code, erp_bom_code, selected_bom_code, bom_stage_keys):
    inv = compact_text(inventory_code)
    erp = compact_text(erp_bom_code)
    selected = compact_text(selected_bom_code)
    if not erp:
        return {"erp_bom_code": "", "bom_stage_ok": False, "bom_stage_status": "missing_erp"}
    in_stage = (inv, erp) in bom_stage_keys
    if not in_stage:
        return {"erp_bom_code": erp, "bom_stage_ok": False, "bom_stage_status": "not_in_stage"}
    if selected and selected.upper() != erp.upper():
        return {"erp_bom_code": erp, "bom_stage_ok": True, "bom_stage_status": "planner_mismatch"}
    return {"erp_bom_code": erp, "bom_stage_ok": True, "bom_stage_status": "ok"}


def _apply_bom_stage_fields(item, bom_stage_keys):
    check = _bom_stage_check(
        item.get("inventory_code"),
        item.get("erp_bom_code"),
        item.get("selected_bom_code"),
        bom_stage_keys,
    )
    item.update(check)


def _apply_catalog_op_qty_cascade(item, manual_qty_by_ps):
    all_ops = list(item.get("all_ops") or [])
    if not all_ops:
        return
    launch_qty = _catalog_launch_qty(item)
    is_temp = bool(item.get("is_temp_ps"))
    manual_map = {}
    for planner_ps_id in item.get("planner_ps_ids") or []:
        manual_map.update((manual_qty_by_ps or {}).get(planner_ps_id, {}))
    steps = []
    for op in all_ops:
        steps.append(
            {
                "op_seq_id": int(op.get("source_op_seq_id") or 0),
                "seq_no": int(op.get("seq_no") or 0),
                "op_no": op.get("op_no") or op.get("source_op_no") or "",
                "source_kind": op.get("source_kind") or "",
                "source_stage_no": int(op.get("source_stage_no") or 0),
                "erp_finished_qty": 0.0 if is_temp else float(op.get("erp_finished_qty") or 0),
                "erp_reject_qty": 0.0 if is_temp else float(op.get("erp_reject_qty") or 0),
                "erp_required_qty": 0.0 if is_temp else float(
                    op.get("erp_required_qty") or op.get("required_qty") or 0
                ),
            }
        )
    cascaded = apply_flow_step_qty_cascade(steps, launch_qty, manual_map)
    by_op_seq = {int(s.get("op_seq_id") or 0): s for s in cascaded}
    refreshed_ops = []
    for op in all_ops:
        op_seq_id = int(op.get("source_op_seq_id") or 0)
        step = by_op_seq.get(op_seq_id, {})
        ready_qty = float(step.get("cascade_required_qty") or launch_qty)
        if is_temp:
            wo_req = launch_qty
        else:
            wo_req = float(op.get("erp_required_qty") or 0)
            if wo_req <= 0:
                wo_req = float(op.get("required_qty") or launch_qty)
            if launch_qty > 0 and wo_req > launch_qty:
                wo_req = launch_qty
        finished = max(
            float(op.get("erp_finished_qty") or 0),
            float(step.get("manual_produced_qty") or 0),
            float(step.get("cascade_output_qty") or 0),
        )
        planned = float(op.get("planned_qty") or 0)
        schedulable_remaining = max(0.0, ready_qty - planned - finished)
        refreshed = dict(op)
        refreshed["wo_qty_required"] = wo_req
        refreshed["required_qty"] = wo_req
        refreshed["ready_qty"] = ready_qty
        refreshed["total_qty"] = schedulable_remaining
        refreshed["remaining_qty"] = schedulable_remaining
        refreshed["needs_manual_produced"] = bool(step.get("needs_manual_produced"))
        refreshed["manual_produced_qty"] = float(step.get("manual_produced_qty") or 0)
        refreshed_ops.append(refreshed)
    item["all_ops"] = refreshed_ops
    item["ops"] = _catalog_ops_for_sidebar(refreshed_ops)


def _should_show_for_shipped_qty(total_qty, qty_shipped, source_line_item_no=None):
    if os.getenv("DISABLE_SHIPPED_QTY_CATALOG_FILTER", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    try:
        if float(compact_text(source_line_item_no) or 0) == 0:
            return False
    except ValueError:
        pass
    if compact_text(source_line_item_no) == "0":
        return False
    return not shipped_quantity_completed(total_qty, qty_shipped)


_MACHINING_OP_RE = re.compile(r"^(Turning|Milling|Turnmill)\b", re.IGNORECASE)
_NON_MACHINING_OP_RE = re.compile(
    r"^(BOM|MATERIAL|MAT\b|SUBCON|SUB\s*CON|SMP[\s-]*MAT|KITTING|PACK)\b",
    re.IGNORECASE,
)


def _is_manual_bom_step(op):
    """Planner-added BOM step (Edit BOM · source MANUAL), not ERP bom_op_stage rows."""
    row = op if isinstance(op, dict) else {}
    if int(row.get("source_stage_no") or 0) > 0:
        return False
    return compact_text(row.get("source_kind")).upper() == "MANUAL" and bool(compact_text(row.get("op_type")))


def _is_machining_plannable_op(op_type, machine_category, source_kind=None, preferred_machine=None):
    """True when a BOM step can be dragged onto a machine lane in the scheduler."""
    if compact_text(preferred_machine):
        return True
    cat = compact_text(machine_category).upper()
    if cat in {"TURNING", "MILLING", "TURNMILL", "PLACEHOLDER"}:
        return True
    op_upper = compact_text(op_type).upper()
    if op_upper == "PLACEHOLDER":
        return True
    op_text = compact_text(op_type)
    if op_text and _NON_MACHINING_OP_RE.match(op_text):
        return False
    if op_text and _MACHINING_OP_RE.match(op_text):
        return True
    # Manual planner BOM steps (e.g. op 60 · test) are schedulable unless marked as material/subcon.
    if compact_text(source_kind).upper() == "MANUAL" and op_text:
        return True
    return False


def _catalog_ops_for_sidebar(refreshed_ops):
    """Ops listed in PS / Ops sidebar — includes completed machining ops (read-only in UI)."""
    sidebar_ops = []
    for op in refreshed_ops:
        if _is_manual_bom_step(op):
            row = dict(op)
            if float(row.get("remaining_qty") or 0) <= 0:
                fallback = max(
                    float(row.get("required_qty") or 0),
                    float(row.get("cascade_required_qty") or 0),
                    float(row.get("total_qty") or 0),
                )
                planned = float(row.get("planned_qty") or 0)
                if fallback > 0:
                    row["remaining_qty"] = max(0.0, fallback - planned)
                    row["total_qty"] = row["remaining_qty"]
            sidebar_ops.append(row)
            continue
        if _is_machining_plannable_op(
            op.get("op_type"),
            op.get("machine_category"),
            op.get("source_kind"),
            op.get("preferred_machine"),
        ):
            sidebar_ops.append(dict(op))
    return sidebar_ops


def _catalog_lane_qty_maps(con):
    """Planned + queued qty keyed for catalog / PP sidebar op cards."""
    planned_qty_by_op = {}
    queued_machines_by_op = {}
    for row in rows(
        con.execute(
            """
            SELECT o.source_ps_id,
                   o.source_op_no, o.source_op_seq_id AS source_op_seq_id,
                   COALESCE(SUM(COALESCE(b.scheduled_qty, 0)), 0) AS planned_qty
            FROM planner_operation o
            JOIN planner_run_block b ON b.operation_id = o.operation_id
            WHERE COALESCE(o.source_ps_id, '') <> ''
              AND COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
            GROUP BY o.source_ps_id, o.source_op_no, o.source_op_seq_id
            """
        )
    ):
        canonical_ps = _canonical_catalog_ps_id(row["source_ps_id"])
        key = trial_catalog_op_key(canonical_ps, row["source_op_no"], row["source_op_seq_id"])
        planned_qty_by_op[key] = float(planned_qty_by_op.get(key, 0) or 0) + float(row["planned_qty"] or 0)
    for row in rows(
        con.execute(
            """
            SELECT DISTINCT o.source_ps_id, o.source_op_no, o.source_op_seq_id AS source_op_seq_id,
                   m.machine_no AS machine_code
            FROM planner_operation o
            JOIN planner_run_block b ON b.operation_id = o.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            WHERE COALESCE(o.source_ps_id, '') <> ''
              AND COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
            ORDER BY m.machine_no
            """
        )
    ):
        canonical_ps = _canonical_catalog_ps_id(row["source_ps_id"])
        key = trial_catalog_op_key(canonical_ps, row["source_op_no"], row["source_op_seq_id"])
        code = compact_text(row.get("machine_code"))
        if code:
            queued_machines_by_op.setdefault(key, []).append(code)
    for key, codes in list(queued_machines_by_op.items()):
        queued_machines_by_op[key] = sorted({c for c in codes if c})
    return planned_qty_by_op, queued_machines_by_op


def _catalog_op_card_from_planner_op(op, entry):
    ps_id = compact_text(entry.get("ps_id"))
    pp_partial_no = int(entry.get("pp_partial_no") or parse_planner_ps_id(ps_id)[1] or 1)
    return {
        "card_kind": "single",
        "card_id": None,
        "ps_id": ps_id,
        "pp_partial_no": pp_partial_no,
        "source_ps_id": ps_id,
        "operation_label": op.get("source_op_no") or op.get("operation_name") or op.get("op_type") or "",
        "operation_name": op.get("op_type") or op.get("operation_name") or "",
        "op_type": op.get("op_type") or "",
        "target_qty": float(op.get("remaining_qty") or 0),
        "remaining_qty": float(op.get("remaining_qty") or 0),
        "required_qty": float(op.get("required_qty") or op.get("wo_qty_required") or 0),
        "wo_qty_required": float(op.get("wo_qty_required") or op.get("required_qty") or 0),
        "ready_qty": float(op.get("ready_qty") or op.get("remaining_qty") or 0),
        "planned_qty": float(op.get("planned_qty") or 0),
        "erp_finished_qty": float(op.get("erp_finished_qty") or 0),
        "source_op_seq_id": int(op.get("source_op_seq_id") or 0),
        "source_op_no": op.get("source_op_no") or "",
        "source_kind": compact_text(op.get("source_kind") or ""),
        "is_manual_bom": _is_manual_bom_step(op),
        "job_no": op.get("job_no") or ps_id,
        "planning_status": "UNSCHEDULED",
        "card_type": "SINGLE",
        "is_scheduled": False,
        "setup_minutes": float(op.get("setup_time") or 0),
        "cycle_minutes_per_qty": float(op.get("cycle_time") or 0),
        "compatible_machine_group": op.get("compatible_machine_group") or "",
        "execution_status": op.get("execution_status") or "",
        "queued_machines": list(op.get("queued_machines") or []),
        "is_allocated": bool(op.get("is_allocated")),
        "op": op,
    }


def attach_planner_bom_ops_to_catalog_entry(
    con,
    entry,
    *,
    planned_qty_by_op,
    queued_machines_by_op,
    bom_stage_keys=None,
):
    """PP sidebar (/api/pp-vouchers/with-ops) — use planner BOM steps when a flow is selected."""
    bom_id = int(entry.get("selected_bom_id") or 0)
    if bom_id <= 0:
        return
    source_ps_id = compact_text(entry.get("source_ps_id"))
    if not source_ps_id:
        ps_id = compact_text(entry.get("ps_id"))
        source_ps_id = ps_id.split("::", 1)[0] if ps_id else ""
    if not source_ps_id:
        return
    pp_partial_no = int(entry.get("pp_partial_no") or 1)
    ps_id = compact_text(entry.get("ps_id")) or format_planner_ps_id(source_ps_id, pp_partial_no)
    launch_qty = float(
        entry.get("display_qty")
        or entry.get("partial_qty")
        or entry.get("wo_req_qty")
        or entry.get("total_qty")
        or 0
    )
    step_rows = rows(
        con.execute(
            """
            SELECT op_seq_id, seq_no, op_no, op_type, machine_category, preferred_machine,
                   cycle_time, setup_time, is_last_op, source_kind, source_stage_no
            FROM planner_operation_seq
            WHERE bom_id = %s
            ORDER BY seq_no, op_seq_id
            """,
            (bom_id,),
        )
    )
    if not step_rows:
        return

    all_ops = []
    for row in step_rows:
        op_seq_id = int(row["op_seq_id"] or 0)
        op_key = trial_catalog_op_key(ps_id, row["op_no"], op_seq_id)
        planned_qty = _planned_qty_for_catalog_op(planned_qty_by_op, ps_id, row["op_no"], op_seq_id)
        erp_finished_qty = 0.0
        remaining_qty = max(0.0, launch_qty - planned_qty - erp_finished_qty)
        queued_machines = list(queued_machines_by_op.get(op_key, []) or [])
        all_ops.append(
            {
                "source_ps_id": ps_id,
                "pp_partial_no": pp_partial_no,
                "source_op_seq_id": op_seq_id,
                "source_op_no": row["op_no"] or "",
                "op_no": row["op_no"] or "",
                "op_type": row["op_type"] or "",
                "seq_no": int(row.get("seq_no") or 0),
                "source_kind": compact_text(row.get("source_kind") or ""),
                "source_stage_no": int(row.get("source_stage_no") or 0),
                "machine_category": row["machine_category"] or "",
                "preferred_machine": row["preferred_machine"] or "",
                "cycle_time": float(row["cycle_time"] or 0),
                "setup_time": float(row["setup_time"] or 0),
                "is_last_op": int(row["is_last_op"] or 0),
                "job_no": ps_id,
                "operation_name": f"{row['op_no'] or ''} {row['op_type'] or ''}".strip(),
                "total_qty": remaining_qty,
                "required_qty": launch_qty,
                "planned_qty": planned_qty,
                "erp_finished_qty": erp_finished_qty,
                "erp_reject_qty": 0.0,
                "remaining_qty": remaining_qty,
                "queued_machines": queued_machines,
                "is_allocated": planned_qty > 0,
                "compatible_machine_group": row["machine_category"] or "",
                "execution_status": "",
            }
        )

    cascade_item = {
        "partial_qty": launch_qty,
        "total_qty": launch_qty,
        "planner_ps_ids": [format_planner_ps_id(source_ps_id, pp_partial_no)],
        "all_ops": all_ops,
    }
    manual_qty_by_ps = manual_qty_by_ps_ids(con, cascade_item["planner_ps_ids"])
    _apply_catalog_op_qty_cascade(cascade_item, manual_qty_by_ps)
    sidebar_ops = _catalog_ops_for_sidebar(cascade_item["all_ops"])
    op_cards = [_catalog_op_card_from_planner_op(op, entry) for op in sidebar_ops]

    entry["all_ops"] = list(cascade_item["all_ops"])
    entry["ops"] = list(sidebar_ops)
    entry["op_cards"] = op_cards
    if bom_stage_keys is not None:
        _apply_bom_stage_fields(entry, bom_stage_keys)


def trial_catalog_items(con, include_completed=False, planner_ps_ids=None):
    ps_filter_clause = ""
    ps_filter_params = []
    wanted_ps_ids = [compact_text(pid) for pid in (planner_ps_ids or []) if compact_text(pid)]
    if wanted_ps_ids:
        ps_filter_clause = " AND ps.planner_ps_id = ANY(%s)"
        ps_filter_params = [wanted_ps_ids]
    for row in rows(
        con.execute(
            """
            SELECT planner_ps_id
            FROM planner_process_sheet
            WHERE planner_ps_id LIKE %s
              AND COALESCE(selected_bom_id, 0) = 0
            """,
            ("[Temp]%",),
        )
    ):
        try:
            _repair_temp_ps_bom_if_missing(con, row.get("planner_ps_id"))
        except Exception:
            pass
    bom_stage_keys = _bom_op_stage_keys(con)
    planned_qty_by_op, queued_machines_by_op = _catalog_lane_qty_maps(con)

    # Process sheets that have a selected BOM (have ops to schedule). ERP cache
    # has one row per partial/stage, so aggregate it before joining to planner
    # steps; otherwise partial quantities and operation rows get multiplied.
    records = rows(
        con.execute(
            """
            {erp_cache_ctes}
            SELECT ps.planner_ps_id AS planner_ps_id,
                   ps.source_ps_id AS ps_id,
                   ps.pp_partial_no,
                   tps.source_pp_partial_no,
                   tps.reject_qty,
                   ps.inventory_code,
                   ps.selected_bom_id, ps.planner_status, ps.status,
                   ps.planned_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%'
                        THEN COALESCE(NULLIF(ps.planned_qty, 0), NULLIF(tps.reject_qty, 0), 0)
                        ELSE COALESCE(st.rolled_total_qty, pst.planned_qty, ps.planned_qty, 0)
                   END AS total_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%'
                        THEN COALESCE(NULLIF(ps.planned_qty, 0), NULLIF(tps.reject_qty, 0), 0)
                        ELSE COALESCE(vp.partial_qty, ps.planned_qty, vp.total_qty, 0)
                   END AS partial_qty,
                   sf.bom_code AS selected_bom_code,
                   COALESCE(vp.erp_bom_code, '') AS erp_bom_code,
                   COALESCE(st.part_no, vp.part_no) AS part_no,
                   COALESCE(st.description, vp.description) AS part_desc,
                   COALESCE(st.part_no, vp.part_no) AS part_name,
                   COALESCE(tps.due_date, st.due_date, vp.due_date)::text AS due_date,
                   COALESCE(st.erp_status, vp.erp_status) AS erp_status,
                   COALESCE(st.execution_status, vp.execution_status) AS execution_status,
                   COALESCE(st.current_stage_no, vp.current_stage_no) AS current_stage_no,
                   COALESCE(st.current_stage_desc, vp.current_stage_desc) AS current_stage_desc,
                   COALESCE(st.current_stage_status, vp.current_stage_status) AS current_stage_status,
                   st.qty_shipped,
                   st.source_line_item_no,
                   pfs.op_seq_id AS op_seq_id, pfs.seq_no, pfs.op_no, pfs.op_type,
                   pfs.machine_category, pfs.preferred_machine,
                   pfs.cycle_time, pfs.setup_time, pfs.is_last_op,
                   pfs.source_kind, pfs.source_stage_no,
                   COALESCE(vso.wo_qty_required, 0) AS erp_required_qty,
                   COALESCE(vso.wo_qty_produced, vop.wo_qty_produced, 0) AS erp_finished_qty,
                   COALESCE(vso.wo_qty_rejected, vop.wo_qty_rejected, 0) AS erp_reject_qty,
                   COALESCE(vso.execution_status, vop.execution_status, '') AS op_execution_status
            FROM planner_process_sheet ps
            LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
            LEFT JOIN voucher_partials vp
                   ON vp.ps_id = ps.source_ps_id
                  AND vp.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
            LEFT JOIN source_totals st ON st.ps_id = ps.source_ps_id
            LEFT JOIN planner_source_totals pst ON pst.source_ps_id = ps.source_ps_id
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            LEFT JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
            LEFT JOIN voucher_stage_outputs vso
                   ON vso.ps_id = ps.source_ps_id
                  AND vso.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
                  AND COALESCE(pfs.source_stage_no, 0) > 0
                  AND vso.stage_no = pfs.source_stage_no
            LEFT JOIN voucher_op_outputs vop
                   ON vop.ps_id = ps.source_ps_id
                  AND vop.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
                  AND vop.op_no_text = TRIM(COALESCE(pfs.op_no::text, ''))
            WHERE COALESCE(ps.selected_bom_id, 0) > 0
              AND (%s = 1 OR (
                COALESCE(ps.planner_status, '') <> 'COMPLETED'
                AND COALESCE(ps.status, '') <> 'COMPLETED'
                AND (
                  ps.planner_ps_id LIKE '[Temp]%%'
                  OR UPPER(COALESCE(st.erp_status, vp.erp_status, '')) <> 'HISTORY'
                )
              )){ps_filter_clause}
            ORDER BY COALESCE(tps.due_date, st.due_date, vp.due_date), ps.source_ps_id, pfs.seq_no, pfs.op_seq_id
            """.format(
                erp_cache_ctes=catalog_erp_cache_with_clause(assigned=True),
                ps_filter_clause=ps_filter_clause,
            ),
            tuple([1 if include_completed else 0, *ps_filter_params]),
        )
    )
    # Process sheets without a BOM yet
    unassigned_records = rows(
        con.execute(
            """
            {erp_cache_ctes}
            SELECT ps.planner_ps_id AS planner_ps_id,
                   ps.source_ps_id AS ps_id,
                   ps.pp_partial_no,
                   tps.source_pp_partial_no,
                   tps.reject_qty,
                   ps.inventory_code,
                   ps.selected_bom_id, ps.planner_status, ps.status,
                   ps.planned_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%'
                        THEN COALESCE(NULLIF(ps.planned_qty, 0), NULLIF(tps.reject_qty, 0), 0)
                        ELSE COALESCE(st.rolled_total_qty, pst.planned_qty, ps.planned_qty, 0)
                   END AS total_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%'
                        THEN COALESCE(NULLIF(ps.planned_qty, 0), NULLIF(tps.reject_qty, 0), 0)
                        ELSE COALESCE(vp.partial_qty, ps.planned_qty, vp.total_qty, 0)
                   END AS partial_qty,
                   '' AS selected_bom_code,
                   COALESCE(vp.erp_bom_code, '') AS erp_bom_code,
                   COALESCE(st.part_no, vp.part_no) AS part_no,
                   COALESCE(st.description, vp.description) AS part_desc,
                   COALESCE(st.part_no, vp.part_no) AS part_name,
                   COALESCE(tps.due_date, st.due_date, vp.due_date)::text AS due_date,
                   COALESCE(st.erp_status, vp.erp_status) AS erp_status,
                   COALESCE(st.execution_status, vp.execution_status) AS execution_status,
                   st.qty_shipped,
                   st.source_line_item_no
            FROM planner_process_sheet ps
            LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
            LEFT JOIN voucher_partials vp
                   ON vp.ps_id = ps.source_ps_id
                  AND vp.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
            LEFT JOIN source_totals st ON st.ps_id = ps.source_ps_id
            LEFT JOIN planner_source_totals pst ON pst.source_ps_id = ps.source_ps_id
            WHERE COALESCE(ps.selected_bom_id, 0) = 0
              AND (%s = 1 OR (
                COALESCE(ps.planner_status, '') <> 'COMPLETED'
                AND COALESCE(ps.status, '') <> 'COMPLETED'
                AND (
                  ps.planner_ps_id LIKE '[Temp]%%'
                  OR UPPER(COALESCE(st.erp_status, vp.erp_status, '')) <> 'HISTORY'
                )
              )){ps_filter_clause}
            ORDER BY COALESCE(tps.due_date, st.due_date, vp.due_date), ps.source_ps_id
            """.format(
                erp_cache_ctes=catalog_erp_cache_with_clause(assigned=False),
                ps_filter_clause=ps_filter_clause,
            ),
            tuple([1 if include_completed else 0, *ps_filter_params]),
        )
    )

    grouped = {}
    flow_cache = {}

    for row in records:
        ps_id = _catalog_ps_id(row)
        source_ps_id = _base_ps_id(row["ps_id"])
        pp_partial_no = int(row.get("pp_partial_no") or 1)
        planner_ps_id = compact_text(row.get("planner_ps_id")) or ps_id
        is_temp = is_temp_planner_ps_id(planner_ps_id)
        if not is_temp and not _should_show_for_shipped_qty(
            row["total_qty"], row.get("qty_shipped"), row.get("source_line_item_no")
        ):
            continue
        op_seq_id = int(row["op_seq_id"] or 0)
        op_key = trial_catalog_op_key(ps_id, row["op_no"], op_seq_id)
        catalog_partial_no = (
            int(row.get("source_pp_partial_no") or 1)
            if is_temp
            else pp_partial_no
        )
        if is_temp:
            required_qty = float(row.get("planned_qty") or row.get("partial_qty") or 0)
        else:
            required_qty = float(row.get("partial_qty") or row["total_qty"] or 0)
        planned_qty = _planned_qty_for_catalog_op(planned_qty_by_op, ps_id, row["op_no"], op_seq_id)
        if is_temp:
            erp_finished_qty = 0.0
            erp_reject_qty = 0.0
            remaining_qty = max(0.0, required_qty - planned_qty)
        else:
            erp_finished_qty = max(0.0, float(row.get("erp_finished_qty") or 0))
            erp_reject_qty = max(0.0, float(row.get("erp_reject_qty") or 0))
            remaining_qty = max(0.0, required_qty - planned_qty - erp_finished_qty)
        item = grouped.setdefault(
            ps_id,
            {
                "ps_id": ps_id,
                "display_ps_id": temp_planner_ps_display_label(planner_ps_id) if is_temp else ps_id,
                "is_temp_ps": is_temp,
                "source_ps_id": source_ps_id,
                "pp_partial_no": catalog_partial_no,
                "source_pp_partial_no": int(row.get("source_pp_partial_no") or 1) if is_temp else None,
                "inventory_code": row["inventory_code"] or "",
                "part_name": row["part_name"] or "",
                "part_no": row["part_no"] or "",
                "part_desc": row["part_desc"] or "",
                "due_date": str(row["due_date"]) if row["due_date"] else "",
                "planned_qty": float(row.get("planned_qty") or 0),
                "reject_qty": float(row.get("reject_qty") or row.get("planned_qty") or 0),
                "total_qty": float(row["total_qty"] or 0),
                "partial_qty": float(row.get("partial_qty") or 0),
                "qty_shipped": float(row["qty_shipped"] or 0) if row.get("qty_shipped") is not None else None,
                "source_line_item_no": row.get("source_line_item_no") or "",
                "status": row.get("erp_status") or row["status"] or "",
                "execution_status": row.get("execution_status") or None,
                "current_stage_no": row.get("current_stage_no") or None,
                "current_stage_desc": row.get("current_stage_desc") or "",
                "current_stage_status": row.get("current_stage_status") or "",
                "planner_status": row["planner_status"] or "",
                "selected_bom_id": int(row["selected_bom_id"] or 0),
                "selected_bom_code": row["selected_bom_code"] or "",
                "erp_bom_code": compact_text(row.get("erp_bom_code")),
                "ops": [],
                "all_ops": [],
                "planner_ps_ids": [],
                "_seen_op_keys": set(),
            },
        )
        if planner_ps_id and planner_ps_id not in item["planner_ps_ids"]:
            item["planner_ps_ids"].append(planner_ps_id)
        erp_bom = compact_text(row.get("erp_bom_code"))
        if erp_bom and not compact_text(item.get("erp_bom_code")):
            item["erp_bom_code"] = erp_bom
        if not op_seq_id and not compact_text(row["op_no"]):
            continue
        if op_key in item["_seen_op_keys"]:
            continue
        item["_seen_op_keys"].add(op_key)
        queued_machines = list(queued_machines_by_op.get(op_key, []) or [])
        op_item = {
            "source_ps_id": ps_id,
            "pp_partial_no": catalog_partial_no,
            "source_op_seq_id": op_seq_id,
            "source_op_no": row["op_no"] or "",
            "op_no": row["op_no"] or "",
            "op_type": row["op_type"] or "",
            "seq_no": int(row.get("seq_no") or 0),
            "source_kind": compact_text(row.get("source_kind") or ""),
            "source_stage_no": int(row.get("source_stage_no") or 0),
            "machine_category": row["machine_category"] or "",
            "preferred_machine": row["preferred_machine"] or "",
            "cycle_time": float(row["cycle_time"] or 0),
            "setup_time": float(row["setup_time"] or 0),
            "is_last_op": int(row["is_last_op"] or 0),
            "job_no": ps_id,
            "operation_name": f"{row['op_no'] or ''} {row['op_type'] or ''}".strip(),
            "total_qty": remaining_qty,
            "required_qty": required_qty,
            "wo_qty_required": required_qty if is_temp else float(row.get("erp_required_qty") or required_qty),
            "erp_required_qty": 0.0 if is_temp else float(row.get("erp_required_qty") or 0),
            "planned_qty": planned_qty,
            "erp_finished_qty": erp_finished_qty,
            "erp_reject_qty": erp_reject_qty,
            "remaining_qty": remaining_qty,
            "queued_machines": queued_machines,
            "is_allocated": planned_qty > 0,
            "compatible_machine_group": row["machine_category"] or "",
            "execution_status": compact_text(row.get("op_execution_status") or ""),
        }
        item["all_ops"].append(op_item)
        if _is_manual_bom_step(op_item) or (
            remaining_qty > 0
            and _is_machining_plannable_op(
                row.get("op_type"),
                row.get("machine_category"),
                row.get("source_kind"),
                row.get("preferred_machine"),
            )
        ):
            item["ops"].append(op_item)

    available = []
    planned = []
    planning_cards_map = planning_cards_by_ps(con)
    covered_map = planning_card_covered_op_keys(con)

    def flow_options_for_inventory_code(inventory_code):
        inventory_code = compact_text(inventory_code)
        if not inventory_code:
            return []
        if inventory_code not in flow_cache:
            flow_cache[inventory_code] = [
                dict(flow)
                for flow in rows(
                    con.execute(
                        """
                        SELECT bom_id, bom_code, bom_desc, is_default
                        FROM planner_bom_variation
                        WHERE inventory_code = %s
                        ORDER BY is_default DESC, bom_id
                        """,
                        (inventory_code,),
                    )
                )
            ]
        return flow_cache[inventory_code]

    planner_ps_ids = []
    for item in grouped.values():
        planner_ps_ids.extend(item.get("planner_ps_ids") or [])
    unique_planner_ps_ids = list(dict.fromkeys(planner_ps_ids))
    manual_qty_by_ps = manual_qty_by_ps_ids(con, unique_planner_ps_ids)
    material_in_by_ps = material_in_map_for_planner_ps_ids(con, unique_planner_ps_ids)

    def _catalog_material_in(item):
        for pid in item.get("planner_ps_ids") or []:
            if material_in_by_ps.get(pid):
                return True
        return bool(material_in_by_ps.get(item.get("ps_id")))

    for item in grouped.values():
        item.pop("_seen_op_keys", None)
        item["material_in"] = _catalog_material_in(item)
        _apply_catalog_op_qty_cascade(item, manual_qty_by_ps)
        item["flow_options"] = flow_options_for_inventory_code(item["inventory_code"])
        item["planning_cards"] = planning_cards_map.get(item["ps_id"], [])
        covered_keys = covered_map.get(item["ps_id"], set())
        op_cards = []

        for card in item["planning_cards"]:
            group_operation_name = " + ".join(
                compact_text(op.get("op_type") or op.get("operation_name") or op.get("source_op_no"))
                for op in card.get("ops", [])
                if compact_text(op.get("op_type") or op.get("operation_name") or op.get("source_op_no"))
            )
            op_cards.append(
                {
                    "card_kind": "group",
                    "card_id": int(card["card_id"]),
                    "ps_id": card["ps_id"] or item["ps_id"],
                    "operation_label": card["operation_label"] or "",
                    "operation_name": group_operation_name,
                    "target_qty": float(card["target_qty"] or 0),
                    "remaining_qty": float(card["target_qty"] or 0),
                    "card_type": card["card_type"] or "COMBINED",
                    "planning_status": card["planning_status"] or "UNSCHEDULED",
                    "is_scheduled": bool(card["is_scheduled"]),
                    "machine_id": int(card["machine_id"] or 0),
                    "machine_code": card["machine_code"] or "",
                    "setup_minutes": float(card["setup_minutes"] or 0),
                    "cycle_minutes_per_qty": float(card["cycle_minutes_per_qty"] or 0),
                    "ops": card.get("ops", []),
                }
            )

        for op in item["ops"]:
            op_key = trial_catalog_op_key(op["source_ps_id"], op["source_op_no"], op["source_op_seq_id"])
            if op_key in covered_keys:
                continue
            op_cards.append(
                {
                    "card_kind": "single",
                    "card_id": None,
                    "ps_id": op["source_ps_id"] or item["ps_id"],
                    "operation_label": op["source_op_no"] or op["operation_name"] or op["op_type"] or "",
                    "operation_name": op["op_type"] or op["operation_name"] or "",
                    "target_qty": float(op["remaining_qty"] or 0),
                    "remaining_qty": float(op["remaining_qty"] or 0),
                    "required_qty": float(op.get("required_qty") or op.get("wo_qty_required") or 0),
                    "wo_qty_required": float(op.get("wo_qty_required") or op.get("required_qty") or 0),
                    "ready_qty": float(op.get("ready_qty") or op.get("remaining_qty") or 0),
                    "planned_qty": float(op.get("planned_qty") or 0),
                    "erp_finished_qty": float(op.get("erp_finished_qty") or 0),
                    "source_op_seq_id": int(op["source_op_seq_id"] or 0),
                    "source_op_no": op["source_op_no"] or "",
                    "job_no": op["job_no"] or "",
                    "planning_status": "UNSCHEDULED",
                    "card_type": "SINGLE",
                    "is_scheduled": False,
                    "setup_minutes": float(op["setup_time"] or 0),
                    "cycle_minutes_per_qty": float(op["cycle_time"] or 0),
                    "compatible_machine_group": op["compatible_machine_group"] or "",
                    "source_kind": compact_text(op.get("source_kind") or ""),
                    "is_manual_bom": _is_manual_bom_step(op),
                    "execution_status": op.get("execution_status") or "",
                    "queued_machines": list(op.get("queued_machines") or []),
                    "is_allocated": bool(op.get("is_allocated")),
                    "op": op,
                }
            )

        item["op_cards"] = op_cards
        if not item["selected_bom_code"] and item["selected_bom_id"]:
            item["selected_bom_code"] = next(
                (flow["bom_code"] for flow in item["flow_options"] if int(flow["bom_id"]) == int(item["selected_bom_id"])),
                "",
            )
        if item.get("is_temp_ps"):
            _sanitize_temp_ps_catalog_item(item)
        _apply_bom_stage_fields(item, bom_stage_keys)
        if item["op_cards"]:
            available.append(item)
        else:
            planned.append(
                {
                    "ps_id": item["ps_id"],
                    "display_ps_id": item.get("display_ps_id") or item["ps_id"],
                    "is_temp_ps": bool(item.get("is_temp_ps")),
                    "source_ps_id": item.get("source_ps_id") or "",
                    "inventory_code": item["inventory_code"],
                    "part_name": item["part_name"],
                    "part_no": item["part_no"],
                    "part_desc": item["part_desc"],
                    "due_date": item["due_date"],
                    "total_qty": item["total_qty"],
                    "status": item["status"],
                    "planner_status": item["planner_status"],
                    "selected_bom_id": item["selected_bom_id"],
                    "selected_bom_code": item["selected_bom_code"],
                    "erp_bom_code": item.get("erp_bom_code") or "",
                    "bom_stage_ok": item.get("bom_stage_ok", False),
                    "bom_stage_status": item.get("bom_stage_status") or "",
                    "flow_options": item["flow_options"],
                    "planning_cards": item["planning_cards"],
                    "op_cards": item["op_cards"],
                    "material_in": bool(item.get("material_in")),
                    "shipped_completed": False,
                    "execution_completed": False,
                    "is_completed": False,
                }
            )

    for row in unassigned_records:
        ps_id = _catalog_ps_id(row)
        if ps_id in grouped:
            continue
        planner_ps_id = compact_text(row.get("planner_ps_id")) or ps_id
        is_temp_row = is_temp_planner_ps_id(planner_ps_id)
        if not is_temp_row and not _should_show_for_shipped_qty(
            row["total_qty"], row.get("qty_shipped"), row.get("source_line_item_no")
        ):
            continue
        inventory_code = compact_text(row["inventory_code"])
        flow_options = flow_options_for_inventory_code(inventory_code)
        if ps_id in {item["ps_id"] for item in planned}:
            continue
        unassigned_item = {
            "ps_id": ps_id,
            "display_ps_id": temp_planner_ps_display_label(planner_ps_id) if is_temp_row else ps_id,
            "is_temp_ps": is_temp_row,
            "source_ps_id": _base_ps_id(row["ps_id"]),
            "pp_partial_no": int(row.get("pp_partial_no") or 1),
            "inventory_code": inventory_code,
            "part_name": row["part_name"] or "",
            "part_no": row["part_no"] or "",
            "part_desc": row["part_desc"] or "",
            "due_date": str(row["due_date"]) if row["due_date"] else "",
            "planned_qty": float(row.get("planned_qty") or 0),
            "reject_qty": float(row.get("reject_qty") or row.get("planned_qty") or 0),
            "total_qty": float(row["total_qty"] or 0),
            "partial_qty": float(row.get("partial_qty") or 0),
            "qty_shipped": float(row["qty_shipped"] or 0) if row.get("qty_shipped") is not None else None,
            "source_line_item_no": row.get("source_line_item_no") or "",
            "status": row.get("erp_status") or row["status"] or "",
            "execution_status": row.get("execution_status") or None,
            "planner_status": row["planner_status"] or "",
            "selected_bom_id": int(row["selected_bom_id"] or 0),
            "selected_bom_code": row["selected_bom_code"] or "",
            "erp_bom_code": compact_text(row.get("erp_bom_code")),
            "flow_options": flow_options,
            "planning_cards": planning_cards_map.get(ps_id, []),
            "op_cards": [],
            "material_in": bool(material_in_by_ps.get(planner_ps_id)),
        }
        if is_temp_row:
            _sanitize_temp_ps_catalog_item(unassigned_item)
        _apply_bom_stage_fields(unassigned_item, bom_stage_keys)
        planned.append(unassigned_item)

    return {"available": available, "planned": planned}


def catalog_lane_context_for_blocks(con, blocks):
    """
    Op cards + ERP due dates for lane blocks via the with-ops pipeline
    (same as /api/pp-vouchers/with-ops), so queue visibility matches the planner sidebar.
    """
    from .blocks import _row_planner_ps_identity

    wanted_keys = set()
    for row in blocks or []:
        base, partial = _row_planner_ps_identity(row)
        if base:
            wanted_keys.add((base, int(partial or 1)))
    if not wanted_keys:
        return {}, {}

    from app import pp_vouchers_lane_catalog_entries

    op_cards_by_partial = {}
    due_by_partial = {}
    for entry in pp_vouchers_lane_catalog_entries(con, wanted_keys, include_completed=True):
        base = compact_text(entry.get("source_ps_id") or _base_ps_id(entry.get("ps_id")))
        partial = int(entry.get("pp_partial_no") or parse_planner_ps_id(entry.get("ps_id"))[1] or 1)
        key = (base, partial)
        op_cards_by_partial[key] = list(entry.get("op_cards") or [])
        due_text = compact_text(entry.get("due_date"))
        if due_text:
            due_by_partial[key] = due_text
    return op_cards_by_partial, due_by_partial


# ---------------------------------------------------------------------------
# Combined group summary
# ---------------------------------------------------------------------------

def combined_group_summary(con, group_id):
    group_id = int(group_id or 0)
    if not group_id:
        return None

    group = one(
        con.execute(
            """
            SELECT group_id, group_label, group_type, created_at
            FROM planner_run_block_group WHERE group_id = %s
            """,
            (group_id,),
        )
    )
    if not group:
        return None

    blocks = rows(
        con.execute(
            """
            SELECT b.*, o.job_no, o.operation_name, o.total_qty, o.setup_minutes, o.cycle_minutes_per_qty,
                   o.compatible_machine_group, o.source_ps_id, o.source_op_seq_id, o.source_op_no,
                   m.machine_no AS machine_code, m.machine_category, m.shift_profile
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            WHERE b.group_id = %s
            ORDER BY b.queue_position, b.block_id
            """,
            (group_id,),
        )
    )
    if not blocks:
        return {
            "group_id": group_id,
            "group_label": group["group_label"] or "",
            "group_type": group["group_type"] or "COMBINED",
            "ps_id": "",
            "operation_label": "",
            "machine_id": 0,
            "machine_code": "",
            "shift_profile": "",
            "blocks": [],
            "target_qty": 0.0,
            "setup_minutes": 0.0,
            "cycle_minutes_per_qty": 0.0,
            "actual_good_qty": 0.0,
            "actual_reject_qty": 0.0,
            "paired_output_qty": 0.0,
            "paired_remaining_qty": 0.0,
            "paired_remaining_minutes": 0.0,
            "remaining_qty": 0.0,
            "remaining_minutes": 0.0,
            "status": "NOT_STARTED",
            "planning_status": "UNPLANNED",
            "group_start": "",
            "group_end": "",
        }

    member_rows = []
    first_block = blocks[0]
    for block in blocks:
        totals = actual_totals_for_block(con, block["block_id"])
        output_qty = float(totals["output_qty"] or 0)
        reject_qty = float(totals["reject_qty"] or 0)
        scheduled_qty = max(0.0, float(block["scheduled_qty"] or 0))
        valid_done = max(0.0, output_qty - reject_qty)
        remaining_qty = max(0.0, scheduled_qty - valid_done)

        def _dt_str(v):
            return planner_wall_datetime_to_api(v)

        member_rows.append(
            {
                "block_id": int(block["block_id"]),
                "operation_id": int(block["operation_id"]),
                "machine_id": int(block["machine_id"]),
                "queue_position": float(block["queue_position"] or 0),
                "job_no": block["job_no"] or "",
                "operation_name": block["operation_name"] or "",
                "source_op_no": block["source_op_no"] or "",
                "scheduled_qty": scheduled_qty,
                "output_qty": output_qty,
                "reject_qty": reject_qty,
                "valid_done_qty": valid_done,
                "remaining_qty": remaining_qty,
                "remaining_minutes": remaining_qty * max(0.0, float(block["cycle_minutes_per_qty"] or 0)),
                "setup_minutes": float(block["setup_minutes"] or 0),
                "cycle_minutes_per_qty": float(block["cycle_minutes_per_qty"] or 0),
                "planning_status": block["planning_status"] or "",
                "execution_status": block["execution_status"] or "",
                "status": block["status"] or "",
                "anchor_datetime": _dt_str(block["anchor_datetime"]),
                "calculated_start_datetime": _dt_str(block["calculated_start_datetime"]),
                "calculated_end_datetime": _dt_str(block["calculated_end_datetime"]),
                "block_type": block["block_type"] or "ORIGINAL",
                "machine_code": block["machine_code"] or "",
                "machine_category": block["machine_category"] or "",
            }
        )

    target_qty = max((row["scheduled_qty"] for row in member_rows), default=0.0)
    max_setup = max((row["setup_minutes"] for row in member_rows), default=0.0)
    cycle_sum = sum(row["cycle_minutes_per_qty"] for row in member_rows)
    actual_good_qty = sum(row["valid_done_qty"] for row in member_rows)
    actual_reject_qty = sum(row["reject_qty"] for row in member_rows)
    # paired_good_qty = the bottleneck output (minimum across members)
    paired_good_qty = min((row["valid_done_qty"] for row in member_rows), default=0.0)
    remaining_qty = max(0.0, target_qty - paired_good_qty)
    remaining_minutes = remaining_qty * cycle_sum
    for row in member_rows:
        row["member_net_output"] = row["valid_done_qty"]
        row["paired_excess_qty"] = max(0.0, row["valid_done_qty"] - paired_good_qty)
        row["paired_shortfall_qty"] = max(0.0, paired_good_qty - row["valid_done_qty"])
    starts = [row["calculated_start_datetime"] for row in member_rows if compact_text(row["calculated_start_datetime"])]
    ends = [row["calculated_end_datetime"] for row in member_rows if compact_text(row["calculated_end_datetime"])]
    status_values = [compact_text(row["execution_status"] or row["status"]).upper() for row in member_rows]
    planning_values = [compact_text(row["planning_status"]).upper() for row in member_rows]
    status = (
        "DONE" if status_values and all(t == "DONE" for t in status_values)
        else ("IN_PROGRESS" if any(t in {"IN_PROGRESS", "DONE"} for t in status_values)
              else "NOT_STARTED")
    )
    planning_status = (
        "PARTIALLY_PLANNED" if "PARTIALLY_PLANNED" in planning_values
        else ("PLANNED" if planning_values and all(t == "PLANNED" for t in planning_values)
              else (planning_values[0] if planning_values else "UNPLANNED"))
    )
    ps_id = compact_text(first_block["job_no"] or first_block["source_ps_id"] or "")
    operation_label = group["group_label"] or " & ".join(
        compact_text(row["source_op_no"] or row["operation_name"] or f"Block {row['block_id']}")
        for row in member_rows
        if compact_text(row["source_op_no"] or row["operation_name"])
    )

    return {
        "group_id": group_id,
        "group_label": group["group_label"] or "",
        "group_type": group["group_type"] or "COMBINED",
        "ps_id": ps_id,
        "operation_label": operation_label,
        "machine_id": int(first_block["machine_id"] or 0),
        "machine_code": first_block["machine_code"] or "",
        "shift_profile": first_block["shift_profile"] or "",
        "blocks": member_rows,
        "target_qty": target_qty,
        "setup_minutes": max_setup,
        "cycle_minutes_per_qty": cycle_sum,
        "actual_good_qty": actual_good_qty,
        "actual_reject_qty": actual_reject_qty,
        "paired_output_qty": paired_good_qty,   # bug fix: was undefined `paired_output_qty` in original
        "paired_remaining_qty": remaining_qty,
        "paired_remaining_minutes": remaining_minutes,
        "remaining_qty": remaining_qty,
        "remaining_minutes": remaining_minutes,
        "status": status,
        "planning_status": planning_status,
        "group_start": min(starts) if starts else "",
        "group_end": max(ends) if ends else "",
    }


# ---------------------------------------------------------------------------
# Planning card helpers
# ---------------------------------------------------------------------------

def planning_card_row(con, card_id):
    return one(
        con.execute(
            """
            SELECT c.*, c.planner_ps_id AS ps_id, m.machine_no AS machine_code
            FROM planner_planning_card c
            LEFT JOIN planner_machines m ON m.machine_id = c.machine_id
            WHERE c.card_id = %s
            """,
            (int(card_id),),
        )
    )


def planning_card_payload(con, card_id):
    card = planning_card_row(con, card_id)
    if not card:
        return None
    ops = rows(
        con.execute(
            """
            SELECT *
            FROM planner_planning_card_operation
            WHERE card_id = %s
            ORDER BY op_sequence, card_op_id
            """,
            (int(card_id),),
        )
    )
    op_rows = [dict(op) for op in ops]
    label = compact_text(card["operation_label"])
    if not label:
        label = " & ".join(
            compact_text(op["source_op_no"] or f"Op {op['op_sequence']}")
            for op in op_rows
            if compact_text(op["source_op_no"])
        )
    operation_name = " + ".join(
        compact_text(op.get("op_type") or op.get("operation_name") or op.get("source_op_no"))
        for op in op_rows
        if compact_text(op.get("op_type") or op.get("operation_name") or op.get("source_op_no"))
    )
    target_qty = float(card["target_qty"] or 0)
    setup_minutes = max((float(op["setup_minutes"] or 0) for op in op_rows), default=0.0)
    cycle_minutes_per_qty = sum(float(op["cycle_minutes_per_qty"] or 0) for op in op_rows)
    return {
        "card_id": int(card["card_id"]),
        "ps_id": card["ps_id"] or "",
        "operation_label": label,
        "operation_name": operation_name,
        "target_qty": target_qty,
        "planning_status": card["planning_status"] or "UNSCHEDULED",
        "card_kind": "group",
        "card_type": card["card_type"] or "NORMAL",
        "machine_id": int(card["machine_id"] or 0),
        "machine_code": card["machine_code"] or "",
        "scheduled_block_group_id": int(card["scheduled_block_group_id"] or 0),
        "is_scheduled": compact_text(card["planning_status"]).upper() == "SCHEDULED" or int(card["scheduled_block_group_id"] or 0) > 0,
        "setup_minutes": setup_minutes,
        "cycle_minutes_per_qty": cycle_minutes_per_qty,
        "ops": [
            {
                "card_op_id": int(op["card_op_id"]),
                "source_ps_id": op["source_ps_id"] or "",
                "source_op_seq_id": int(op["source_op_seq_id"] or 0),
                "source_op_no": op["source_op_no"] or "",
                "op_sequence": int(op["op_sequence"] or 0),
                "setup_minutes": float(op["setup_minutes"] or 0),
                "cycle_minutes_per_qty": float(op["cycle_minutes_per_qty"] or 0),
                "target_qty": float(op["target_qty"] or 0),
            }
            for op in op_rows
        ],
    }


def planning_cards_by_ps(con):
    cards = rows(
        con.execute(
            """
            SELECT c.*, c.planner_ps_id AS ps_id, m.machine_no AS machine_code
            FROM planner_planning_card c
            LEFT JOIN planner_machines m ON m.machine_id = c.machine_id
            ORDER BY c.planner_ps_id, c.card_id
            """
        )
    )
    if not cards:
        return {}
    card_ids = [int(card["card_id"]) for card in cards]
    ops_by_card = {}
    for op in rows(
        con.execute(
            """
            SELECT *
            FROM planner_planning_card_operation
            WHERE card_id = ANY(%s)
            ORDER BY card_id, op_sequence, card_op_id
            """,
            (card_ids,),
        )
    ):
        ops_by_card.setdefault(int(op["card_id"]), []).append(op)

    grouped = {}
    for card in cards:
        card_id = int(card["card_id"])
        op_rows = [dict(op) for op in ops_by_card.get(card_id, [])]
        label = compact_text(card["operation_label"])
        if not label:
            label = " & ".join(
                compact_text(op["source_op_no"] or f"Op {op['op_sequence']}")
                for op in op_rows
                if compact_text(op["source_op_no"])
            )
        operation_name = " + ".join(
            compact_text(op.get("op_type") or op.get("operation_name") or op.get("source_op_no"))
            for op in op_rows
            if compact_text(op.get("op_type") or op.get("operation_name") or op.get("source_op_no"))
        )
        target_qty = float(card["target_qty"] or 0)
        setup_minutes = max((float(op["setup_minutes"] or 0) for op in op_rows), default=0.0)
        cycle_minutes_per_qty = sum(float(op["cycle_minutes_per_qty"] or 0) for op in op_rows)
        ps_id = compact_text(card.get("ps_id") or card.get("planner_ps_id"))
        item = {
            "card_id": card_id,
            "ps_id": ps_id,
            "operation_label": label,
            "operation_name": operation_name,
            "target_qty": target_qty,
            "planning_status": card["planning_status"] or "UNSCHEDULED",
            "card_kind": "group",
            "card_type": card["card_type"] or "NORMAL",
            "machine_id": int(card["machine_id"] or 0),
            "machine_code": card["machine_code"] or "",
            "scheduled_block_group_id": int(card["scheduled_block_group_id"] or 0),
            "is_scheduled": compact_text(card["planning_status"]).upper() == "SCHEDULED" or int(card["scheduled_block_group_id"] or 0) > 0,
            "setup_minutes": setup_minutes,
            "cycle_minutes_per_qty": cycle_minutes_per_qty,
            "ops": [
                {
                    "card_op_id": int(op["card_op_id"]),
                    "source_ps_id": op["source_ps_id"] or "",
                    "source_op_seq_id": int(op["source_op_seq_id"] or 0),
                    "source_op_no": op["source_op_no"] or "",
                    "op_sequence": int(op["op_sequence"] or 0),
                    "setup_minutes": float(op["setup_minutes"] or 0),
                    "cycle_minutes_per_qty": float(op["cycle_minutes_per_qty"] or 0),
                    "target_qty": float(op["target_qty"] or 0),
                }
                for op in op_rows
            ],
        }
        grouped.setdefault(ps_id, []).append(item)
    return grouped


def planning_card_covered_op_keys(con):
    covered = {}
    for row in rows(
        con.execute(
            """
            SELECT pc.planner_ps_id AS ps_id,
                   pco.source_op_seq_id AS source_op_seq_id, pco.source_op_no
            FROM planner_planning_card pc
            JOIN planner_planning_card_operation pco ON pco.card_id = pc.card_id
            """
        )
    ):
        ps_id = compact_text(row["ps_id"])
        op_key = trial_catalog_op_key(ps_id, row["source_op_no"], row["source_op_seq_id"])
        covered.setdefault(ps_id, set()).add(op_key)
    return covered


def planning_card_target_from_ops(ops):
    return max([float(op.get("total_qty") or op.get("remaining_qty") or 0) for op in ops] or [0.0])


def planning_card_label_from_ops(ops):
    labels = []
    for op in ops:
        label = compact_text(op.get("source_op_no") or op.get("op_no") or op.get("operation_name"))
        if label:
            labels.append(label)
    return " & ".join(labels)


def create_planning_card(con, ps_id, ops, target_qty=None):
    ps_id = compact_text(ps_id)
    ops = [op for op in ops if op]
    if not ps_id:
        raise ValueError("Process sheet is required")
    if len(ops) < 2:
        raise ValueError("Choose at least two operations.")
    ps = ensure_planner_process_sheet(con, ps_id)
    if not ps:
        raise ValueError(f"Process sheet not found: {ps_id}")
    selected_bom_id = int(ps["selected_bom_id"] or 0)
    if not selected_bom_id:
        raise ValueError(f"Process sheet has no selected flow: {ps_id}")

    normalized_ops = []
    seen_ops = set()
    for op in ops:
        op_ps_id = compact_text(op.get("source_ps_id") or op.get("ps_id") or ps_id)
        if op_ps_id and op_ps_id != ps_id:
            raise ValueError("Combine operations from the same process sheet.")
        source_op_seq_id = int(op.get("source_op_seq_id") or 0)
        source_op_no = compact_text(op.get("source_op_no") or op.get("op_no"))
        if not source_op_seq_id and not source_op_no:
            raise ValueError("Operation not found in this process sheet.")
        dedupe_key = (source_op_seq_id or 0, source_op_no.upper())
        if dedupe_key in seen_ops:
            raise ValueError("Duplicate operation selected.")
        seen_ops.add(dedupe_key)
        normalized_ops.append(op)

    resolved_ops = []
    for idx, op in enumerate(normalized_ops, 1):
        source_op_seq_id = int(op.get("source_op_seq_id") or 0)
        source_op_no = compact_text(op.get("source_op_no") or op.get("op_no"))
        step = None
        if source_op_seq_id:
            step = one(
                con.execute(
                    "SELECT * FROM planner_operation_seq WHERE op_seq_id = %s AND bom_id = %s",
                    (source_op_seq_id, selected_bom_id),
                )
            )
        if not step and source_op_no:
            step = one(
                con.execute(
                    """
                    SELECT * FROM planner_operation_seq
                    WHERE bom_id = %s AND op_no = %s
                    ORDER BY seq_no, op_seq_id LIMIT 1
                    """,
                    (selected_bom_id, source_op_no),
                )
            )
        if not step:
            raise ValueError("Operation not found in this process sheet.")
        resolved_ops.append((idx, step, source_op_no))

    actual_target_qty = float(target_qty or 0)
    if actual_target_qty <= 0:
        actual_target_qty = planning_card_target_from_ops(ops)
    if actual_target_qty <= 0:
        raise ValueError("Target qty is required")

    operation_label = planning_card_label_from_ops(ops)
    card_type = "COMBINED"
    card_cur = con.execute(
        """
        INSERT INTO planner_planning_card (
          planner_ps_id, operation_label, target_qty, planning_status, card_type, created_at, updated_at
        ) VALUES (%s, %s, %s, 'UNSCHEDULED', %s, NOW(), NOW())
        RETURNING card_id
        """,
        (ps_id, operation_label, actual_target_qty, card_type),
    )
    card_id = int(one(card_cur)["card_id"])
    for idx, step, source_op_no in resolved_ops:
        con.execute(
            """
            INSERT INTO planner_planning_card_operation (
              card_id, source_ps_id, source_op_seq_id, source_op_no, op_sequence,
              setup_minutes, cycle_minutes_per_qty, target_qty
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                card_id,
                ps_id,
                int(step["op_seq_id"] or 0),
                source_op_no or (step["op_no"] or ""),
                idx,
                parse_number(step["setup_time"], 0),
                parse_number(step["cycle_time"], 0),
                actual_target_qty,
            ),
        )
    return planning_card_payload(con, card_id)


def schedule_planning_card(con, card_id, machine_id, queue_position=0):
    card = planning_card_row(con, card_id)
    if not card:
        raise ValueError("Combined op card not found")
    if compact_text(card["planning_status"]).upper() == "SCHEDULED" and int(card["scheduled_block_group_id"] or 0) > 0:
        raise ValueError("Combined op card is already scheduled")
    machine_id = int(machine_id or card["machine_id"] or 0)
    if not machine_id:
        raise ValueError("Machine is required")
    machine = one(
        con.execute(
            "SELECT * FROM planner_machines WHERE machine_id = %s AND active = TRUE",
            (machine_id,),
        )
    )
    if not machine:
        raise ValueError("Machine not found")
    ops = rows(
        con.execute(
            """
            SELECT * FROM planner_planning_card_operation
            WHERE card_id = %s
            ORDER BY op_sequence, card_op_id
            """,
            (int(card_id),),
        )
    )
    if not ops:
        raise ValueError("Combined op card has no operations")

    group_label = compact_text(card["operation_label"])
    if not group_label:
        group_label = " & ".join(
            compact_text(op["source_op_no"] or f"Op {op['op_sequence']}")
            for op in ops
            if compact_text(op["source_op_no"])
        )
    if not group_label:
        group_label = "Planned card"

    group_cur = con.execute(
        "INSERT INTO planner_run_block_group (group_label, group_type) VALUES (%s, 'PLANNED_CARD') RETURNING group_id",
        (group_label,),
    )
    group_id = int(one(group_cur)["group_id"])

    max_position = float(
        one(
            con.execute(
                "SELECT COALESCE(MAX(queue_position), 0) AS mx FROM planner_run_block WHERE machine_id = %s",
                (machine_id,),
            )
        )["mx"]
        or 0
    )
    if queue_position <= 0:
        queue_position = max_position + 1

    created_block_ids = []
    for idx, op in enumerate(ops, 1):
        op_ps_id = compact_text(op["source_ps_id"])
        ps = ensure_planner_process_sheet(con, op_ps_id)
        if not ps:
            raise ValueError(f"Process sheet not found: {op_ps_id}")
        step = one(
            con.execute(
                "SELECT * FROM planner_operation_seq WHERE op_seq_id = %s AND bom_id = %s",
                (int(op["source_op_seq_id"] or 0), int(ps["selected_bom_id"] or 0)),
            )
        )
        if not step and compact_text(op["source_op_no"]):
            step = one(
                con.execute(
                    """
                    SELECT * FROM planner_operation_seq
                    WHERE bom_id = %s AND op_no = %s
                    ORDER BY seq_no, op_seq_id LIMIT 1
                    """,
                    (int(ps["selected_bom_id"] or 0), compact_text(op["source_op_no"])),
                )
            )
        if not step:
            raise ValueError(f"Operation not found for scheduling: {op['source_op_no'] or op['source_op_seq_id']}")

        bom_row = one(
            con.execute(
                """
                SELECT bv.inventory_code, bv.bom_code
                FROM planner_bom_variation bv
                WHERE bv.bom_id = %s
                """,
                (int(ps["selected_bom_id"] or 0),),
            )
        ) if int(ps.get("selected_bom_id") or 0) > 0 else None
        part_no = compact_text(
            (bom_row or {}).get("inventory_code") or ps.get("inventory_code") or ""
        )
        bom_code = compact_text((bom_row or {}).get("bom_code") or "")
        resolved_times = {"cycle_time": parse_number(step["cycle_time"], 0), "set_up_time": parse_number(step["setup_time"], 0)}
        if part_no:
            try:
                from .cycle_time_service import resolve_step_times

                resolved_times = resolve_step_times(
                    con,
                    part_no=part_no,
                    bom_code=bom_code,
                    step=step,
                )
            except Exception:
                pass

        op_name = f"{step['op_no'] or ''} {step['op_type'] or ''}".strip()
        op_cur = con.execute(
            """
            INSERT INTO planner_operation (
              job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty,
              compatible_machine_group, source_ps_id, source_op_seq_id, source_op_no,
              status, remarks, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'ACTIVE', '', NOW())
            RETURNING operation_id
            """,
            (
                op_ps_id,
                op_name,
                float(card["target_qty"] or 0),
                parse_number(resolved_times.get("set_up_time"), parse_number(step["setup_time"], 0)),
                parse_number(resolved_times.get("cycle_time"), parse_number(step["cycle_time"], 0)),
                compact_text(step["machine_category"]) or compact_text(machine["machine_category"]) or "UNKNOWN",
                op_ps_id,
                int(step["op_seq_id"] or 0),
                compact_text(step["op_no"]),
            ),
        )
        operation_id = int(one(op_cur)["operation_id"])

        block_cur = con.execute(
            """
            INSERT INTO planner_run_block (
              operation_id, machine_id, queue_position, scheduled_qty, include_setup,
              status, planning_status, execution_status,
              anchor_datetime, calculated_start_datetime, calculated_end_datetime,
              actual_good_qty, actual_reject_qty, remarks, group_id, updated_at
            ) VALUES (%s, %s, %s, %s, TRUE, 'NOT_STARTED', 'PLANNED', 'NOT_STARTED',
                      NULL, NULL, NULL, 0, 0, '', %s, NOW())
            RETURNING block_id
            """,
            (
                operation_id,
                machine_id,
                float(queue_position) + idx - 1,
                float(card["target_qty"] or 0),
                group_id,
            ),
        )
        new_block_id = int(one(block_cur)["block_id"])
        created_block_ids.append(new_block_id)
        if idx == 1:
            from .auto_unschedule import apply_saved_anchor_to_new_block

            apply_saved_anchor_to_new_block(
                con,
                new_block_id,
                compact_text(ops[0]["source_ps_id"]),
                compact_text(ops[0]["source_op_no"]),
                group_id=group_id,
            )

    con.execute(
        """
        UPDATE planner_planning_card
        SET planning_status = 'SCHEDULED', machine_id = %s, scheduled_block_group_id = %s, updated_at = NOW()
        WHERE card_id = %s
        """,
        (machine_id, group_id, int(card_id)),
    )

    machine_blocks = rows(
        con.execute(
            """
            SELECT block_id
            FROM planner_run_block
            WHERE machine_id = %s
              AND COALESCE(active, TRUE) = TRUE
            ORDER BY queue_position, block_id
            """,
            (machine_id,),
        )
    )
    created_block_id_set = set(created_block_ids)
    ordered_ids = [int(row["block_id"]) for row in machine_blocks if int(row["block_id"]) not in created_block_id_set]
    insert_idx = min(max(0, int(queue_position) - 1), len(ordered_ids)) if queue_position > 0 else len(ordered_ids)
    ordered_ids[insert_idx:insert_idx] = created_block_ids
    from .operation_sequence import apply_machine_queue_order

    apply_machine_queue_order(con, machine_id, ordered_ids, recalculate=False)

    return {
        "card": planning_card_payload(con, card_id),
        "group": combined_group_summary(con, group_id),
        "block_ids": created_block_ids,
        "group_id": group_id,
    }
