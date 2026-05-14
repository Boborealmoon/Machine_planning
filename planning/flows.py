"""planning/flows.py — process-sheet flow / operation-sequence routes (PostgreSQL port)."""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from .helpers import one, rows, planner_db
from .materials import sync_material_requirements_for_ps
from .utils import compact_text, parse_number

flows_bp = Blueprint("planner_flows", __name__)
trial_prefixed_flows_bp = Blueprint("trial_planner_flows", __name__)

_PS_FLOW_SELECT = """
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
        v.part_no AS part_name,
        v.description AS part_desc,
        sf.bom_code AS selected_flow_code
    FROM planner_process_sheet ps
    LEFT JOIN pp_vouchers_cache v
           ON v.ps_id = ps.source_ps_id AND v.pp_partial_no = ps.pp_partial_no
    LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
"""


@trial_prefixed_flows_bp.get("/api/trial/process-sheets/<path:ps_id>")
@flows_bp.get("/api/process-sheets/<path:ps_id>")
def api_process_sheet(ps_id):
    with planner_db() as con:
        row = one(
            con.execute(
                _PS_FLOW_SELECT + " WHERE ps.planner_ps_id = %s",
                (ps_id,),
            )
        )
        if not row:
            return jsonify({"error": "Process sheet not found"}), 404
        payload = dict(row)
        payload["part_name"] = payload.get("part_name") or ""
        payload["part_desc"] = payload.get("part_desc") or ""
        payload["selected_flow_code"] = payload.get("selected_flow_code") or ""
        payload["planning_cards"] = []
        return jsonify(payload)


@trial_prefixed_flows_bp.put("/api/trial/process-sheets/<path:ps_id>/flow")
@flows_bp.put("/api/process-sheets/<path:ps_id>/flow")
def api_process_sheet_selected_flow(ps_id):
    data = request.get_json(force=True, silent=True) or {}
    bom_id = int(data.get("bom_id") or 0)
    flow_code = compact_text(data.get("flow_code"))
    with planner_db() as con:
        ps = one(
            con.execute(
                _PS_FLOW_SELECT + " WHERE ps.planner_ps_id = %s",
                (ps_id,),
            )
        )
        if not ps:
            return jsonify({"error": "Process sheet not found"}), 404
        inventory_code = compact_text(ps.get("inventory_code") or "")
        flow = None
        if bom_id > 0:
            flow = one(
                con.execute(
                    """
                    SELECT bom_id, bom_code
                    FROM planner_bom_variation
                    WHERE bom_id = %s AND inventory_code = %s
                    """,
                    (bom_id, inventory_code),
                )
            )
        elif flow_code:
            flow = one(
                con.execute(
                    """
                    SELECT bom_id, bom_code
                    FROM planner_bom_variation
                    WHERE inventory_code = %s AND bom_code = %s
                    """,
                    (inventory_code, flow_code),
                )
            )
        if not flow:
            return jsonify({"error": "Flow not found for this PS"}), 404
        con.execute(
            """
            UPDATE planner_process_sheet
            SET selected_bom_id = %s, updated_at = NOW()
            WHERE planner_ps_id = %s
            """,
            (int(flow["bom_id"]), ps_id),
        )
        sync_material_requirements_for_ps(con, ps_id)
        return jsonify(
            {
                "ok": True,
                "ps_id": ps_id,
                "selected_bom_id": int(flow["bom_id"]),
                "selected_flow_code": flow["bom_code"] or "",
            }
        )


@trial_prefixed_flows_bp.get("/api/trial/inventory/<path:inventory_code>/flows")
@flows_bp.get("/api/inventory/<path:inventory_code>/flows")
def api_inventory_flows(inventory_code):
    inventory_code = compact_text(inventory_code)
    if not inventory_code:
        return jsonify({"error": "inventory_code is required"}), 400
    with planner_db() as con:
        flow_rows = rows(
            con.execute(
                """
                SELECT bom_id, bom_code AS flow_code, bom_desc AS flow_name, is_default
                FROM planner_bom_variation
                WHERE inventory_code = %s
                ORDER BY is_default DESC, bom_id
                """,
                (inventory_code,),
            )
        )
        result = []
        for flow in flow_rows:
            steps = rows(
                con.execute(
                    """
                    SELECT op_seq_id, bom_id, seq_no, op_no, op_type, machine_category,
                           preferred_machine, cycle_time, setup_time, is_last_op
                    FROM planner_operation_seq
                    WHERE bom_id = %s
                    ORDER BY seq_no, op_seq_id
                    """,
                    (int(flow["bom_id"]),),
                )
            )
            item = dict(flow)
            item["is_default"] = bool(item.get("is_default"))
            item["steps"] = [
                {**dict(step), "is_last_op": int(bool(step.get("is_last_op")))}
                for step in steps
            ]
            result.append(item)
        return jsonify(result)


@trial_prefixed_flows_bp.put("/api/trial/flows/<int:bom_id>")
@flows_bp.put("/api/flows/<int:bom_id>")
def api_update_flow(bom_id):
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        flow = one(
            con.execute(
                "SELECT * FROM planner_bom_variation WHERE bom_id = %s",
                (int(bom_id),),
            )
        )
        if not flow:
            return jsonify({"error": "Flow not found"}), 404
        flow_code = compact_text(data.get("flow_code")) or flow["bom_code"]
        is_default = bool(data.get("is_default"))
        con.execute(
            "UPDATE planner_bom_variation SET bom_code = %s, is_default = %s WHERE bom_id = %s",
            (flow_code, is_default, int(bom_id)),
        )
        steps = data.get("steps") or []
        con.execute(
            "DELETE FROM planner_operation_seq WHERE bom_id = %s",
            (int(bom_id),),
        )
        for idx, step in enumerate(steps, 1):
            preferred_machine = compact_text(step.get("preferred_machine"))
            machine_category = compact_text(step.get("machine_category")) or "UNKNOWN"
            if preferred_machine:
                machine_row = one(
                    con.execute(
                        "SELECT machine_category FROM planner_machines WHERE machine_no = %s",
                        (preferred_machine,),
                    )
                )
                machine_category = (
                    compact_text(machine_row["machine_category"] if machine_row else machine_category)
                    or "UNKNOWN"
                )
            con.execute(
                """
                INSERT INTO planner_operation_seq (
                    bom_id, seq_no, op_no, op_type, machine_category,
                    preferred_machine, cycle_time, setup_time, is_last_op
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    int(bom_id),
                    idx,
                    compact_text(step.get("op_no")),
                    compact_text(step.get("op_type")),
                    machine_category,
                    preferred_machine,
                    parse_number(step.get("cycle_time"), 0),
                    parse_number(step.get("setup_time"), 0),
                    idx == len(steps) or bool(step.get("is_last_op")),
                ),
            )
        return jsonify({"ok": True})
