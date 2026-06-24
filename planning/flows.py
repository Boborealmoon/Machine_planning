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


def clear_ps_queue_for_bom_route_change(con, planner_ps_id, old_bom_id, new_bom_id):
    """Remove machine-queue blocks for a PS when its planner BOM route changes."""
    planner_ps_id = compact_text(planner_ps_id)
    old_bom_id = int(old_bom_id or 0)
    new_bom_id = int(new_bom_id or 0)
    if not planner_ps_id or old_bom_id <= 0 or old_bom_id == new_bom_id:
        return {
            "cleared_blocks": 0,
            "cleared_operations": 0,
            "machine_ids": [],
            "old_bom_id": old_bom_id,
            "new_bom_id": new_bom_id,
        }

    from .auto_unschedule import _release_planning_cards
    from .blocks import recalculate_machine

    ps_row = one(
        con.execute(
            """
            SELECT planner_ps_id, source_ps_id, pp_partial_no
            FROM planner_process_sheet
            WHERE planner_ps_id = %s
            """,
            (planner_ps_id,),
        )
    )
    if not ps_row:
        return {
            "cleared_blocks": 0,
            "cleared_operations": 0,
            "machine_ids": [],
            "old_bom_id": old_bom_id,
            "new_bom_id": new_bom_id,
        }

    ps_id_variants = sorted(
        {
            variant
            for variant in _ps_id_variants_for_relink(
                ps_row.get("planner_ps_id"),
                ps_row.get("source_ps_id"),
                ps_row.get("pp_partial_no"),
            )
        }
    )
    if not ps_id_variants:
        return {
            "cleared_blocks": 0,
            "cleared_operations": 0,
            "machine_ids": [],
            "old_bom_id": old_bom_id,
            "new_bom_id": new_bom_id,
        }

    block_rows = rows(
        con.execute(
            """
            SELECT b.block_id, b.operation_id, b.machine_id, b.group_id
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND (
                COALESCE(o.source_ps_id, '') = ANY(%s)
                OR COALESCE(o.job_no, '') = ANY(%s)
              )
            ORDER BY b.group_id NULLS LAST, b.block_id
            """,
            (ps_id_variants, ps_id_variants),
        )
    )

    affected_machine_ids = set()
    affected_operation_ids = set()
    cleared_blocks = 0
    handled_groups = set()

    for row in block_rows:
        group_id = int(row.get("group_id") or 0)
        block_id = int(row.get("block_id") or 0)
        operation_id = int(row.get("operation_id") or 0)
        machine_id = int(row.get("machine_id") or 0)
        if machine_id:
            affected_machine_ids.add(machine_id)
        if operation_id:
            affected_operation_ids.add(operation_id)

        if group_id > 0:
            if group_id in handled_groups:
                continue
            handled_groups.add(group_id)
            group_blocks = rows(
                con.execute(
                    """
                    SELECT block_id, operation_id, machine_id
                    FROM planner_run_block
                    WHERE group_id = %s
                    """,
                    (group_id,),
                )
            )
            for gb in group_blocks:
                affected_machine_ids.add(int(gb.get("machine_id") or 0))
                affected_operation_ids.add(int(gb.get("operation_id") or 0))
                cleared_blocks += 1
            ps_id = compact_text(ps_row.get("planner_ps_id"))
            _release_planning_cards(con, ps_id=ps_id, group_id=group_id)
            con.execute("DELETE FROM planner_planning_card WHERE scheduled_block_group_id = %s", (group_id,))
            con.execute("DELETE FROM planner_run_block WHERE group_id = %s", (group_id,))
            con.execute("DELETE FROM planner_run_block_group WHERE group_id = %s", (group_id,))
            continue

        if block_id <= 0:
            continue
        cleared_blocks += 1
        con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (block_id,))

    cleared_operations = 0
    for op_id in sorted(affected_operation_ids):
        remaining = one(
            con.execute(
                "SELECT COUNT(*) AS cnt FROM planner_run_block WHERE operation_id = %s",
                (int(op_id),),
            )
        )
        if int((remaining or {}).get("cnt") or 0) <= 0:
            con.execute("DELETE FROM planner_operation WHERE operation_id = %s", (int(op_id),))
            cleared_operations += 1

    old_seq_rows = rows(
        con.execute(
            "SELECT op_seq_id FROM planner_operation_seq WHERE bom_id = %s",
            (old_bom_id,),
        )
    )
    old_seq_ids = [int(row["op_seq_id"]) for row in old_seq_rows if int(row.get("op_seq_id") or 0) > 0]
    if old_seq_ids:
        orphan_ops = rows(
            con.execute(
                """
                SELECT o.operation_id
                FROM planner_operation o
                LEFT JOIN planner_run_block b ON b.operation_id = o.operation_id
                WHERE (
                    COALESCE(o.source_ps_id, '') = ANY(%s)
                    OR COALESCE(o.job_no, '') = ANY(%s)
                )
                  AND COALESCE(o.source_op_seq_id, 0) = ANY(%s)
                  AND b.block_id IS NULL
                """,
                (ps_id_variants, ps_id_variants, old_seq_ids),
            )
        )
        for row in orphan_ops:
            op_id = int(row.get("operation_id") or 0)
            if op_id <= 0:
                continue
            con.execute("DELETE FROM planner_operation WHERE operation_id = %s", (op_id,))
            cleared_operations += 1

    for ps_variant in ps_id_variants:
        _release_planning_cards(con, ps_id=ps_variant, group_id=0)

    for machine_id in sorted(mid for mid in affected_machine_ids if mid):
        recalculate_machine(con, machine_id)

    try:
        from .scheduler_state import refresh_process_sheet_state

        refresh_process_sheet_state(con, planner_ps_id)
    except Exception:
        pass

    return {
        "cleared_blocks": cleared_blocks,
        "cleared_operations": cleared_operations,
        "machine_ids": sorted(mid for mid in affected_machine_ids if mid),
        "old_bom_id": old_bom_id,
        "new_bom_id": new_bom_id,
    }


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
    try:
        from .preferred_machines_route import invalidate_preferred_machines_cache

        invalidate_preferred_machines_cache()
    except Exception:
        pass
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


