"""planning/flows.py — process-sheet flow / operation-sequence routes (PostgreSQL port)."""
from __future__ import annotations

import threading

from flask import Blueprint, jsonify, request

from .helpers import one, rows, planner_db
from .materials import sync_material_requirements_for_ps
from .process_sheets import ensure_planner_process_sheet, format_planner_ps_id
from .utils import compact_text, parse_number

flows_bp = Blueprint("planner_flows", __name__)
trial_prefixed_flows_bp = Blueprint("trial_planner_flows", __name__)

_SOURCE_KINDS = {"ERP", "MANUAL", "MIXED"}
_FLOW_SCHEMA_READY = False
_FLOW_SCHEMA_LOCK = threading.Lock()


def _ensure_flow_source_columns(con):
    global _FLOW_SCHEMA_READY
    if _FLOW_SCHEMA_READY:
        return
    with _FLOW_SCHEMA_LOCK:
        if _FLOW_SCHEMA_READY:
            return
        _ensure_flow_source_columns_uncached(con)
        _FLOW_SCHEMA_READY = True


def _ensure_flow_source_columns_uncached(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_bom_variation (
            bom_id          BIGSERIAL    PRIMARY KEY,
            inventory_code  TEXT         NOT NULL,
            bom_code        TEXT         NOT NULL,
            bom_desc        TEXT         NOT NULL DEFAULT '',
            is_default      BOOLEAN      NOT NULL DEFAULT FALSE,
            source_kind     TEXT         NOT NULL DEFAULT 'ERP',
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (inventory_code, bom_code)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_operation_seq (
            op_seq_id         BIGSERIAL    PRIMARY KEY,
            bom_id            BIGINT       NOT NULL REFERENCES planner_bom_variation(bom_id) ON DELETE CASCADE,
            seq_no            INTEGER      NOT NULL,
            op_no             TEXT         NOT NULL,
            op_type           TEXT         NOT NULL,
            machine_category  TEXT         NOT NULL,
            cycle_time        NUMERIC      NOT NULL DEFAULT 1,
            setup_time        NUMERIC      NOT NULL DEFAULT 0,
            preferred_machine TEXT         NOT NULL DEFAULT '',
            is_last_op        BOOLEAN      NOT NULL DEFAULT FALSE,
            source_kind       TEXT         NOT NULL DEFAULT 'ERP',
            source_stage_no   INTEGER,
            planner_note      TEXT         NOT NULL DEFAULT '',
            UNIQUE (bom_id, seq_no, op_no)
        )
        """
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_planner_bom_variation_inv_code ON planner_bom_variation(inventory_code)"
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_planner_operation_seq_bom_id ON planner_operation_seq(bom_id)"
    )
    con.execute(
        """
        ALTER TABLE planner_bom_variation
            ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'ERP'
        """
    )
    con.execute(
        """
        ALTER TABLE planner_operation_seq
            ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'ERP'
        """
    )
    con.execute(
        """
        ALTER TABLE planner_operation_seq
            ADD COLUMN IF NOT EXISTS source_stage_no INTEGER
        """
    )
    con.execute(
        """
        ALTER TABLE planner_operation_seq
            ADD COLUMN IF NOT EXISTS planner_note TEXT NOT NULL DEFAULT ''
        """
    )


def _source_kind(value, default="ERP"):
    kind = compact_text(value).upper()
    return kind if kind in _SOURCE_KINDS else default


def _stage_source_kind(step):
    if int(step.get("source_stage_no") or 0) > 0:
        return "ERP"
    explicit = compact_text(step.get("source_kind")).upper()
    if explicit in {"ERP", "MANUAL"}:
        return explicit
    return "ERP" if int(step.get("op_seq_id") or 0) > 0 else "MANUAL"


def _combined_flow_source_kind(stage_kinds, default="ERP"):
    kinds = {kind for kind in stage_kinds if kind in {"ERP", "MANUAL"}}
    if not kinds:
        return default
    return kinds.pop() if len(kinds) == 1 else "MIXED"


def _steps_include_manual(steps):
    return any(_stage_source_kind(step) == "MANUAL" for step in (steps or []))


def _flow_should_fork_to_planner_variation(flow, steps):
    """Keep ERP bom_variation rows immutable; planner edits become their own variation."""
    flow_kind = compact_text(flow.get("source_kind")).upper() or "ERP"
    if flow_kind != "ERP":
        return False
    return _steps_include_manual(steps)


def _unique_planner_variation_code(con, inventory_code, base_code):
    inventory_code = compact_text(inventory_code)
    base_code = compact_text(base_code) or "MANUAL"
    stem = base_code if base_code.upper().endswith("-PLANNER") else f"{base_code}-PLANNER"
    candidate = stem
    suffix = 2
    while one(
        con.execute(
            """
            SELECT 1 AS ok
            FROM planner_bom_variation
            WHERE inventory_code = %s AND bom_code = %s
            """,
            (inventory_code, candidate),
        )
    ):
        candidate = f"{stem}-{suffix}"
        suffix += 1
    return candidate


def _insert_planner_bom_variation(
    con,
    *,
    inventory_code,
    bom_code,
    bom_desc,
    is_default,
    flow_source_kind,
):
    if is_default:
        con.execute(
            "UPDATE planner_bom_variation SET is_default = FALSE WHERE inventory_code = %s",
            (inventory_code,),
        )
    return one(
        con.execute(
            """
            INSERT INTO planner_bom_variation (
                inventory_code, bom_code, bom_desc, is_default, source_kind,
                created_at, updated_at
            ) VALUES (%s, %s, %s, %s, %s, NOW(), NOW())
            ON CONFLICT (inventory_code, bom_code) DO UPDATE SET
              bom_desc = EXCLUDED.bom_desc,
              is_default = EXCLUDED.is_default,
              source_kind = EXCLUDED.source_kind,
              updated_at = NOW()
            RETURNING bom_id, inventory_code, bom_code, bom_desc, is_default, source_kind
            """,
            (
                inventory_code,
                bom_code,
                bom_desc,
                is_default,
                flow_source_kind,
            ),
        )
    )


def _ps_id_variants_for_relink(planner_ps_id, source_ps_id, pp_partial_no=1):
    """All planner_operation source_ps_id values that may reference one PS partial."""
    variants = set()
    planner_ps_id = compact_text(planner_ps_id)
    source_ps_id = compact_text(source_ps_id)
    try:
        partial_no = max(1, int(pp_partial_no or 1))
    except (TypeError, ValueError):
        partial_no = 1
    if planner_ps_id:
        variants.add(planner_ps_id)
    if source_ps_id:
        variants.add(source_ps_id)
        formatted = format_planner_ps_id(source_ps_id, partial_no)
        if formatted:
            variants.add(formatted)
    return [value for value in variants if value]


def _relink_planner_op_seq_ids_for_bom(con, bom_id, planner_ps_ids=None):
    """Point queued ops at new planner_operation_seq rows after a BOM save (same op_no)."""
    bom_id = int(bom_id or 0)
    if bom_id <= 0:
        return
    step_rows = rows(
        con.execute(
            """
            SELECT op_seq_id, op_no
            FROM planner_operation_seq
            WHERE bom_id = %s
            ORDER BY seq_no, op_seq_id
            """,
            (bom_id,),
        )
    )
    if not step_rows:
        return

    wanted_ps_ids = [compact_text(pid) for pid in (planner_ps_ids or []) if compact_text(pid)]
    if wanted_ps_ids:
        ps_rows = rows(
            con.execute(
                """
                SELECT planner_ps_id, source_ps_id, pp_partial_no
                FROM planner_process_sheet
                WHERE planner_ps_id = ANY(%s)
                """,
                (wanted_ps_ids,),
            )
        )
    else:
        ps_rows = rows(
            con.execute(
                """
                SELECT planner_ps_id, source_ps_id, pp_partial_no
                FROM planner_process_sheet
                WHERE selected_bom_id = %s
                """,
                (bom_id,),
            )
        )
    if not ps_rows:
        return

    ps_id_variants = set()
    planner_ps_id_list = []
    for ps in ps_rows:
        planner_ps_id_list.append(compact_text(ps["planner_ps_id"]))
        for variant in _ps_id_variants_for_relink(
            ps.get("planner_ps_id"),
            ps.get("source_ps_id"),
            ps.get("pp_partial_no"),
        ):
            ps_id_variants.add(variant)
    if not ps_id_variants:
        return

    ps_id_values = sorted(ps_id_variants)
    planner_ps_id_values = [pid for pid in planner_ps_id_list if pid]

    for step in step_rows:
        op_no = compact_text(step.get("op_no"))
        new_seq = int(step.get("op_seq_id") or 0)
        if not op_no or new_seq <= 0:
            continue
        con.execute(
            """
            UPDATE planner_operation
            SET source_op_seq_id = %s, updated_at = NOW()
            WHERE TRIM(COALESCE(source_op_no, '')) = %s
              AND COALESCE(source_op_seq_id, 0) <> %s
              AND (
                COALESCE(source_ps_id, '') = ANY(%s)
                OR COALESCE(job_no, '') = ANY(%s)
              )
            """,
            (new_seq, op_no, new_seq, ps_id_values, ps_id_values),
        )
        if planner_ps_id_values:
            con.execute(
                """
                UPDATE planner_planning_card_operation pco
                SET source_op_seq_id = %s
                FROM planner_planning_card pc
                WHERE pc.card_id = pco.card_id
                  AND pc.planner_ps_id = ANY(%s)
                  AND TRIM(COALESCE(pco.source_op_no, '')) = %s
                  AND COALESCE(pco.source_op_seq_id, 0) <> %s
                """,
                (new_seq, planner_ps_id_values, op_no, new_seq),
            )


def _save_flow_steps(con, bom_id, steps):
    _ensure_flow_source_columns(con)
    stage_kinds = []
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
        source_kind = _stage_source_kind(step)
        stage_kinds.append(source_kind)
        con.execute(
            """
            INSERT INTO planner_operation_seq (
                bom_id, seq_no, op_no, op_type, machine_category,
                preferred_machine, cycle_time, setup_time, is_last_op,
                source_kind, source_stage_no, planner_note
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                source_kind,
                int(step.get("source_stage_no") or 0) or None,
                compact_text(step.get("planner_note")),
            ),
        )
    _relink_planner_op_seq_ids_for_bom(con, int(bom_id))
    return stage_kinds


def _flow_payload(con, flow):
    _ensure_flow_source_columns(con)
    steps = rows(
        con.execute(
            """
            SELECT op_seq_id, bom_id, seq_no, op_no, op_type, machine_category,
                   preferred_machine, cycle_time, setup_time, is_last_op,
                   source_kind, source_stage_no, planner_note
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
    return item

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
    if compact_text(ps_id).startswith("temp-process-sheets"):
        return jsonify({"error": "Not found"}), 404
    with planner_db() as con:
        try:
            ensure_planner_process_sheet(con, ps_id)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 404
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
        try:
            ensure_planner_process_sheet(con, ps_id)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 404
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
        _relink_planner_op_seq_ids_for_bom(con, int(flow["bom_id"]), planner_ps_ids=[ps_id])
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
        _ensure_flow_source_columns(con)
        flow_rows = rows(
            con.execute(
                """
                SELECT bom_id, bom_code AS flow_code, bom_desc AS flow_name, is_default,
                       source_kind
                FROM planner_bom_variation
                WHERE inventory_code = %s
                ORDER BY is_default DESC, bom_id
                """,
                (inventory_code,),
            )
        )
        return jsonify([_flow_payload(con, flow) for flow in flow_rows])


@trial_prefixed_flows_bp.post("/api/trial/process-sheets/<path:ps_id>/flows")
@flows_bp.post("/api/process-sheets/<path:ps_id>/flows")
def api_create_process_sheet_flow(ps_id):
    data = request.get_json(force=True, silent=True) or {}
    steps = data.get("steps") or []
    flow_code = compact_text(data.get("flow_code")) or "MANUAL"
    is_default = bool(data.get("is_default"))
    with planner_db() as con:
        _ensure_flow_source_columns(con)
        try:
            ps = ensure_planner_process_sheet(con, ps_id)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 404
        if not ps:
            return jsonify({"error": "Process sheet not found"}), 404
        inventory_code = compact_text(ps.get("inventory_code") or "")
        if not inventory_code:
            return jsonify({"error": "Inventory code is required to create a BOM flow"}), 400
        flow_source_kind = _source_kind(data.get("source_kind"), "MANUAL")
        flow_row = _insert_planner_bom_variation(
            con,
            inventory_code=inventory_code,
            bom_code=flow_code,
            bom_desc=compact_text(data.get("flow_name") or data.get("bom_desc")),
            is_default=is_default,
            flow_source_kind=flow_source_kind,
        )
        bom_id = int(flow_row["bom_id"])
        stage_kinds = _save_flow_steps(con, bom_id, steps)
        persisted_source_kind = _combined_flow_source_kind(stage_kinds, flow_source_kind)
        con.execute(
            """
            UPDATE planner_bom_variation
            SET source_kind = %s, updated_at = NOW()
            WHERE bom_id = %s
            """,
            (persisted_source_kind, bom_id),
        )
        con.execute(
            """
            UPDATE planner_process_sheet
            SET selected_bom_id = %s, updated_at = NOW()
            WHERE planner_ps_id = %s
            """,
            (bom_id, ps_id),
        )
        sync_material_requirements_for_ps(con, ps_id)
        refreshed = one(
            con.execute(
                """
                SELECT bom_id, bom_code AS flow_code, bom_desc AS flow_name,
                       is_default, source_kind
                FROM planner_bom_variation
                WHERE bom_id = %s
                """,
                (bom_id,),
            )
        )
        try:
            from app import _invalidate_pp_vouchers_with_ops_cache

            _invalidate_pp_vouchers_with_ops_cache()
        except Exception:
            pass
        return jsonify({"ok": True, "flow": _flow_payload(con, refreshed)})


@trial_prefixed_flows_bp.put("/api/trial/flows/<int:bom_id>")
@flows_bp.put("/api/flows/<int:bom_id>")
def api_update_flow(bom_id):
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        _ensure_flow_source_columns(con)
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
        steps = data.get("steps") or []
        inventory_code = compact_text(flow["inventory_code"])

        if _flow_should_fork_to_planner_variation(flow, steps):
            new_code = _unique_planner_variation_code(con, inventory_code, flow_code)
            erp_code = compact_text(flow["bom_code"])
            flow_row = _insert_planner_bom_variation(
                con,
                inventory_code=inventory_code,
                bom_code=new_code,
                bom_desc=f"Planner route from {erp_code}" if erp_code else "Planner route",
                is_default=is_default,
                flow_source_kind="MIXED",
            )
            new_bom_id = int(flow_row["bom_id"])
            stage_kinds = _save_flow_steps(con, new_bom_id, steps)
            persisted_source_kind = _combined_flow_source_kind(stage_kinds, "MIXED")
            con.execute(
                """
                UPDATE planner_bom_variation
                SET source_kind = %s, updated_at = NOW()
                WHERE bom_id = %s
                """,
                (persisted_source_kind, new_bom_id),
            )
            refreshed = one(
                con.execute(
                    "SELECT bom_id, bom_code AS flow_code, bom_desc AS flow_name, is_default, source_kind FROM planner_bom_variation WHERE bom_id = %s",
                    (new_bom_id,),
                )
            )
            try:
                from app import _invalidate_pp_vouchers_with_ops_cache

                _invalidate_pp_vouchers_with_ops_cache()
            except Exception:
                pass
            return jsonify(
                {
                    "ok": True,
                    "forked": True,
                    "bom_id": new_bom_id,
                    "flow_code": new_code,
                    "flow": _flow_payload(con, refreshed),
                }
            )

        if is_default:
            con.execute(
                "UPDATE planner_bom_variation SET is_default = FALSE WHERE inventory_code = %s AND bom_id <> %s",
                (inventory_code, int(bom_id)),
            )
        con.execute(
            """
            UPDATE planner_bom_variation
            SET bom_code = %s, is_default = %s, updated_at = NOW()
            WHERE bom_id = %s
            """,
            (flow_code, is_default, int(bom_id)),
        )
        stage_kinds = _save_flow_steps(con, int(bom_id), steps)
        persisted_source_kind = _combined_flow_source_kind(
            stage_kinds,
            _source_kind(flow.get("source_kind"), "ERP"),
        )
        con.execute(
            """
            UPDATE planner_bom_variation
            SET source_kind = %s, updated_at = NOW()
            WHERE bom_id = %s
            """,
            (persisted_source_kind, int(bom_id)),
        )
        refreshed = one(
            con.execute(
                """
                SELECT bom_id, bom_code AS flow_code, bom_desc AS flow_name, is_default, source_kind
                FROM planner_bom_variation
                WHERE bom_id = %s
                """,
                (int(bom_id),),
            )
        )
        try:
            from app import _invalidate_pp_vouchers_with_ops_cache

            _invalidate_pp_vouchers_with_ops_cache()
        except Exception:
            pass
        return jsonify(
            {
                "ok": True,
                "bom_id": int(bom_id),
                "flow": _flow_payload(con, refreshed),
            }
        )
