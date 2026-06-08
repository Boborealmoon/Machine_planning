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

import re
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


def _ensure_bom_step_qty_table(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ps_bom_step_qty (
            planner_ps_id   TEXT         NOT NULL REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
            op_seq_id       BIGINT       NOT NULL,
            qty_produced    NUMERIC      NOT NULL DEFAULT 0,
            qty_rejected    NUMERIC      NOT NULL DEFAULT 0,
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (planner_ps_id, op_seq_id)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_ps_bom_step_qty_ps
            ON public.planner_ps_bom_step_qty(planner_ps_id)
        """
    )


def manual_qty_by_ps_ids(con, ps_ids):
    return _manual_qty_by_ps_ids(con, ps_ids)


def _manual_qty_by_ps_ids(con, ps_ids):
    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}
    _ensure_bom_step_qty_table(con)
    result = {ps_id: {} for ps_id in ps_ids}
    for row in rows(
        con.execute(
            """
            SELECT planner_ps_id, op_seq_id, qty_produced, qty_rejected
            FROM planner_ps_bom_step_qty
            WHERE planner_ps_id = ANY(%s)
            """,
            (ps_ids,),
        )
    ):
        ps_id = compact_text(row.get("planner_ps_id"))
        op_seq_id = int(row.get("op_seq_id") or 0)
        if not ps_id or op_seq_id <= 0:
            continue
        result.setdefault(ps_id, {})[op_seq_id] = {
            "qty_produced": _to_float(row.get("qty_produced")),
            "qty_rejected": _to_float(row.get("qty_rejected")),
        }
    return result


def step_needs_manual_produced(step):
    """True when ERP will not supply reliable produced qty for this BOM step."""
    kind = compact_text(step.get("source_kind")).upper()
    stage_no = int(step.get("source_stage_no") or 0)
    if kind == "MANUAL":
        return True
    if stage_no > 0:
        return False
    erp_prod = _to_float(step.get("erp_finished_qty"))
    erp_req = _to_float(step.get("erp_required_qty"))
    return erp_req <= 0 and erp_prod <= 0


def apply_flow_step_qty_cascade(steps, launch_qty, manual_by_op_seq=None):
    """Push effective output from each step as required qty for the next."""
    manual_by_op_seq = manual_by_op_seq or {}
    if not steps:
        return []
    ordered = sorted(
        steps,
        key=lambda s: (int(s.get("seq_no") or 0), int(s.get("op_seq_id") or 0)),
    )
    launch_qty = max(0.0, _to_float(launch_qty))
    carry_in = launch_qty
    enriched = []
    for step in ordered:
        row = dict(step)
        op_seq_id = int(row.get("op_seq_id") or 0)
        manual = manual_by_op_seq.get(op_seq_id, {})
        manual_prod = _to_float(manual.get("qty_produced"))
        manual_rej = _to_float(manual.get("qty_rejected"))
        erp_prod = _to_float(row.get("erp_finished_qty"))
        erp_rej = _to_float(row.get("erp_reject_qty"))
        required = carry_in if carry_in > 0 else launch_qty
        row["cascade_required_qty"] = required
        row["manual_produced_qty"] = manual_prod
        row["manual_reject_qty"] = manual_rej
        row["needs_manual_produced"] = step_needs_manual_produced(row)
        effective_out = max(erp_prod, manual_prod)
        if required > 0:
            effective_out = min(required, effective_out)
        row["cascade_output_qty"] = effective_out
        row["cascade_reject_qty"] = max(erp_rej, manual_rej)
        carry_in = effective_out
        enriched.append(row)
    return enriched


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
        base = raw
        partial_no = 1
    else:
        base, partial_text = raw.split("::", 1)
        try:
            partial_no = int(partial_text)
        except (TypeError, ValueError):
            partial_no = 1
        base = base or raw
    if is_temp_planner_ps_id(base) or partial_no >= TEMP_PARTIAL_MIN:
        return base, 1
    return base, max(1, partial_no)


def format_planner_ps_id(source_ps_id, pp_partial_no=1):
    """Canonical planner_ps_id / catalog ps_id (suffix only when partial > 1)."""
    source_ps_id = compact_text(source_ps_id)
    try:
        partial_no = max(1, int(pp_partial_no or 1))
    except (TypeError, ValueError):
        partial_no = 1
    if not source_ps_id:
        return ""
    if is_temp_planner_ps_id(source_ps_id) or partial_no >= TEMP_PARTIAL_MIN:
        return source_ps_id
    if partial_no > 1:
        return f"{source_ps_id}::{partial_no}"
    return source_ps_id


TEMP_PS_PREFIX = "[Temp]"
TEMP_PARTIAL_MIN = 900001
_TEMP_TABLE_READY = False


def _ensure_planner_temp_process_sheet_table(con):
    """Persistent registry for [Temp] reject/rework PS (PostgreSQL / SUPA_DB_URL)."""
    global _TEMP_TABLE_READY
    if _TEMP_TABLE_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_temp_process_sheet (
            planner_ps_id           TEXT         PRIMARY KEY
                REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
            source_ps_id            TEXT         NOT NULL,
            source_pp_partial_no    INTEGER      NOT NULL DEFAULT 1,
            reject_qty              NUMERIC      NOT NULL DEFAULT 0,
            inventory_code          TEXT         NOT NULL DEFAULT '',
            part_no                 TEXT         NOT NULL DEFAULT '',
            part_desc               TEXT         NOT NULL DEFAULT '',
            due_date                DATE,
            erp_bom_code            TEXT         NOT NULL DEFAULT '',
            selected_bom_id         BIGINT
                REFERENCES public.planner_bom_variation(bom_id) ON DELETE SET NULL,
            selected_bom_code       TEXT         NOT NULL DEFAULT '',
            remarks                 TEXT         NOT NULL DEFAULT '',
            created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_temp_process_sheet_source
            ON public.planner_temp_process_sheet (source_ps_id)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_temp_process_sheet_created
            ON public.planner_temp_process_sheet (created_at DESC)
        """
    )
    # Backfill registry rows for legacy [Temp] planner rows created before this table existed.
    con.execute(
        """
        INSERT INTO planner_temp_process_sheet (
          planner_ps_id, source_ps_id, source_pp_partial_no, reject_qty,
          inventory_code, part_no, part_desc, due_date, erp_bom_code,
          selected_bom_id, selected_bom_code, remarks, created_at, updated_at
        )
        SELECT ps.planner_ps_id,
               ps.source_ps_id,
               1,
               COALESCE(ps.planned_qty, 0),
               COALESCE(ps.inventory_code, ''),
               COALESCE(ps.inventory_code, ''),
               '',
               NULL::DATE,
               '',
               ps.selected_bom_id,
               COALESCE(sf.bom_code, ''),
               COALESCE(ps.remarks, ''),
               ps.created_at,
               ps.updated_at
        FROM planner_process_sheet ps
        LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
        WHERE ps.planner_ps_id LIKE %s
          AND NOT EXISTS (
            SELECT 1 FROM planner_temp_process_sheet t
            WHERE t.planner_ps_id = ps.planner_ps_id
          )
        """,
        (f"{TEMP_PS_PREFIX}%",),
    )
    _TEMP_TABLE_READY = True


def _persist_temp_process_sheet_record(con, *, planner_ps_id, preview, source_pp_partial_no, qty, remarks):
    _ensure_planner_temp_process_sheet_table(con)
    due_raw = compact_text(preview.get("due_date"))
    due_val = None
    if due_raw:
        try:
            due_val = date.fromisoformat(due_raw[:10])
        except ValueError:
            due_val = None
    con.execute(
        """
        INSERT INTO planner_temp_process_sheet (
          planner_ps_id, source_ps_id, source_pp_partial_no, reject_qty,
          inventory_code, part_no, part_desc, due_date, erp_bom_code,
          selected_bom_id, selected_bom_code, remarks, created_at, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
        ON CONFLICT (planner_ps_id) DO UPDATE SET
          reject_qty = EXCLUDED.reject_qty,
          remarks = EXCLUDED.remarks,
          updated_at = NOW()
        """,
        (
            planner_ps_id,
            compact_text(preview.get("source_ps_id")),
            max(1, int(source_pp_partial_no or 1)),
            max(0.0, _to_float(qty)),
            compact_text(preview.get("part_no")),
            compact_text(preview.get("part_no")),
            compact_text(preview.get("part_desc")),
            due_val,
            compact_text(preview.get("erp_bom_code")),
            int(preview.get("selected_bom_id") or 0) or None,
            compact_text(preview.get("selected_bom_code")),
            compact_text(remarks),
        ),
    )


def list_temp_process_sheets(con, limit=500):
    _ensure_planner_temp_process_sheet_table(con)
    limit = max(1, min(int(limit or 500), 2000))
    for row in rows(
        con.execute(
            """
            SELECT ps.planner_ps_id
            FROM planner_process_sheet ps
            WHERE ps.planner_ps_id LIKE %s
              AND COALESCE(ps.selected_bom_id, 0) = 0
            """,
            (f"{TEMP_PS_PREFIX}%",),
        )
    ):
        try:
            _repair_temp_ps_bom_if_missing(con, row.get("planner_ps_id"))
        except Exception:
            pass
    return rows(
        con.execute(
            """
            SELECT t.*,
                   ps.planner_status,
                   ps.status AS ps_status,
                   ps.planned_qty,
                   ps.finished_qty
            FROM planner_temp_process_sheet t
            JOIN planner_process_sheet ps ON ps.planner_ps_id = t.planner_ps_id
            ORDER BY t.created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
    )


def list_temp_process_sheets_payload(con, limit=500):
    """Trackable temp PS rows for the Process Sheets · Temp tab."""
    rows_raw = list_temp_process_sheets(con, limit=limit)
    ps_ids = [compact_text(r.get("planner_ps_id")) for r in rows_raw if compact_text(r.get("planner_ps_id"))]
    metrics_by_ps, _ = _block_metrics_for_ps_ids(con, ps_ids)
    out = []
    for row in rows_raw:
        pid = compact_text(row.get("planner_ps_id"))
        metrics = metrics_by_ps.get(pid, {})
        planned_lane = _to_float(metrics.get("planned_qty_total"))
        queued_machines = list(metrics.get("queued_machines") or [])
        out.append(
            {
                "planner_ps_id": pid,
                "display_ps_id": temp_planner_ps_display_label(pid),
                "source_ps_id": compact_text(row.get("source_ps_id")),
                "source_pp_partial_no": int(row.get("source_pp_partial_no") or 1),
                "source_label": format_planner_ps_id(
                    row.get("source_ps_id"),
                    row.get("source_pp_partial_no"),
                ),
                "reject_qty": _to_float(row.get("reject_qty")),
                "planned_qty": _to_float(row.get("planned_qty")),
                "finished_qty": _to_float(row.get("finished_qty")),
                "part_no": compact_text(row.get("part_no")),
                "part_desc": compact_text(row.get("part_desc")),
                "due_date": compact_text(row.get("due_date")),
                "erp_bom_code": compact_text(row.get("erp_bom_code")),
                "selected_bom_code": compact_text(row.get("selected_bom_code")),
                "remarks": compact_text(row.get("remarks")),
                "planner_status": compact_text(row.get("planner_status")),
                "ps_status": compact_text(row.get("ps_status")),
                "created_at": compact_text(row.get("created_at")),
                "updated_at": compact_text(row.get("updated_at")),
                "is_queued": planned_lane > 0 or bool(queued_machines),
                "queued_machines": queued_machines,
                "stored_in": "planner_temp_process_sheet",
            }
        )
    return out


def is_temp_planner_ps_id(planner_ps_id):
    return compact_text(planner_ps_id).startswith(TEMP_PS_PREFIX)


def temp_planner_ps_display_label(planner_ps_id):
    """Human-facing label, e.g. [Temp] NPS26-0210."""
    raw = compact_text(planner_ps_id)
    if not is_temp_planner_ps_id(raw):
        return raw
    body = raw[len(TEMP_PS_PREFIX) :]
    return f"{TEMP_PS_PREFIX} {body}" if body else raw


def normalize_temp_ps_reference(reference_ps_id):
    """Strip [Temp] prefix; return canonical source PS no. for temp identity."""
    ref = compact_text(reference_ps_id)
    if not ref:
        return ""
    upper = ref.upper()
    if upper.startswith("[TEMP]"):
        ref = compact_text(ref[6:])
    return ref


def _temp_source_partial_no(con, planner_ps_id, fallback_partial=1):
    """ERP partial to use for a [Temp] row (not its 900001+ planner partial)."""
    planner_ps_id = compact_text(planner_ps_id)
    if not is_temp_planner_ps_id(planner_ps_id):
        try:
            return max(1, int(fallback_partial or 1))
        except (TypeError, ValueError):
            return 1
    row = one(
        con.execute(
            "SELECT source_pp_partial_no FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if row:
        try:
            return max(1, int(row.get("source_pp_partial_no") or 1))
        except (TypeError, ValueError):
            return 1
    try:
        return max(1, int(fallback_partial or 1))
    except (TypeError, ValueError):
        return 1


def _unique_temp_bom_code(con, inventory_code, base_code):
    inventory_code = compact_text(inventory_code)
    base_code = compact_text(base_code) or "TEMP-REWORK"
    candidate = base_code
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
        candidate = f"{base_code}-{suffix}"
        suffix += 1
    return candidate


def _placeholder_flow_steps():
    return [
        {
            "seq_no": 1,
            "op_no": "OP1",
            "op_type": "PLACEHOLDER",
            "machine_category": "PLACEHOLDER",
            "preferred_machine": "",
            "cycle_time": 1,
            "setup_time": 0,
            "is_last_op": 1,
            "source_kind": "MANUAL",
            "source_stage_no": None,
        }
    ]


def _erp_steps_to_flow_steps(erp_steps):
    out = []
    for idx, step in enumerate(erp_steps or []):
        out.append(
            {
                "seq_no": int(step.get("seq_no") or idx + 1),
                "op_no": compact_text(step.get("op_no")) or str(idx + 1),
                "op_type": compact_text(step.get("op_type")) or "OP",
                "machine_category": compact_text(step.get("machine_category")) or "GENERAL",
                "preferred_machine": compact_text(step.get("preferred_machine")),
                "cycle_time": max(0.0, _to_float(step.get("cycle_time") or 1)),
                "setup_time": max(0.0, _to_float(step.get("setup_time"))),
                "is_last_op": int(bool(step.get("is_last_op"))) if idx < len(erp_steps) - 1 else 1,
                "source_kind": "ERP",
                "source_stage_no": int(step.get("source_stage_no") or 0) or None,
            }
        )
    if out:
        out[-1]["is_last_op"] = 1
    return out


def _ensure_temp_ps_bom(con, planner_ps_id, inventory_code, preview, *, placeholder=False):
    """Assign a planner BOM to a temp PS — clone source route or create PLACEHOLDER."""
    planner_ps_id = compact_text(planner_ps_id)
    inventory_code = compact_text(inventory_code)
    if not inventory_code:
        raise ValueError("Inventory code is required to assign a BOM flow.")

    existing_bom_id = int(preview.get("selected_bom_id") or 0)
    if existing_bom_id and not placeholder:
        flow = one(
            con.execute(
                "SELECT bom_id, bom_code FROM planner_bom_variation WHERE bom_id = %s",
                (existing_bom_id,),
            )
        )
        if flow:
            bom_code = compact_text(flow.get("bom_code"))
            con.execute(
                """
                UPDATE planner_process_sheet
                SET selected_bom_id = %s, updated_at = NOW()
                WHERE planner_ps_id = %s
                """,
                (existing_bom_id, planner_ps_id),
            )
            con.execute(
                """
                UPDATE planner_temp_process_sheet
                SET selected_bom_id = %s, selected_bom_code = %s, updated_at = NOW()
                WHERE planner_ps_id = %s
                """,
                (existing_bom_id, bom_code, planner_ps_id),
            )
            return existing_bom_id

    from planning.flows import (
        _combined_flow_source_kind,
        _ensure_flow_source_columns,
        _insert_planner_bom_variation,
        _save_flow_steps,
    )

    _ensure_flow_source_columns(con)
    if placeholder:
        bom_code = "PLACEHOLDER"
        bom_desc = "Temp placeholder route"
        flow_steps = _placeholder_flow_steps()
        flow_source_kind = "MANUAL"
    else:
        source_ps_id = compact_text(preview.get("source_ps_id"))
        source_partial = int(preview.get("pp_partial_no") or 1)
        erp_steps = _erp_cache_steps_for_ps(con, source_ps_id, source_partial)
        if erp_steps:
            bom_code = _unique_temp_bom_code(
                con,
                inventory_code,
                f"{source_ps_id}-TEMP-REWORK",
            )
            bom_desc = f"Temp rework route from {format_planner_ps_id(source_ps_id, source_partial)}"
            flow_steps = _erp_steps_to_flow_steps(erp_steps)
            flow_source_kind = "ERP"
        else:
            bom_code = "PLACEHOLDER"
            bom_desc = "Temp placeholder route"
            flow_steps = _placeholder_flow_steps()
            flow_source_kind = "MANUAL"

    flow_row = _insert_planner_bom_variation(
        con,
        inventory_code=inventory_code,
        bom_code=bom_code,
        bom_desc=bom_desc,
        is_default=False,
        flow_source_kind=flow_source_kind,
    )
    bom_id = int(flow_row["bom_id"])
    stage_kinds = _save_flow_steps(con, bom_id, flow_steps)
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
        (bom_id, planner_ps_id),
    )
    con.execute(
        """
        UPDATE planner_temp_process_sheet
        SET selected_bom_id = %s, selected_bom_code = %s, erp_bom_code = %s, updated_at = NOW()
        WHERE planner_ps_id = %s
        """,
        (bom_id, bom_code, bom_code, planner_ps_id),
    )
    return bom_id


def _allocate_temp_planner_identity(con, source_ps_id):
    """Next temp planner_ps_id and pp_partial_no for reject/rework copies."""
    source_ps_id = compact_text(source_ps_id)
    row = one(
        con.execute(
            """
            SELECT COALESCE(MAX(pp_partial_no), %s - 1) AS mx
            FROM planner_process_sheet
            WHERE source_ps_id = %s
              AND pp_partial_no >= %s
            """,
            (TEMP_PARTIAL_MIN, source_ps_id, TEMP_PARTIAL_MIN),
        )
    )
    next_partial = max(TEMP_PARTIAL_MIN, int((row or {}).get("mx") or TEMP_PARTIAL_MIN - 1) + 1)
    sequence = next_partial - TEMP_PARTIAL_MIN + 1
    if sequence <= 1:
        planner_ps_id = f"{TEMP_PS_PREFIX}{source_ps_id}"
    else:
        planner_ps_id = f"{TEMP_PS_PREFIX}{source_ps_id}-{sequence}"
    return planner_ps_id, next_partial


def _voucher_partial_row(con, source_ps_id, pp_partial_no):
    return one(
        con.execute(
            """
            SELECT ps_id, pp_partial_no,
                   MAX(part_no) AS part_no,
                   MAX(description) AS description,
                   MIN(due_date) AS due_date,
                   MAX(bom_code) AS bom_code,
                   MAX(total_qty) AS total_qty,
                   MAX(partial_qty) AS partial_qty,
                   MAX(status) AS erp_status
            FROM pp_vouchers_cache
            WHERE ps_id = %s AND pp_partial_no = %s
            GROUP BY ps_id, pp_partial_no
            """,
            (compact_text(source_ps_id), max(1, int(pp_partial_no or 1))),
        )
    )


def _mfg_process_sheet_staging_row(con, source_ps_id):
    """Fallback when pp_vouchers_cache has not been rebuilt yet for this PS."""
    source_ps_id = compact_text(source_ps_id)
    if not source_ps_id:
        return None
    return one(
        con.execute(
            """
            SELECT process_sheet_no AS ps_id,
                   1 AS pp_partial_no,
                   MAX(inventory_code) AS part_no,
                   '' AS description,
                   NULL::DATE AS due_date,
                   MAX(COALESCE(total_qty, 0)) AS display_qty,
                   '' AS bom_code,
                   'erp_staging' AS match_source
            FROM mfg_process_sheet_info
            WHERE process_sheet_no = %s
            GROUP BY process_sheet_no
            LIMIT 1
            """,
            (source_ps_id,),
        )
    )


def _voucher_rows_for_source_ps(con, source_ps_id, pp_partial_no=None):
    """All cache partials for a PS, or one partial when specified."""
    source_ps_id = compact_text(source_ps_id)
    if not source_ps_id:
        return []
    if pp_partial_no is not None:
        row = _voucher_partial_row(con, source_ps_id, pp_partial_no)
        return [row] if row else []
    return rows(
        con.execute(
            """
            SELECT ps_id, pp_partial_no,
                   MAX(part_no) AS part_no,
                   MAX(description) AS description,
                   MIN(due_date) AS due_date,
                   MAX(COALESCE(NULLIF(partial_qty, 0), total_qty, 0)) AS display_qty,
                   MAX(bom_code) AS bom_code
            FROM pp_vouchers_cache
            WHERE ps_id ILIKE %s
            GROUP BY ps_id, pp_partial_no
            ORDER BY pp_partial_no
            """,
            (source_ps_id,),
        )
    )


def search_process_sheet_sources(con, query, limit=25):
    needle = compact_text(query)
    if not needle:
        return []
    pattern = f"%{needle}%"
    limit = max(1, min(int(limit or 25), 50))
    cache_rows = rows(
        con.execute(
            """
            SELECT ps_id, pp_partial_no,
                   MAX(part_no) AS part_no,
                   MAX(description) AS description,
                   MIN(due_date) AS due_date,
                   MAX(COALESCE(NULLIF(partial_qty, 0), total_qty, 0)) AS display_qty,
                   MAX(bom_code) AS bom_code,
                   'pp_vouchers_cache' AS match_source
            FROM pp_vouchers_cache
            WHERE ps_id ILIKE %s
               OR part_no ILIKE %s
               OR description ILIKE %s
            GROUP BY ps_id, pp_partial_no
            ORDER BY MIN(due_date) NULLS LAST, ps_id, pp_partial_no
            LIMIT %s
            """,
            (pattern, pattern, pattern, limit),
        )
    )
    seen = {(compact_text(r.get("ps_id")), int(r.get("pp_partial_no") or 1)) for r in cache_rows}
    out = [dict(r) for r in cache_rows]
    if len(out) >= limit:
        return out

    staging_rows = rows(
        con.execute(
            """
            SELECT process_sheet_no AS ps_id,
                   1 AS pp_partial_no,
                   MAX(inventory_code) AS part_no,
                   '' AS description,
                   NULL::DATE AS due_date,
                   MAX(COALESCE(total_qty, 0)) AS display_qty,
                   '' AS bom_code,
                   'erp_staging' AS match_source
            FROM mfg_process_sheet_info
            WHERE process_sheet_no ILIKE %s
               OR inventory_code ILIKE %s
            GROUP BY process_sheet_no
            ORDER BY process_sheet_no
            LIMIT %s
            """,
            (pattern, pattern, max(limit - len(out), 0) or 1),
        )
    )
    for row in staging_rows:
        key = (compact_text(row.get("ps_id")), int(row.get("pp_partial_no") or 1))
        if key in seen:
            continue
        seen.add(key)
        out.append(dict(row))
        if len(out) >= limit:
            break
    return out


def temp_process_sheet_source_preview(con, source_ps_id, pp_partial_no=1):
    source_ps_id, pp_partial_no = parse_planner_ps_id(
        format_planner_ps_id(compact_text(source_ps_id), pp_partial_no)
    )
    cache_row = _voucher_partial_row(con, source_ps_id, pp_partial_no)
    if not cache_row:
        partial_rows = _voucher_rows_for_source_ps(con, source_ps_id)
        if partial_rows:
            cache_row = partial_rows[0]
            pp_partial_no = int(cache_row.get("pp_partial_no") or 1)
        else:
            cache_row = _mfg_process_sheet_staging_row(con, source_ps_id)
            if cache_row:
                pp_partial_no = 1
    if not cache_row:
        raise ValueError(
            f"Process sheet {source_ps_id} was not found. "
            "Run Sync ERP (PP vouchers + process sheets) and try again."
        )

    canonical = format_planner_ps_id(source_ps_id, pp_partial_no)
    planner_row = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (canonical,),
        )
    )
    if not planner_row:
        try:
            planner_row = ensure_planner_process_sheet(con, canonical)
        except ValueError:
            planner_row = None

    selected_bom_id = int((planner_row or {}).get("selected_bom_id") or 0)
    bom_code = ""
    bom_desc = ""
    if selected_bom_id:
        flow = one(
            con.execute(
                """
                SELECT bom_code, bom_desc FROM planner_bom_variation
                WHERE bom_id = %s
                """,
                (selected_bom_id,),
            )
        )
        if flow:
            bom_code = compact_text(flow.get("bom_code"))
            bom_desc = compact_text(flow.get("bom_desc"))

    if not bom_code:
        bom_code = compact_text(cache_row.get("bom_code"))
        if bom_code and compact_text(cache_row.get("part_no")):
            flow = one(
                con.execute(
                    """
                    SELECT bom_id, bom_code, bom_desc FROM planner_bom_variation
                    WHERE inventory_code = %s AND bom_code = %s
                    LIMIT 1
                    """,
                    (compact_text(cache_row.get("part_no")), bom_code),
                )
            )
            if flow:
                selected_bom_id = int(flow["bom_id"])
                bom_desc = compact_text(flow.get("bom_desc"))

    ops_preview = []
    if selected_bom_id:
        for row in rows(
            con.execute(
                """
                SELECT seq_no, op_no, op_type, machine_category, preferred_machine
                FROM planner_operation_seq
                WHERE bom_id = %s
                ORDER BY seq_no, op_seq_id
                """,
                (selected_bom_id,),
            )
        ):
            label = f"OP{compact_text(row.get('op_no')).lstrip('OPop')} {compact_text(row.get('op_type'))}".strip()
            ops_preview.append(
                {
                    "seq_no": int(row.get("seq_no") or 0),
                    "op_no": compact_text(row.get("op_no")),
                    "label": label,
                    "machine_category": compact_text(row.get("machine_category")),
                    "preferred_machine": compact_text(row.get("preferred_machine")),
                }
            )

    display_qty = _to_float(cache_row.get("partial_qty") or cache_row.get("total_qty"))
    return {
        "source_ps_id": source_ps_id,
        "pp_partial_no": pp_partial_no,
        "planner_ps_id": canonical,
        "part_no": compact_text(cache_row.get("part_no")),
        "part_desc": compact_text(cache_row.get("description")),
        "due_date": compact_text(cache_row.get("due_date")),
        "display_qty": display_qty,
        "erp_bom_code": compact_text(cache_row.get("bom_code")),
        "selected_bom_id": selected_bom_id,
        "selected_bom_code": bom_code,
        "selected_bom_desc": bom_desc,
        "ops_preview": ops_preview,
        "temp_name_preview": temp_planner_ps_display_label(f"{TEMP_PS_PREFIX}{source_ps_id}"),
    }


def create_temp_process_sheet(con, source_ps_id, pp_partial_no, qty, remarks=""):
    preview = temp_process_sheet_source_preview(con, source_ps_id, pp_partial_no)
    qty = max(0.0, _to_float(qty))
    if qty <= 0:
        raise ValueError("Quantity must be greater than zero.")

    source_ps_id = preview["source_ps_id"]
    pp_partial_no = int(preview["pp_partial_no"])
    planner_ps_id, temp_partial_no = _allocate_temp_planner_identity(con, source_ps_id)

    existing = one(
        con.execute(
            "SELECT planner_ps_id FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if existing:
        raise ValueError(f"Temp process sheet {planner_ps_id} already exists.")

    inventory_code = compact_text(preview.get("part_no"))
    selected_bom_id = int(preview.get("selected_bom_id") or 0) or None
    note = compact_text(remarks)
    if not note:
        note = f"Temp reject PS cloned from {format_planner_ps_id(source_ps_id, pp_partial_no)}"

    con.execute(
        """
        INSERT INTO planner_process_sheet (
          planner_ps_id, source_ps_id, pp_partial_no, inventory_code,
          selected_bom_id, planner_status, status, planned_qty, finished_qty,
          remarks, created_at, updated_at
        ) VALUES (%s, %s, %s, %s, %s, 'UNPLANNED', 'ACTIVE', %s, 0, %s, NOW(), NOW())
        """,
        (
            planner_ps_id,
            source_ps_id,
            temp_partial_no,
            inventory_code,
            selected_bom_id,
            qty,
            note,
        ),
    )
    _persist_temp_process_sheet_record(
        con,
        planner_ps_id=planner_ps_id,
        preview=preview,
        source_pp_partial_no=pp_partial_no,
        qty=qty,
        remarks=note,
    )
    preview["selected_bom_id"] = _ensure_temp_ps_bom(
        con,
        planner_ps_id,
        inventory_code,
        preview,
        placeholder=False,
    )
    row = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    temp_row = one(
        con.execute(
            "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    selected_bom_code = compact_text((temp_row or {}).get("selected_bom_code"))
    if not selected_bom_code and int(preview.get("selected_bom_id") or 0):
        flow = one(
            con.execute(
                "SELECT bom_code FROM planner_bom_variation WHERE bom_id = %s",
                (int(preview["selected_bom_id"]),),
            )
        )
        selected_bom_code = compact_text((flow or {}).get("bom_code"))
    return {
        "planner_ps_id": planner_ps_id,
        "ps_id": planner_ps_id,
        "display_ps_id": temp_planner_ps_display_label(planner_ps_id),
        "source_ps_id": source_ps_id,
        "source_pp_partial_no": pp_partial_no,
        "temp_source_ps_id": source_ps_id,
        "temp_source_label": format_planner_ps_id(source_ps_id, pp_partial_no),
        "is_temp_ps": True,
        "pp_partial_no": temp_partial_no,
        "planned_qty": qty,
        "reject_qty": qty,
        "part_no": preview.get("part_no") or "",
        "part_desc": preview.get("part_desc") or "",
        "due_date": preview.get("due_date") or "",
        "selected_bom_code": selected_bom_code or preview.get("selected_bom_code") or "",
        "is_temp": True,
        "stored_in": "planner_process_sheet + planner_temp_process_sheet",
        "row": dict(row) if row else {},
        "temp_record": dict(temp_row) if temp_row else {},
    }


def create_placeholder_temp_process_sheet(
    con,
    *,
    reference_ps_id,
    part_no,
    part_desc="",
    qty,
    remarks="",
):
    """Dummy [Temp] PS with a PLACEHOLDER BOM for lane scheduling until ERP PS exists."""
    reference_ps_id = normalize_temp_ps_reference(reference_ps_id)
    if not reference_ps_id:
        raise ValueError(
            "Process sheet number is required for placeholder temp PS (e.g. NPS25-0205). "
            "Use the PS number, not the part / inventory code."
        )
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("Part number is required.")
    qty = max(0.0, _to_float(qty))
    if qty <= 0:
        raise ValueError("Quantity must be greater than zero.")

    planner_ps_id, temp_partial_no = _allocate_temp_planner_identity(con, reference_ps_id)
    existing = one(
        con.execute(
            "SELECT planner_ps_id FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if existing:
        raise ValueError(f"Temp process sheet {planner_ps_id} already exists.")

    note = compact_text(remarks) or f"Temp placeholder PS ({reference_ps_id})"
    preview = {
        "source_ps_id": reference_ps_id,
        "pp_partial_no": 1,
        "part_no": part_no,
        "part_desc": compact_text(part_desc),
        "due_date": "",
        "display_qty": 0,
        "erp_bom_code": "",
        "selected_bom_id": 0,
        "selected_bom_code": "",
        "selected_bom_desc": "",
        "ops_preview": [],
        "temp_name_preview": temp_planner_ps_display_label(f"{TEMP_PS_PREFIX}{reference_ps_id}"),
    }

    con.execute(
        """
        INSERT INTO planner_process_sheet (
          planner_ps_id, source_ps_id, pp_partial_no, inventory_code,
          selected_bom_id, planner_status, status, planned_qty, finished_qty,
          remarks, created_at, updated_at
        ) VALUES (%s, %s, %s, %s, NULL, 'UNPLANNED', 'ACTIVE', %s, 0, %s, NOW(), NOW())
        """,
        (
            planner_ps_id,
            reference_ps_id,
            temp_partial_no,
            part_no,
            qty,
            note,
        ),
    )
    _persist_temp_process_sheet_record(
        con,
        planner_ps_id=planner_ps_id,
        preview=preview,
        source_pp_partial_no=1,
        qty=qty,
        remarks=note,
    )
    bom_id = _ensure_temp_ps_bom(
        con,
        planner_ps_id,
        part_no,
        preview,
        placeholder=True,
    )
    preview["selected_bom_id"] = bom_id
    preview["selected_bom_code"] = "PLACEHOLDER"

    row = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    temp_row = one(
        con.execute(
            "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    return {
        "planner_ps_id": planner_ps_id,
        "ps_id": planner_ps_id,
        "display_ps_id": temp_planner_ps_display_label(planner_ps_id),
        "source_ps_id": reference_ps_id,
        "source_pp_partial_no": 1,
        "temp_source_ps_id": reference_ps_id,
        "temp_source_label": reference_ps_id,
        "is_temp_ps": True,
        "is_placeholder": True,
        "pp_partial_no": temp_partial_no,
        "planned_qty": qty,
        "reject_qty": qty,
        "part_no": part_no,
        "part_desc": compact_text(part_desc),
        "due_date": "",
        "selected_bom_code": "PLACEHOLDER",
        "is_temp": True,
        "stored_in": "planner_process_sheet + planner_temp_process_sheet",
        "row": dict(row) if row else {},
        "temp_record": dict(temp_row) if temp_row else {},
    }


def _repair_temp_ps_bom_if_missing(con, planner_ps_id):
    """Backfill BOM route for legacy [Temp] rows created before auto-clone."""
    planner_ps_id = compact_text(planner_ps_id)
    if not is_temp_planner_ps_id(planner_ps_id):
        return 0
    ps_row = one(
        con.execute(
            "SELECT planner_ps_id, inventory_code, selected_bom_id FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if not ps_row or int(ps_row.get("selected_bom_id") or 0) > 0:
        return int((ps_row or {}).get("selected_bom_id") or 0)
    temp_reg = one(
        con.execute(
            "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if not temp_reg:
        return 0
    inventory_code = compact_text(ps_row.get("inventory_code") or temp_reg.get("part_no"))
    preview = {
        "source_ps_id": compact_text(temp_reg.get("source_ps_id")),
        "pp_partial_no": int(temp_reg.get("source_pp_partial_no") or 1),
        "part_no": compact_text(temp_reg.get("part_no")),
        "part_desc": compact_text(temp_reg.get("part_desc")),
        "selected_bom_id": 0,
        "selected_bom_code": "",
    }
    placeholder = not preview["source_ps_id"] or compact_text(temp_reg.get("selected_bom_code")) == "PLACEHOLDER"
    return _ensure_temp_ps_bom(
        con,
        planner_ps_id,
        inventory_code,
        preview,
        placeholder=placeholder,
    )


def delete_temp_process_sheet(con, planner_ps_id):
    planner_ps_id = compact_text(planner_ps_id)
    if not is_temp_planner_ps_id(planner_ps_id):
        raise ValueError("Only [Temp] process sheets can be deleted from this action.")
    row = one(
        con.execute(
            "SELECT planner_ps_id FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if not row:
        raise ValueError("Temp process sheet not found.")

    op_ids = [
        int(r["operation_id"])
        for r in rows(
            con.execute(
                """
                SELECT operation_id
                FROM planner_operation
                WHERE source_ps_id = %s OR job_no = %s
                """,
                (planner_ps_id, planner_ps_id),
            )
        )
        if int(r.get("operation_id") or 0) > 0
    ]
    if op_ids:
        block_ids = [
            int(r["block_id"])
            for r in rows(
                con.execute(
                    """
                    SELECT block_id
                    FROM planner_run_block
                    WHERE operation_id = ANY(%s)
                    """,
                    (op_ids,),
                )
            )
            if int(r.get("block_id") or 0) > 0
        ]
        if block_ids:
            con.execute(
                "DELETE FROM planner_run_block_segment WHERE block_id = ANY(%s)",
                (block_ids,),
            )
            con.execute("DELETE FROM planner_run_block WHERE block_id = ANY(%s)", (block_ids,))
        con.execute("DELETE FROM planner_operation WHERE operation_id = ANY(%s)", (op_ids,))

    con.execute(
        "DELETE FROM planner_process_sheet WHERE planner_ps_id = %s",
        (planner_ps_id,),
    )
    return {"ok": True, "planner_ps_id": planner_ps_id, "deleted": True}


_OVERLAY_COLUMN_CACHE = None


def _overlay_column_flags(con):
    """Detect overlay columns without DDL (safe on hot read paths)."""
    global _OVERLAY_COLUMN_CACHE
    if _OVERLAY_COLUMN_CACHE is not None:
        return _OVERLAY_COLUMN_CACHE
    flags = {"coway": False, "remarks": False, "material_in": False}
    try:
        for row in rows(
            con.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'planner_process_sheet'
                  AND column_name IN ('coway_proposed_edd', 'remarks', 'material_in')
                """
            )
        ):
            name = compact_text(row.get("column_name"))
            if name == "coway_proposed_edd":
                flags["coway"] = True
            elif name == "remarks":
                flags["remarks"] = True
            elif name == "material_in":
                flags["material_in"] = True
    except Exception:
        pass
    _OVERLAY_COLUMN_CACHE = flags
    return flags


def _ensure_planner_overlay_columns(con):
    """Apply overlay DDL only when a write path needs a missing column."""
    flags = _overlay_column_flags(con)
    if flags["coway"] and flags["remarks"] and flags["material_in"]:
        return flags
    global _OVERLAY_COLUMN_CACHE
    try:
        if not flags["coway"]:
            con.execute(
                """
                ALTER TABLE planner_process_sheet
                ADD COLUMN IF NOT EXISTS coway_proposed_edd DATE
                """
            )
            flags["coway"] = True
        if not flags["remarks"]:
            con.execute(
                """
                ALTER TABLE planner_process_sheet
                ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT ''
                """
            )
            flags["remarks"] = True
        if not flags["material_in"]:
            con.execute(
                """
                ALTER TABLE planner_process_sheet
                ADD COLUMN IF NOT EXISTS material_in BOOLEAN NOT NULL DEFAULT FALSE
                """
            )
            flags["material_in"] = True
    except Exception:
        pass
    _OVERLAY_COLUMN_CACHE = dict(flags)
    return _OVERLAY_COLUMN_CACHE


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

    source_ps_id, _ = parse_planner_ps_id(planner_ps_id)
    if is_temp_planner_ps_id(source_ps_id):
        planner_ps_id = source_ps_id

    existing = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if existing:
        return existing

    if is_temp_planner_ps_id(planner_ps_id):
        raise ValueError(
            f"Process sheet {planner_ps_id} was not found. Create the [Temp] PS first."
        )

    _, pp_partial_no = parse_planner_ps_id(planner_ps_id)
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
                   pfs.source_kind, pfs.source_stage_no,
                   COALESCE(so.wo_qty_required, 0) AS erp_required_qty,
                   COALESCE(so.wo_qty_produced, 0) AS erp_finished_qty,
                   COALESCE(so.wo_qty_rejected, 0) AS erp_reject_qty,
                   so.execution_status AS erp_execution_status
            FROM planner_process_sheet ps
            JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
            LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
            LEFT JOIN erp_stage_outputs so
                   ON so.ps_id = ps.source_ps_id
                  AND so.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
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
    planner_ps_id = compact_text(ps.get("ps_id") or ps.get("planner_ps_id"))
    try:
        partial_int = _temp_source_partial_no(con, planner_ps_id, pp_partial_no)
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


def _temp_work_qty(ps):
    """Reject/rework qty for a [Temp] PS — never the source ERP order qty."""
    return _to_float(ps.get("planned_qty") or ps.get("reject_qty"))


def _strip_temp_step_erp_qty(steps):
    """Temp rework must not inherit source PS stage completion or WO quantities."""
    cleaned = []
    for step in steps or []:
        row = dict(step)
        row["erp_required_qty"] = 0.0
        row["erp_finished_qty"] = 0.0
        row["erp_reject_qty"] = 0.0
        row["erp_execution_status"] = ""
        cleaned.append(row)
    return cleaned


def _process_sheet_payload(ps, steps, metrics, material_status, manual_by_op_seq=None):
    raw_planned_qty = _to_float(metrics.get("planned_qty_total"))
    raw_finished_qty = _to_float(metrics.get("finished_qty_total"))
    is_temp = is_temp_planner_ps_id(ps.get("ps_id") or ps.get("planner_ps_id"))
    source_total_qty = _to_float(ps.get("total_qty") or ps.get("planned_qty"))
    partial_qty = _to_float(ps.get("partial_qty"))
    erp_required_qty = _to_float(ps.get("wo_qty_required"))
    if is_temp:
        display_qty = _temp_work_qty(ps) or partial_qty or source_total_qty
        source_total_qty = display_qty
        partial_qty = display_qty
        erp_required_qty = 0.0
        steps = _strip_temp_step_erp_qty(steps)
    else:
        display_qty = partial_qty or source_total_qty
    total_qty = display_qty
    steps = apply_flow_step_qty_cascade(steps, display_qty, manual_by_op_seq)
    planned_qty, finished_qty, reject_qty, remaining_qty = _summary_quantities(
        total_qty, steps, metrics
    )
    erp_finished_qty = 0.0 if is_temp else _to_float(ps.get("wo_qty_produced"))
    erp_reject_qty = 0.0 if is_temp else _to_float(ps.get("wo_qty_rejected"))
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
    if is_temp_planner_ps_id(ps.get("ps_id") or ps.get("planner_ps_id")):
        display_ps_id = temp_planner_ps_display_label(ps.get("ps_id") or ps.get("planner_ps_id"))
    queued_machines = list(metrics.get("queued_machines") or [])
    queued_machine_details = list(metrics.get("queued_machine_details") or [])
    is_queued = bool(queued_machines) or raw_planned_qty > 0
    return {
        "ps_id": ps.get("ps_id") or ps.get("planner_ps_id"),
        "source_ps_id": compact_text(ps.get("source_ps_id")) or display_ps_id,
        "pp_partial_no": pp_partial_no,
        "display_ps_id": display_ps_id,
        "is_temp_ps": is_temp_planner_ps_id(ps.get("ps_id") or ps.get("planner_ps_id")),
        "part_id": 0,
        "inventory_code": compact_text(ps.get("inventory_code") or ""),
        "part_name": compact_text(ps.get("part_no") or ps.get("part_name") or ""),
        "part_no": compact_text(ps.get("part_no") or ""),
        "part_desc": compact_text(ps.get("part_desc") or ps.get("description") or ""),
        "due_date": compact_text(ps.get("due_date") or ""),
        "coway_proposed_edd": compact_text(ps.get("coway_proposed_edd") or ""),
        "remarks": compact_text(ps.get("remarks") or ""),
        "order_date": compact_text(ps.get("order_date") or ""),
        "total_qty": display_qty if is_temp else source_total_qty,
        "partial_qty": display_qty if is_temp else partial_qty,
        "wo_req_qty": display_qty if is_temp else partial_qty,
        "total_wo_qty": display_qty if is_temp else source_total_qty,
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
    cascade_req = _to_float(step.get("cascade_required_qty"))
    erp_stage_req = _to_float(step.get("erp_required_qty"))
    # WO Req reflects ERP work-order quantity, capped to partial work qty when ERP over-aggregates.
    if erp_stage_req > 0 and work_qty > 0:
        wo_req_qty = min(erp_stage_req, work_qty)
    elif erp_stage_req > 0:
        wo_req_qty = erp_stage_req
    elif work_qty > 0:
        wo_req_qty = work_qty
    elif cascade_req > 0:
        wo_req_qty = cascade_req
    else:
        wo_req_qty = _to_float(step.get("total_qty"))
    ready_qty = cascade_req if cascade_req > 0 else wo_req_qty
    planned_qty = _to_float(op_metrics.get("planned_qty"))
    manual_prod = _to_float(step.get("manual_produced_qty"))
    manual_rej = _to_float(step.get("manual_reject_qty"))
    finished_qty = max(
        _to_float(op_metrics.get("finished_qty")),
        _to_float(step.get("erp_finished_qty")),
        manual_prod,
        _to_float(step.get("cascade_output_qty")),
    )
    reject_qty = max(
        _to_float(op_metrics.get("reject_qty")),
        _to_float(step.get("erp_reject_qty")),
        manual_rej,
        _to_float(step.get("cascade_reject_qty")),
    )
    if wo_req_qty > 0:
        finished_qty = min(finished_qty, wo_req_qty)
    queued_machines = list(op_metrics.get("queued_machines") or [])
    machine_code = queued_machines[0] if queued_machines else ""
    wo_remaining = max(0.0, wo_req_qty - finished_qty - reject_qty) if wo_req_qty else 0.0
    schedulable_remaining = max(0.0, ready_qty - planned_qty - finished_qty) if ready_qty else 0.0
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
        "source_kind": compact_text(step.get("source_kind") or ""),
        "needs_manual_produced": bool(step.get("needs_manual_produced")),
        "execution_status": compact_text(step.get("erp_execution_status") or ""),
        "required_qty": wo_req_qty,
        "wo_qty_required": wo_req_qty,
        "ready_qty": ready_qty,
        "wo_qty_produced": finished_qty,
        "manual_produced_qty": manual_prod,
        "wo_qty_rejected": reject_qty,
        "planned_qty": planned_qty,
        "finished_qty": finished_qty,
        "reject_qty": reject_qty,
        "remaining_qty": wo_remaining,
        "schedulable_remaining_qty": schedulable_remaining,
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


def _ps_select_sql(con=None):
    from planning.erp_wo_merge import ERP_STAGE_OUTPUTS_CTE

    flags = _overlay_column_flags(con) if con is not None else (_OVERLAY_COLUMN_CACHE or {"coway": True, "remarks": True})
    coway_expr = (
        "ps.coway_proposed_edd,"
        if flags.get("coway")
        else "NULL::DATE AS coway_proposed_edd,"
    )
    remarks_expr = (
        "ps.remarks,"
        if flags.get("remarks")
        else "'' AS remarks,"
    )

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
        tps.reject_qty,
        {coway_expr}
        {remarks_expr}
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
    LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
    LEFT JOIN voucher_partials v
           ON v.ps_id = ps.source_ps_id
          AND v.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
    LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
"""


def _ps_select(con):
    return _ps_select_sql(con)


# Backward compatibility for ad-hoc scripts (assumes overlay columns exist).
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


def _enrich_overlay_select_sql(flags):
    select_cols = ["source_ps_id", "pp_partial_no"]
    conditions = []
    if flags.get("coway"):
        select_cols.append("coway_proposed_edd")
        conditions.append("coway_proposed_edd IS NOT NULL")
    if flags.get("remarks"):
        select_cols.append("remarks")
        conditions.append("NULLIF(TRIM(remarks), '') IS NOT NULL")
    if not conditions:
        return None
    return (
        f"SELECT {', '.join(select_cols)} FROM planner_process_sheet "
        f"WHERE source_ps_id = ANY(%s) AND ({' OR '.join(conditions)})"
    )


def enrich_board_planner_fields(con, items):
    """Attach planner overlay fields when board rows omit them (common on ERP-only lines)."""
    if not items:
        return items
    flags = _overlay_column_flags(con)
    enrich_sql = _enrich_overlay_select_sql(flags)
    if not enrich_sql:
        return items
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
    for row in rows(con.execute(enrich_sql, (list(source_ids),))):
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
    ps_id = compact_text(item.get("ps_id") or "")
    if is_temp_planner_ps_id(ps_id):
        return ps_id
    source = compact_text(
        item.get("source_ps_id") or item.get("display_ps_id") or ps_id or ""
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
    _ensure_planner_temp_process_sheet_table(con)
    _overlay_column_flags(con)
    search = compact_text(request.args.get("search")).lower()
    status_filter = compact_text(request.args.get("status")).upper()
    planner_filter = compact_text(request.args.get("planner_status")).upper()
    show_completed = compact_text(request.args.get("show_completed")).lower() in {"1", "true", "yes", "on"}
    overdue_only = compact_text(request.args.get("overdue_only")).lower() in {"1", "true", "yes", "on"}

    ps_rows = [
        dict(row)
        for row in rows(
            con.execute(
                _ps_select(con) + " ORDER BY COALESCE(v.due_date::TEXT, ''), ps.planner_ps_id"
            )
        )
    ]
    ps_ids = [row["ps_id"] for row in ps_rows]
    steps_by_ps = _flow_steps_for_ps_ids(con, ps_ids)
    manual_qty_by_ps = _manual_qty_by_ps_ids(con, ps_ids)
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
            manual_qty_by_ps.get(ps_id, {}),
        )
        if is_temp_planner_ps_id(ps_id):
            if not int(ps.get("selected_bom_id") or 0):
                try:
                    repaired_bom_id = _repair_temp_ps_bom_if_missing(con, ps_id)
                    if repaired_bom_id:
                        ps["selected_bom_id"] = repaired_bom_id
                        steps = _resolve_process_sheet_steps(
                            con,
                            ps,
                            _flow_steps_for_ps_ids(con, [ps_id]).get(ps_id, []),
                            erp_steps_cache,
                        )
                        payload = _process_sheet_payload(
                            ps,
                            steps,
                            metrics_by_ps.get(ps_id, {}),
                            material_status_by_ps.get(ps_id, {}),
                            manual_qty_by_ps.get(ps_id, {}),
                        )
                except Exception:
                    pass
            temp_reg = one(
                con.execute(
                    "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
                    (ps_id,),
                )
            )
            if temp_reg:
                payload["temp_source_ps_id"] = compact_text(temp_reg.get("source_ps_id"))
                payload["temp_source_label"] = format_planner_ps_id(
                    temp_reg.get("source_ps_id"),
                    temp_reg.get("source_pp_partial_no"),
                )
                payload["reject_qty"] = _to_float(temp_reg.get("reject_qty"))
                if compact_text(temp_reg.get("part_no")):
                    payload["part_no"] = compact_text(temp_reg.get("part_no"))
                    payload["part_name"] = payload["part_no"]
                if compact_text(temp_reg.get("part_desc")):
                    payload["part_desc"] = compact_text(temp_reg.get("part_desc"))
                if compact_text(temp_reg.get("due_date")):
                    payload["due_date"] = compact_text(temp_reg.get("due_date"))
                if compact_text(temp_reg.get("selected_bom_code")):
                    payload["selected_flow_code"] = compact_text(temp_reg.get("selected_bom_code"))
                payload["stored_in"] = "planner_temp_process_sheet"
            if not compact_text(payload.get("due_date")):
                source_row = _voucher_partial_row(
                    con,
                    compact_text(ps.get("source_ps_id")),
                    1,
                )
                if source_row:
                    payload["due_date"] = compact_text(source_row.get("due_date"))
            if not compact_text(payload.get("part_no")):
                payload["part_no"] = compact_text(ps.get("inventory_code"))
            if not payload.get("temp_source_ps_id"):
                payload["temp_source_ps_id"] = compact_text(ps.get("source_ps_id"))
            if not payload.get("temp_source_label"):
                note = compact_text(ps.get("remarks"))
                cloned = re.search(r"cloned from (\S+)", note)
                payload["temp_source_label"] = (
                    cloned.group(1)
                    if cloned
                    else format_planner_ps_id(compact_text(ps.get("source_ps_id")), 1)
                )
        wo_key = (compact_text(ps.get("source_ps_id")), int(ps.get("pp_partial_no") or 1))
        if not is_temp_planner_ps_id(ps_id) and wo_complete_by_partial.get(wo_key):
            payload["erp_all_wo_complete"] = True
        haystack = " ".join(
            compact_text(payload.get(k)).lower()
            for k in (
                "ps_id",
                "source_ps_id",
                "display_ps_id",
                "pp_partial_no",
                "part_name",
                "part_no",
                "part_desc",
                "selected_flow_code",
                "status",
                "planner_status",
                "inventory_code",
                "temp_source_ps_id",
                "temp_source_label",
                "is_temp_ps",
            )
        )
        if payload.get("is_temp_ps"):
            haystack += " temp reject rework"
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


def material_in_map_for_planner_ps_ids(con, planner_ps_ids):
    """Return {planner_ps_id: bool} for scheduler catalog material-in flags."""
    flags = _overlay_column_flags(con)
    ids = [compact_text(i) for i in (planner_ps_ids or []) if compact_text(i)]
    if not ids:
        return {}
    if not flags.get("material_in"):
        return {pid: False for pid in ids}
    out = {pid: False for pid in ids}
    for row in rows(
        con.execute(
            """
            SELECT planner_ps_id, COALESCE(material_in, FALSE) AS material_in
            FROM planner_process_sheet
            WHERE planner_ps_id = ANY(%s)
            """,
            (ids,),
        )
    ):
        pid = compact_text(row.get("planner_ps_id"))
        if pid:
            out[pid] = bool(row.get("material_in"))
    return out


def due_date_map_for_planner_ps_ids(con, planner_ps_ids):
    """Return {planner_ps_id: due_date ISO string} for board lite loads."""
    ids = [compact_text(i) for i in (planner_ps_ids or []) if compact_text(i)]
    if not ids:
        return {}
    out = {pid: "" for pid in ids}
    try:
        query_rows = rows(
            con.execute(
                """
                WITH voucher_partials AS (
                    SELECT ps_id, pp_partial_no, MIN(due_date) AS due_date
                    FROM pp_vouchers_cache
                    GROUP BY ps_id, pp_partial_no
                )
                SELECT ps.planner_ps_id,
                       vp.due_date::TEXT AS due_date,
                       ps.coway_proposed_edd::TEXT AS coway_proposed_edd
                FROM planner_process_sheet ps
                LEFT JOIN voucher_partials vp
                       ON vp.ps_id = ps.source_ps_id
                      AND vp.pp_partial_no = ps.pp_partial_no
                WHERE ps.planner_ps_id = ANY(%s)
                """,
                (ids,),
            )
        )
    except Exception:
        import logging

        logging.getLogger(__name__).exception(
            "due_date_map_for_planner_ps_ids failed; returning empty due dates"
        )
        return out
    for row in query_rows:
        pid = compact_text(row.get("planner_ps_id"))
        if not pid:
            continue
        due_text = compact_text(row.get("due_date"))
        coway_text = compact_text(row.get("coway_proposed_edd"))
        # Match catalog sidebar: ERP due date wins; Coway proposed EDD is fallback only.
        out[pid] = due_text or coway_text
    return out


def _parse_material_in_field(raw):
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    text = compact_text(raw).lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off", ""):
        return False
    raise ValueError("material_in must be a boolean")


def _update_material_in(con, ps_id, material_in):
    _ensure_planner_overlay_columns(con)
    _, _, canonical_ps_id = _planner_ps_identity(ps_id)
    try:
        ensure_planner_process_sheet(con, canonical_ps_id)
    except ValueError as exc:
        return None, str(exc)
    con.execute(
        """
        UPDATE planner_process_sheet
        SET material_in = %s, updated_at = NOW()
        WHERE planner_ps_id = %s
        """,
        (bool(material_in), canonical_ps_id),
    )
    row = one(
        con.execute(
            "SELECT material_in FROM planner_process_sheet WHERE planner_ps_id = %s",
            (canonical_ps_id,),
        )
    )
    try:
        from app import _invalidate_pp_vouchers_with_ops_cache

        _invalidate_pp_vouchers_with_ops_cache()
    except Exception:
        pass
    return {
        "ps_id": canonical_ps_id,
        "material_in": bool((row or {}).get("material_in")),
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


def material_in_post_response():
    """Shared handler for stock-in flag saves (scheduler sidebar pill)."""
    data = request.get_json(force=True, silent=True) or {}
    ps_id = compact_text(data.get("ps_id"))
    if not ps_id:
        return jsonify({"error": "ps_id is required"}), 400
    if "material_in" not in data:
        return jsonify({"error": "material_in is required"}), 400
    try:
        material_in = _parse_material_in_field(data.get("material_in"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        with planner_db() as con:
            payload, err = _update_material_in(con, ps_id, material_in)
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        raise


@process_sheets_bp.post("/api/process-sheets/stock-in-flag")
@process_sheets_bp.post("/api/trial/process-sheets/stock-in-flag")
@process_sheets_bp.post("/api/trial/process-sheets/material-in")
@process_sheets_bp.post("/api/process-sheets/material-in")
def api_process_sheet_material_in_post():
    return material_in_post_response()


@process_sheets_bp.patch("/api/trial/process-sheets/<path:ps_id>/material-in")
@process_sheets_bp.put("/api/trial/process-sheets/<path:ps_id>/material-in")
@process_sheets_bp.patch("/api/process-sheets/<path:ps_id>/material-in")
@process_sheets_bp.put("/api/process-sheets/<path:ps_id>/material-in")
def api_process_sheet_material_in(ps_id):
    data = request.get_json(force=True, silent=True) or {}
    if "material_in" in data:
        raw = data.get("material_in")
    else:
        raw = data.get("value")
    try:
        material_in = _parse_material_in_field(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        with planner_db() as con:
            payload, err = _update_material_in(con, ps_id, material_in)
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        raise


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


@process_sheets_bp.patch("/api/trial/process-sheets/<path:ps_id>/bom-step-qty")
@process_sheets_bp.put("/api/trial/process-sheets/<path:ps_id>/bom-step-qty")
@process_sheets_bp.patch("/api/process-sheets/<path:ps_id>/bom-step-qty")
@process_sheets_bp.put("/api/process-sheets/<path:ps_id>/bom-step-qty")
def api_process_sheet_bom_step_qty(ps_id):
    data = request.get_json(force=True, silent=True) or {}
    op_seq_id = int(data.get("op_seq_id") or 0)
    if op_seq_id <= 0:
        return jsonify({"error": "op_seq_id is required"}), 400
    qty_produced = max(0.0, _to_float(data.get("qty_produced")))
    qty_rejected = max(0.0, _to_float(data.get("qty_rejected")))
    try:
        with planner_db() as con:
            _, _, canonical_ps_id = _planner_ps_identity(ps_id)
            try:
                ps = ensure_planner_process_sheet(con, canonical_ps_id)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 404
            if not ps:
                return jsonify({"error": "Process sheet not found"}), 404
            selected_bom_id = int(ps.get("selected_bom_id") or 0)
            if not selected_bom_id:
                return jsonify({"error": "No planner BOM selected for this process sheet"}), 400
            step = one(
                con.execute(
                    """
                    SELECT op_seq_id, source_kind, source_stage_no
                    FROM planner_operation_seq
                    WHERE op_seq_id = %s AND bom_id = %s
                    """,
                    (op_seq_id, selected_bom_id),
                )
            )
            if not step:
                return jsonify({"error": "Operation step not found on selected BOM"}), 404
            if not step_needs_manual_produced(step):
                return jsonify({"error": "This step uses ERP produced qty; manual entry is not allowed"}), 400
            _ensure_bom_step_qty_table(con)
            con.execute(
                """
                INSERT INTO planner_ps_bom_step_qty (
                    planner_ps_id, op_seq_id, qty_produced, qty_rejected, updated_at
                ) VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (planner_ps_id, op_seq_id) DO UPDATE SET
                    qty_produced = EXCLUDED.qty_produced,
                    qty_rejected = EXCLUDED.qty_rejected,
                    updated_at = NOW()
                """,
                (canonical_ps_id, op_seq_id, qty_produced, qty_rejected),
            )
            steps_by_ps = _flow_steps_for_ps_ids(con, [canonical_ps_id])
            manual_qty_by_ps = _manual_qty_by_ps_ids(con, [canonical_ps_id])
            metrics_by_ps, _ = _block_metrics_for_ps_ids(con, [canonical_ps_id])
            material_status_by_ps = material_status_map_for_ps_ids(
                con,
                [canonical_ps_id],
                {canonical_ps_id: metrics_by_ps.get(canonical_ps_id, {}).get("expected_start", "")},
            )
            ps_row = one(
                con.execute(
                    _ps_select(con) + " WHERE ps.planner_ps_id = %s",
                    (canonical_ps_id,),
                )
            )
            steps = _resolve_process_sheet_steps(con, dict(ps_row), steps_by_ps.get(canonical_ps_id, []))
            summary = _process_sheet_payload(
                dict(ps_row),
                steps,
                metrics_by_ps.get(canonical_ps_id, {}),
                material_status_by_ps.get(canonical_ps_id, {}),
                manual_qty_by_ps.get(canonical_ps_id, {}),
            )
            updated_op = next(
                (op for op in summary.get("ops", []) if int(op.get("op_seq_id") or 0) == op_seq_id),
                None,
            )
            return jsonify({
                "ok": True,
                "ps_id": canonical_ps_id,
                "op_seq_id": op_seq_id,
                "qty_produced": qty_produced,
                "qty_rejected": qty_rejected,
                "op": updated_op,
                "summary": {
                    "finished_qty": summary.get("finished_qty"),
                    "remaining_qty": summary.get("remaining_qty"),
                    "planned_qty": summary.get("planned_qty"),
                },
            })
    except Exception as e:
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
            _overlay_column_flags(con)
            _, _, canonical_ps_id = _planner_ps_identity(ps_id)
            ps = one(
                con.execute(
                    _ps_select(con) + " WHERE ps.planner_ps_id = %s",
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
                        _ps_select(con) + " WHERE ps.planner_ps_id = %s",
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
            manual_qty_by_ps = _manual_qty_by_ps_ids(con, [canonical_ps_id])
            steps = _resolve_process_sheet_steps(con, dict(ps), steps_by_ps.get(canonical_ps_id, []))
            summary = _process_sheet_payload(
                dict(ps),
                steps,
                metrics_by_ps.get(canonical_ps_id, {}),
                material_status_by_ps.get(canonical_ps_id, {}),
                manual_qty_by_ps.get(canonical_ps_id, {}),
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


# Temp PS routes (register before any /process-sheets/<path:ps_id> catch-alls in other blueprints).
@process_sheets_bp.get("/api/trial/temp-process-sheets")
@process_sheets_bp.get("/api/temp-process-sheets")
def api_list_temp_process_sheets():
    """All sustained [Temp] reject/rework process sheets from planner_temp_process_sheet."""
    try:
        limit = int(request.args.get("limit") or 500)
    except (TypeError, ValueError):
        limit = 500
    try:
        with planner_db() as con:
            items = list_temp_process_sheets_payload(con, limit=limit)
            return jsonify({"items": items, "count": len(items)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.get("/api/trial/temp-process-sheets/search")
@process_sheets_bp.get("/api/temp-process-sheets/search")
def api_temp_process_sheet_search():
    query = compact_text(request.args.get("q") or request.args.get("search") or "")
    try:
        limit = int(request.args.get("limit") or 25)
    except (TypeError, ValueError):
        limit = 25
    try:
        with planner_db() as con:
            _ensure_planner_temp_process_sheet_table(con)
            items = search_process_sheet_sources(con, query, limit=limit)
            return jsonify({"items": items})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.get("/api/trial/temp-process-sheets/source")
@process_sheets_bp.get("/api/temp-process-sheets/source")
def api_temp_process_sheet_source():
    source_ps_id = compact_text(request.args.get("source_ps_id") or request.args.get("ps_id") or "")
    try:
        pp_partial_no = int(request.args.get("pp_partial_no") or request.args.get("partial") or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1
    if not source_ps_id:
        return jsonify({"error": "source_ps_id is required"}), 400
    try:
        with planner_db() as con:
            return jsonify(temp_process_sheet_source_preview(con, source_ps_id, pp_partial_no))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.post("/api/trial/temp-process-sheets")
@process_sheets_bp.post("/api/temp-process-sheets")
def api_create_temp_process_sheet():
    data = request.get_json(silent=True) or {}
    placeholder = compact_text(data.get("mode")).lower() == "placeholder" or bool(
        data.get("placeholder")
    )
    source_ps_id = compact_text(
        data.get("source_ps_id") or data.get("ps_id") or data.get("process_sheet_no") or ""
    )
    try:
        pp_partial_no = int(data.get("pp_partial_no") or data.get("partial_no") or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1
    qty = data.get("qty") or data.get("quantity") or data.get("planned_qty")
    remarks = compact_text(data.get("remarks") or "")
    try:
        with planner_db() as con:
            _ensure_planner_temp_process_sheet_table(con)
            if placeholder:
                ps_ref = normalize_temp_ps_reference(
                    data.get("reference_ps_id")
                    or data.get("label")
                    or data.get("source_ps_id")
                    or data.get("ps_id")
                    or ""
                )
                result = create_placeholder_temp_process_sheet(
                    con,
                    reference_ps_id=ps_ref,
                    part_no=compact_text(
                        data.get("part_no") or data.get("inventory_code") or ""
                    ),
                    part_desc=compact_text(data.get("part_desc") or data.get("description") or ""),
                    qty=qty,
                    remarks=remarks,
                )
            else:
                if not source_ps_id:
                    return jsonify({"error": "source_ps_id is required"}), 400
                result = create_temp_process_sheet(
                    con, source_ps_id, pp_partial_no, qty, remarks=remarks
                )
            try:
                from app import _invalidate_pp_vouchers_with_ops_cache

                _invalidate_pp_vouchers_with_ops_cache()
            except Exception:
                pass
            return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.delete("/api/trial/temp-process-sheets/<path:planner_ps_id>")
@process_sheets_bp.delete("/api/temp-process-sheets/<path:planner_ps_id>")
def api_delete_temp_process_sheet(planner_ps_id):
    try:
        with planner_db() as con:
            _ensure_planner_temp_process_sheet_table(con)
            result = delete_temp_process_sheet(con, planner_ps_id)
            try:
                from app import _invalidate_pp_vouchers_with_ops_cache

                _invalidate_pp_vouchers_with_ops_cache()
            except Exception:
                pass
            return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