def _bom_code_key(code):
    return compact_text(code).upper()


def _op_type_from_stage_desc(stage_desc):
    stage_desc = compact_text(stage_desc)
    if stage_desc.upper().startswith("TURNING"):
        return "Turning"
    if stage_desc.upper().startswith("MILLING"):
        return "Milling"
    if stage_desc.upper().startswith("TURNMILL"):
        return "Turnmill"
    return stage_desc.split()[0] if stage_desc else "OP"


def _machine_category_from_op_type(op_type):
    op_type = compact_text(op_type)
    upper = op_type.upper()
    if upper in {"TURNING", "MILLING", "TURNMILL"}:
        return upper
    if op_type in {"Turning", "Milling", "Turnmill"}:
        return op_type.upper()
    return upper or "GENERAL"


def erp_bom_codes_by_inventory(con, inventory_codes):
    """Distinct ERP BOM routes per inventory_code (material_per_bom + bom_op_stage)."""
    codes = [compact_text(code) for code in (inventory_codes or []) if compact_text(code)]
    if not codes:
        return {}
    out = {code: [] for code in codes}
    seen = {code: set() for code in codes}

    def _append(inv, bom_code):
        code = compact_text(bom_code)
        key = _bom_code_key(code)
        if inv not in out or not code or key in seen[inv]:
            return
        seen[inv].add(key)
        out[inv].append(code)

    for row in rows(
        con.execute(
            """
            SELECT DISTINCT source_inventory_code, bom_code
            FROM material_per_bom
            WHERE source_inventory_code = ANY(%s)
              AND COALESCE(bom_code, '') <> ''
            ORDER BY source_inventory_code, bom_code
            """,
            (codes,),
        )
    ):
        _append(compact_text(row.get("source_inventory_code")), row.get("bom_code"))
    for row in rows(
        con.execute(
            """
            SELECT DISTINCT inventory_code, bom_code
            FROM bom_op_stage
            WHERE inventory_code = ANY(%s)
              AND COALESCE(bom_code, '') <> ''
            ORDER BY inventory_code, bom_code
            """,
            (codes,),
        )
    ):
        _append(compact_text(row.get("inventory_code")), row.get("bom_code"))
    for inv in out:
        out[inv].sort()
    return out


def _resolve_inventory_bom_code(con, inventory_code, bom_code):
    """Resolve canonical bom_code from bom_op_stage or material_per_bom."""
    inventory_code = compact_text(inventory_code)
    bom_code = compact_text(bom_code)
    if not inventory_code or not bom_code:
        return ""
    resolved = _resolve_bom_op_stage_code(con, inventory_code, bom_code)
    if resolved:
        return resolved
    row = one(
        con.execute(
            """
            SELECT bom_code
            FROM material_per_bom
            WHERE source_inventory_code = %s AND bom_code = %s
            LIMIT 1
            """,
            (inventory_code, bom_code),
        )
    )
    if row:
        return compact_text(row.get("bom_code"))
    row = one(
        con.execute(
            """
            SELECT bom_code
            FROM material_per_bom
            WHERE source_inventory_code = %s AND UPPER(bom_code) = UPPER(%s)
            LIMIT 1
            """,
            (inventory_code, bom_code),
        )
    )
    return compact_text(row.get("bom_code")) if row else bom_code


def _resolve_bom_op_stage_code(con, inventory_code, bom_code):
    inventory_code = compact_text(inventory_code)
    bom_code = compact_text(bom_code)
    if not inventory_code or not bom_code:
        return ""
    row = one(
        con.execute(
            """
            SELECT bom_code
            FROM bom_op_stage
            WHERE inventory_code = %s AND bom_code = %s
            LIMIT 1
            """,
            (inventory_code, bom_code),
        )
    )
    if row:
        return compact_text(row.get("bom_code"))
    row = one(
        con.execute(
            """
            SELECT bom_code
            FROM bom_op_stage
            WHERE inventory_code = %s AND UPPER(bom_code) = UPPER(%s)
            LIMIT 1
            """,
            (inventory_code, bom_code),
        )
    )
    return compact_text(row.get("bom_code")) if row else ""


def _bom_op_stage_steps(con, inventory_code, bom_code):
    inventory_code = compact_text(inventory_code)
    bom_code = _resolve_bom_op_stage_code(con, inventory_code, bom_code)
    if not inventory_code or not bom_code:
        return []
    stage_rows = rows(
        con.execute(
            """
            SELECT stage_no, stage_desc, op_no, op_index, machine_no, setup_time, cycle_time
            FROM bom_op_stage
            WHERE inventory_code = %s AND bom_code = %s
            ORDER BY op_no NULLS LAST, op_index, stage_no
            """,
            (inventory_code, bom_code),
        )
    )
    steps = []
    for idx, row in enumerate(stage_rows):
        stage_desc = compact_text(row.get("stage_desc"))
        stage_no = int(row.get("stage_no") or 0)
        op_no = compact_text(row.get("op_no")) or (str(stage_no) if stage_no else str(idx + 1))
        op_type = _op_type_from_stage_desc(stage_desc)
        steps.append(
            {
                "seq_no": idx + 1,
                "op_no": op_no,
                "op_type": op_type,
                "machine_category": _machine_category_from_op_type(op_type),
                "preferred_machine": compact_text(row.get("machine_no")),
                "cycle_time": max(0.0, parse_number(row.get("cycle_time"), 0)),
                "setup_time": max(0.0, parse_number(row.get("setup_time"), 0)),
                "is_last_op": idx == len(stage_rows) - 1,
                "source_kind": "ERP",
                "source_stage_no": stage_no or None,
            }
        )
    return steps


def _is_machining_stage_desc(stage_desc):
    upper = compact_text(stage_desc).upper()
    return upper.startswith(("TURNING ", "MILLING ", "TURNMILL ")) or upper in {
        "TURNING",
        "MILLING",
        "TURNMILL",
    }


def _planner_step_from_erp_stage_row(row, idx, total):
    from planning.erp_wo_merge import is_finishing_stage_desc

    stage_desc = compact_text(row.get("stage_desc"))
    stage_no = int(row.get("stage_no") or 0)
    op_no = compact_text(row.get("op_no")) or (str(stage_no) if stage_no else str(idx + 1))
    if _is_machining_stage_desc(stage_desc):
        op_type = _op_type_from_stage_desc(stage_desc)
        machine_category = _machine_category_from_op_type(op_type)
    else:
        op_type = stage_desc or "OP"
        machine_category = (
            "FINISHING"
            if is_finishing_stage_desc(stage_desc)
            else "GENERAL"
        )
    return {
        "seq_no": idx + 1,
        "op_no": op_no,
        "op_type": op_type,
        "machine_category": machine_category,
        "preferred_machine": compact_text(row.get("machine_no")),
        "cycle_time": max(0.0, parse_number(row.get("cycle_time"), 0)),
        "setup_time": max(0.0, parse_number(row.get("setup_time"), 0)),
        "is_last_op": idx >= total - 1,
        "source_kind": "ERP",
        "source_stage_no": stage_no or None,
    }


def _erp_domain_inventory_bom_steps(inventory_code, bom_code):
    """Full ERP BOM stages from COMAIN when bom_op_stage has no machining rows."""
    inventory_code = compact_text(inventory_code)
    bom_code = compact_text(bom_code)
    if not inventory_code or not bom_code:
        return []
    try:
        from db import domain_sync_unreachable, get_conn, release_conn

        if domain_sync_unreachable():
            return []
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT stage_no, stage_desc,
                           CASE
                               WHEN stage_desc ~ ' [0-9]+$'
                               THEN substring(stage_desc FROM ' ([0-9]+)$')::INTEGER
                               ELSE NULL
                           END AS op_no,
                           NULL::TEXT AS machine_no,
                           0::NUMERIC AS setup_time,
                           0::NUMERIC AS cycle_time
                    FROM public.mt_inventory_bom_stage
                    WHERE inventory_code = %s
                      AND UPPER(bom_code) = UPPER(%s)
                    ORDER BY stage_no
                    """,
                    (inventory_code, bom_code),
                )
                cols = [desc[0] for desc in cur.description]
                stage_rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            release_conn(conn)
    except Exception:
        return []
    if not stage_rows:
        return []
    total = len(stage_rows)
    return [_planner_step_from_erp_stage_row(row, idx, total) for idx, row in enumerate(stage_rows)]


def _inventory_bom_route_steps(con, inventory_code, bom_code):
    """Planner flow steps from bom_op_stage, else full ERP mt_inventory_bom_stage."""
    steps = _bom_op_stage_steps(con, inventory_code, bom_code)
    if steps:
        return steps
    resolved = _resolve_inventory_bom_code(con, inventory_code, bom_code)
    return _erp_domain_inventory_bom_steps(inventory_code, resolved or bom_code)


def merge_flow_options(planner_flows, erp_bom_codes, erp_voucher_bom=None):
    """Planner BOM variations plus ERP inventory BOM routes not yet seeded."""
    options = [dict(flow) for flow in (planner_flows or [])]
    seen = {_bom_code_key(flow.get("bom_code")) for flow in options if _bom_code_key(flow.get("bom_code"))}
    voucher_key = _bom_code_key(erp_voucher_bom)
    for bom_code in erp_bom_codes or []:
        code = compact_text(bom_code)
        key = _bom_code_key(code)
        if not code or key in seen:
            continue
        seen.add(key)
        options.append(
            {
                "bom_id": 0,
                "bom_code": code,
                "bom_desc": "ERP route",
                "is_default": bool(voucher_key and key == voucher_key),
                "source_kind": "ERP",
            }
        )
    options.sort(
        key=lambda flow: (
            0 if flow.get("is_default") else 1,
            0 if int(flow.get("bom_id") or 0) > 0 else 1,
            compact_text(flow.get("bom_code")),
        )
    )
    return options


def planner_flow_options_for_inventory(con, inventory_code):
    inventory_code = compact_text(inventory_code)
    if not inventory_code:
        return []
    return [
        dict(flow)
        for flow in rows(
            con.execute(
                """
                SELECT bom_id, bom_code, bom_desc, is_default, source_kind
                FROM planner_bom_variation
                WHERE inventory_code = %s
                ORDER BY is_default DESC, bom_id
                """,
                (inventory_code,),
            )
        )
    ]


def flow_options_for_inventory(con, inventory_code, erp_bom_codes=None, erp_voucher_bom=None):
    planner_flows = planner_flow_options_for_inventory(con, inventory_code)
    if erp_bom_codes is None:
        erp_bom_codes = erp_bom_codes_by_inventory(con, [inventory_code]).get(inventory_code, [])
    return merge_flow_options(planner_flows, erp_bom_codes, erp_voucher_bom=erp_voucher_bom)


def ensure_planner_bom_from_bom_op_stage(con, inventory_code, bom_code, *, is_default=False):
    """Create planner_bom_variation + steps from ERP BOM routes when missing."""
    inventory_code = compact_text(inventory_code)
    requested_code = compact_text(bom_code)
    if not inventory_code or not requested_code:
        return 0

    existing = one(
        con.execute(
            """
            SELECT bom_id
            FROM planner_bom_variation
            WHERE inventory_code = %s
              AND UPPER(bom_code) = UPPER(%s)
            LIMIT 1
            """,
            (inventory_code, requested_code),
        )
    )
    if existing:
        return int(existing["bom_id"])

    resolved_code = _resolve_inventory_bom_code(con, inventory_code, requested_code)
    if not resolved_code:
        return 0

    steps = _inventory_bom_route_steps(con, inventory_code, resolved_code)
    if not steps:
        return 0

    _ensure_flow_source_columns(con)
    flow_row = _insert_planner_bom_variation(
        con,
        inventory_code=inventory_code,
        bom_code=resolved_code,
        bom_desc=f"ERP route {resolved_code}",
        is_default=is_default,
        flow_source_kind="ERP",
    )
    bom_id = int(flow_row["bom_id"])
    stage_kinds = _save_flow_steps(con, bom_id, steps)
    persisted_source_kind = _combined_flow_source_kind(stage_kinds, "ERP")
    con.execute(
        """
        UPDATE planner_bom_variation
        SET source_kind = %s, updated_at = NOW()
        WHERE bom_id = %s
        """,
        (persisted_source_kind, bom_id),
    )
    return bom_id

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
                    WHERE inventory_code = %s AND UPPER(bom_code) = UPPER(%s)
                    """,
                    (inventory_code, flow_code),
                )
            )
            if not flow:
                seeded_bom_id = ensure_planner_bom_from_bom_op_stage(
                    con,
                    inventory_code,
                    flow_code,
                    is_default=False,
                )
                if seeded_bom_id > 0:
                    flow = one(
                        con.execute(
                            """
                            SELECT bom_id, bom_code
                            FROM planner_bom_variation
                            WHERE bom_id = %s
                            """,
                            (seeded_bom_id,),
                        )
                    )
        if not flow:
            return jsonify({"error": "Flow not found for this PS"}), 404
        old_bom_id = int(ps.get("selected_bom_id") or 0)
        new_bom_id = int(flow["bom_id"])
        queue_clear = clear_ps_queue_for_bom_route_change(con, ps_id, old_bom_id, new_bom_id)
        con.execute(
            """
            UPDATE planner_process_sheet
            SET selected_bom_id = %s, updated_at = NOW()
            WHERE planner_ps_id = %s
            """,
            (new_bom_id, ps_id),
        )
        from planning.process_sheets import is_temp_planner_ps_id

        if is_temp_planner_ps_id(ps_id):
            con.execute(
                """
                UPDATE planner_temp_process_sheet
                SET selected_bom_id = %s,
                    selected_bom_code = %s,
                    updated_at = NOW()
                WHERE planner_ps_id = %s
                """,
                (new_bom_id, compact_text(flow.get("bom_code")), ps_id),
            )
        if old_bom_id == new_bom_id:
            _relink_planner_op_seq_ids_for_bom(con, new_bom_id, planner_ps_ids=[ps_id])
        sync_material_requirements_for_ps(con, ps_id)
        try:
            from app import _invalidate_pp_vouchers_with_ops_cache

            _invalidate_pp_vouchers_with_ops_cache()
        except Exception:
            pass
        from planning.catalog import build_catalog_flow_patch

        patch = build_catalog_flow_patch(con, ps_id, new_bom_id, compact_text(flow.get("bom_code")))
        cleared_blocks = int(queue_clear.get("cleared_blocks") or 0)
        toast_hint = ""
        if cleared_blocks > 0:
            toast_hint = f" Cleared {cleared_blocks} queued block(s) from the previous BOM."
        return jsonify(
            {
                "ok": True,
                "ps_id": ps_id,
                "selected_bom_id": new_bom_id,
                "selected_bom_code": compact_text(flow.get("bom_code")),
                "selected_flow_code": flow["bom_code"] or "",
                "queue_cleared": queue_clear,
                "machine_ids": queue_clear.get("machine_ids") or [],
                "toast_hint": toast_hint.strip(),
                **patch,
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
        merged_options = flow_options_for_inventory(con, inventory_code)
        payloads = []
        for option in merged_options:
            bom_id = int(option.get("bom_id") or 0)
            if bom_id > 0:
                flow = one(
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
                if flow:
                    payloads.append(_flow_payload(con, flow))
                continue
            bom_code = compact_text(option.get("bom_code"))
            steps = _inventory_bom_route_steps(con, inventory_code, bom_code)
            if not steps:
                continue
            payloads.append(
                {
                    "bom_id": 0,
                    "flow_code": bom_code,
                    "flow_name": compact_text(option.get("bom_desc")) or f"ERP route {bom_code}",
                    "is_default": bool(option.get("is_default")),
                    "source_kind": "ERP",
                    "steps": [{**dict(step), "is_last_op": int(bool(step.get("is_last_op")))} for step in steps],
                }
            )
        return jsonify(payloads)


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
