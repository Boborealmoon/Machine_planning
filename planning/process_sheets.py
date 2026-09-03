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

import os
import re
from datetime import date
from urllib.parse import unquote

from flask import Blueprint, jsonify, has_request_context, request

from db import planner_db_connect_error
from .helpers import one, rows, planner_db, planner_try_savepoint
from .materials import (
    enrich_items_material_inventory_codes,
    material_requirement_payload,
    material_status_map_for_ps_ids,
)
from .utils import (
    compact_text,
    op_production_complete,
    pending_delivery_order,
    sanitize_erp_execution_status,
    shipped_quantity_completed,
)

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


def _temp_registry_by_ps_ids(con, ps_ids):
    temp_ids = [compact_text(ps_id) for ps_id in ps_ids if is_temp_planner_ps_id(ps_id)]
    if not temp_ids:
        return {}
    return {
        compact_text(row.get("planner_ps_id")): dict(row)
        for row in rows(
            con.execute(
                "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = ANY(%s)",
                (temp_ids,),
            )
        )
        if compact_text(row.get("planner_ps_id"))
    }


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
    planner_ps_id = compact_text(planner_ps_id)
    target_is_temp = is_temp_planner_ps_id(planner_ps_id)
    target_source, target_partial, _ = _planner_ps_identity(planner_ps_id)
    for candidate in (compact_text(op_source_ps_id), compact_text(op_job_no)):
        if not candidate:
            continue
        if is_temp_planner_ps_id(candidate) != target_is_temp:
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


_PS_BASE_ID_RE = re.compile(
    r"^(?:APS|NPS|PPS|CPS|MPS|SR)\d{2}-\d{4}$",
    re.IGNORECASE,
)
_BULK_LOOKUP_PS_DASH_PARTIAL_RE = re.compile(
    r"^((?:APS|NPS|PPS|CPS|MPS|SR)\d{2}-\d{4})-(\d+)$",
    re.IGNORECASE,
)


def is_ps_base_id(value):
    return bool(_PS_BASE_ID_RE.match(compact_text(value)))


def normalize_standard_ps_id(value):
    """Uppercase canonical ERP process sheet numbers (NPS26-0294, etc.)."""
    raw = compact_text(value)
    if is_ps_base_id(raw):
        return raw.upper()
    return raw


def split_process_sheet_search_terms(search):
    """Split comma / semicolon / whitespace search text into lookup tokens."""
    raw = compact_text(search).replace(";", " ").replace(",", " ")
    return [part.lower() for part in raw.split() if part]


def parse_bulk_lookup_ps_term(term):
    """
    Parse a bulk-lookup token into (base_or_raw, partial_no).
    partial_no is set when the user specified a partial via :: or trailing -N
    (e.g. NPS25-0279-3). None means any partial is acceptable.
    """
    raw = compact_text(term).lower()
    if not raw:
        return "", None
    if "::" in raw:
        base, partial_text = raw.split("::", 1)
        base = base.strip()
        try:
            partial_no = int(partial_text)
        except (TypeError, ValueError):
            return raw, None
        return base, max(1, partial_no)
    match = _BULK_LOOKUP_PS_DASH_PARTIAL_RE.match(raw)
    if match:
        return match.group(1).lower(), int(match.group(2))
    return raw, None


TEMP_PS_PREFIX = "[Temp]"
TEMP_PARTIAL_MIN = 900001
_TEMP_TABLE_READY = False


def _planner_temp_process_sheet_table_ready(con):
    """Fast probe — no DDL. Safe on read paths (Process Sheets board list)."""
    global _TEMP_TABLE_READY
    if _TEMP_TABLE_READY:
        return True
    try:
        one(con.execute("SELECT 1 AS ok FROM public.planner_temp_process_sheet LIMIT 1"))
        _TEMP_TABLE_READY = True
        return True
    except Exception:
        return False


def _ensure_planner_temp_process_sheet_table(con):
    """Persistent registry for [Temp] reject/rework PS (PostgreSQL / SUPA_DB_URL).

    DDL runs only when the table is missing. When migration already created it,
    return immediately so concurrent app workers do not pile up CREATE/ALTER on
  planner_process_sheet and freeze the Process Sheets board.
    """
    global _TEMP_TABLE_READY
    if _TEMP_TABLE_READY:
        return
    if _planner_temp_process_sheet_table_ready(con):
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
    for stmt in (
        "ALTER TABLE public.planner_temp_process_sheet ADD COLUMN IF NOT EXISTS current_stage_op_seq_id BIGINT",
        "ALTER TABLE public.planner_temp_process_sheet ADD COLUMN IF NOT EXISTS current_stage_seq_no INTEGER",
        "ALTER TABLE public.planner_temp_process_sheet ADD COLUMN IF NOT EXISTS current_stage_desc TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE public.planner_temp_process_sheet ADD COLUMN IF NOT EXISTS current_stage_status TEXT NOT NULL DEFAULT ''",
    ):
        con.execute(stmt)
    _TEMP_TABLE_READY = True


def _temp_source_ps_stage_label(stage_no, op_no, stage_desc, seq_no=0):
    stage_desc = compact_text(stage_desc)
    if stage_desc:
        return stage_desc
    op_no = compact_text(op_no)
    if op_no:
        return op_no if op_no.upper().startswith("OP") else f"OP{op_no}"
    if stage_no:
        return f"Stage {stage_no}"
    return f"Step {seq_no or '?'}"


def _format_source_ps_stage_options(steps):
    out = []
    for idx, step in enumerate(steps or []):
        stage_no = int(step.get("source_stage_no") or step.get("stage_no") or step.get("op_seq_id") or 0)
        stage_desc = compact_text(step.get("stage_desc") or step.get("op_type") or "")
        op_no = compact_text(step.get("op_no"))
        seq_no = int(step.get("seq_no") or idx + 1)
        label = _temp_source_ps_stage_label(stage_no, op_no, stage_desc, seq_no)
        if not label:
            continue
        stage_key = stage_no or seq_no
        out.append(
            {
                "stage_no": stage_key,
                "seq_no": seq_no,
                "op_no": op_no,
                "stage_desc": stage_desc,
                "label": label,
                "op_seq_id": stage_key,
            }
        )
    return out


def _temp_source_ps_stages_for_keys(con, partial_keys):
    keys = []
    seen = set()
    for source_ps_id, pp_partial_no in partial_keys or []:
        source_ps_id = compact_text(source_ps_id)
        if not source_ps_id:
            continue
        try:
            partial = int(pp_partial_no or 1)
        except (TypeError, ValueError):
            partial = 1
        key = (source_ps_id, partial)
        if key in seen:
            continue
        seen.add(key)
        keys.append(key)
    if not keys:
        return {}

    canonical_ids = [format_planner_ps_id(source_ps_id, partial) for source_ps_id, partial in keys]
    flow_by_ps = _flow_steps_for_ps_ids(con, canonical_ids)
    erp_cache = _erp_cache_steps_batch(con, keys)
    out = {}
    for source_ps_id, partial in keys:
        canonical = format_planner_ps_id(source_ps_id, partial)
        ps_row = one(
            con.execute(
                "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
                (canonical,),
            )
        )
        ps = dict(ps_row or {})
        ps["ps_id"] = canonical
        ps["planner_ps_id"] = canonical
        ps["source_ps_id"] = source_ps_id
        ps["pp_partial_no"] = partial
        flow_steps = flow_by_ps.get(canonical, [])
        steps, _ = _prepare_process_sheet_steps(con, ps, flow_steps, erp_cache)
        out[(source_ps_id, partial)] = _format_source_ps_stage_options(steps)
    return out


def _temp_source_ps_stage_row(con, source_ps_id, pp_partial_no, *, stage_no=None):
    source_ps_id = compact_text(source_ps_id)
    try:
        pp_partial_no = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1
    try:
        stage_no = int(stage_no or 0)
    except (TypeError, ValueError):
        stage_no = 0
    if not source_ps_id or stage_no <= 0:
        return None
    stages = _temp_source_ps_stages_for_keys(con, [(source_ps_id, pp_partial_no)]).get(
        (source_ps_id, pp_partial_no),
        [],
    )
    for stage in stages:
        if int(stage.get("stage_no") or stage.get("op_seq_id") or 0) == stage_no:
            return stage
    return None


def _apply_temp_ps_stage_fields(payload, temp_reg):
    if not temp_reg:
        return
    op_seq_id = int(temp_reg.get("current_stage_op_seq_id") or 0)
    stage_no = int(temp_reg.get("current_stage_seq_no") or 0) or op_seq_id
    payload["current_stage_op_seq_id"] = stage_no or None
    payload["current_stage_no"] = stage_no
    payload["current_stage_desc"] = compact_text(temp_reg.get("current_stage_desc") or "")
    payload["current_stage_status"] = compact_text(temp_reg.get("current_stage_status") or "")


def _parse_temp_due_date(raw) -> date | None:
    text = compact_text(raw)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        raise ValueError("due_date must be YYYY-MM-DD") from None


def _persist_temp_process_sheet_record(
    con, *, planner_ps_id, preview, source_pp_partial_no, qty, remarks, due_date=None
):
    _ensure_planner_temp_process_sheet_table(con)
    due_raw = compact_text(due_date if due_date is not None else preview.get("due_date"))
    due_val = _parse_temp_due_date(due_raw) if due_raw else None
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
          due_date = COALESCE(EXCLUDED.due_date, planner_temp_process_sheet.due_date),
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
    if not _planner_temp_process_sheet_table_ready(con):
        return []
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
    partial_keys = [
        (compact_text(r.get("source_ps_id")), int(r.get("source_pp_partial_no") or 1))
        for r in rows_raw
        if compact_text(r.get("source_ps_id"))
    ]
    stages_by_source = _temp_source_ps_stages_for_keys(con, partial_keys)
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
                "is_placeholder": compact_text(row.get("selected_bom_code")).upper() == "PLACEHOLDER",
                "planner_status": compact_text(row.get("planner_status")),
                "ps_status": compact_text(row.get("ps_status")),
                "created_at": compact_text(row.get("created_at")),
                "updated_at": compact_text(row.get("updated_at")),
                "is_queued": planned_lane > 0 or bool(queued_machines),
                "queued_machines": queued_machines,
                "remaining_qty": max(0.0, _to_float(row.get("reject_qty")) - _to_float(row.get("finished_qty"))),
                "is_resolved": compact_text(row.get("planner_status")).upper() == "COMPLETED"
                or compact_text(row.get("ps_status")).upper() == "COMPLETED",
                "selected_bom_id": int(row.get("selected_bom_id") or 0),
                "current_stage_op_seq_id": int(row.get("current_stage_op_seq_id") or 0) or None,
                "current_stage_seq_no": int(row.get("current_stage_seq_no") or 0) or None,
                "current_stage_desc": compact_text(row.get("current_stage_desc")),
                "current_stage_status": compact_text(row.get("current_stage_status")),
                "bom_stages": stages_by_source.get(
                    (
                        compact_text(row.get("source_ps_id")),
                        int(row.get("source_pp_partial_no") or 1),
                    ),
                    [],
                ),
                "stored_in": "planner_temp_process_sheet",
            }
        )
    return out


def is_temp_planner_ps_id(planner_ps_id):
    return compact_text(planner_ps_id).upper().startswith("[TEMP]")


def canonical_temp_planner_ps_id(planner_ps_id):
    """Stored [Temp] identity: decode URL encoding and drop the display space after [Temp]."""
    raw = compact_text(unquote(compact_text(planner_ps_id)))
    if not raw:
        return ""
    if not raw.upper().startswith("[TEMP]"):
        return raw
    body = compact_text(raw[len(TEMP_PS_PREFIX) :] if raw.startswith(TEMP_PS_PREFIX) else raw[6:])
    return f"{TEMP_PS_PREFIX}{body}" if body else TEMP_PS_PREFIX


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


def _planner_bom_steps_to_flow_steps(con, bom_id):
    """Copy planner_operation_seq rows into flow-step dicts for temp BOM cloning."""
    bom_id = int(bom_id or 0)
    if bom_id <= 0:
        return []
    step_rows = rows(
        con.execute(
            """
            SELECT seq_no, op_no, op_type, machine_category, preferred_machine,
                   cycle_time, setup_time, is_last_op, source_kind, source_stage_no, planner_note
            FROM planner_operation_seq
            WHERE bom_id = %s
            ORDER BY seq_no, op_seq_id
            """,
            (bom_id,),
        )
    )
    if not step_rows:
        return []
    out = []
    for idx, row in enumerate(step_rows):
        out.append(
            {
                "seq_no": int(row.get("seq_no") or idx + 1),
                "op_no": compact_text(row.get("op_no")) or str(idx + 1),
                "op_type": compact_text(row.get("op_type")) or "OP",
                "machine_category": compact_text(row.get("machine_category")) or "GENERAL",
                "preferred_machine": compact_text(row.get("preferred_machine")),
                "cycle_time": max(0.0, _to_float(row.get("cycle_time") or 1)),
                "setup_time": max(0.0, _to_float(row.get("setup_time"))),
                "is_last_op": int(bool(row.get("is_last_op"))),
                "source_kind": compact_text(row.get("source_kind") or "ERP"),
                "source_stage_no": int(row.get("source_stage_no") or 0) or None,
                "planner_note": compact_text(row.get("planner_note")),
            }
        )
    if out:
        out[-1]["is_last_op"] = 1
    return out


def _temp_ps_flow_steps_from_preview(con, preview, *, placeholder=False):
    """Best route for a [Temp] PS: clone assigned planner BOM, else ERP stages, else placeholder."""
    if placeholder:
        return _placeholder_flow_steps(), "PLACEHOLDER", "Temp placeholder route", "MANUAL"

    source_ps_id = compact_text(preview.get("source_ps_id"))
    source_partial = int(preview.get("pp_partial_no") or 1)
    planner_bom_id = int(preview.get("selected_bom_id") or 0)
    planner_steps = _planner_bom_steps_to_flow_steps(con, planner_bom_id)
    if planner_steps:
        source_label = format_planner_ps_id(source_ps_id, source_partial) if source_ps_id else "source"
        bom_code = _unique_temp_bom_code(
            con,
            compact_text(preview.get("part_no")),
            f"{source_ps_id or source_label}-TEMP-REWORK",
        )
        bom_desc = f"Temp rework route from {source_label}"
        return planner_steps, bom_code, bom_desc, "ERP"

    erp_steps = _erp_cache_steps_for_ps(con, source_ps_id, source_partial)
    if erp_steps:
        bom_code = _unique_temp_bom_code(
            con,
            compact_text(preview.get("part_no")),
            f"{source_ps_id}-TEMP-REWORK",
        )
        bom_desc = f"Temp rework route from {format_planner_ps_id(source_ps_id, source_partial)}"
        return _erp_steps_to_flow_steps(erp_steps), bom_code, bom_desc, "ERP"

    return _placeholder_flow_steps(), "PLACEHOLDER", "Temp placeholder route", "MANUAL"


def _ensure_temp_ps_bom(con, planner_ps_id, inventory_code, preview, *, placeholder=False):
    """Assign a dedicated planner BOM to a temp PS — clone assigned route steps when available."""
    planner_ps_id = compact_text(planner_ps_id)
    inventory_code = compact_text(inventory_code)
    if not inventory_code:
        raise ValueError("Inventory code is required to assign a BOM flow.")

    current = one(
        con.execute(
            "SELECT selected_bom_id FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    current_bom_id = int((current or {}).get("selected_bom_id") or 0)
    if current_bom_id > 0:
        has_steps = one(
            con.execute(
                "SELECT 1 FROM planner_operation_seq WHERE bom_id = %s LIMIT 1",
                (current_bom_id,),
            )
        )
        if has_steps:
            flow = one(
                con.execute(
                    "SELECT bom_code FROM planner_bom_variation WHERE bom_id = %s",
                    (current_bom_id,),
                )
            )
            bom_code = compact_text((flow or {}).get("bom_code"))
            if bom_code:
                con.execute(
                    """
                    UPDATE planner_temp_process_sheet
                    SET selected_bom_id = %s, selected_bom_code = %s, updated_at = NOW()
                    WHERE planner_ps_id = %s
                    """,
                    (current_bom_id, bom_code, planner_ps_id),
                )
            return current_bom_id

    from planning.flows import (
        _combined_flow_source_kind,
        _ensure_flow_source_columns,
        _insert_planner_bom_variation,
        _save_flow_steps,
    )

    _ensure_flow_source_columns(con)
    flow_steps, bom_code, bom_desc, flow_source_kind = _temp_ps_flow_steps_from_preview(
        con,
        preview,
        placeholder=placeholder,
    )

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
    source_ps_id = normalize_standard_ps_id(source_ps_id)
    pp_partial_no = max(1, int(pp_partial_no or 1))
    ps_predicate = "UPPER(ps_id) = UPPER(%s)" if is_ps_base_id(source_ps_id) else "ps_id = %s"
    return one(
        con.execute(
            f"""
            SELECT ps_id, pp_partial_no,
                   MAX(part_no) AS part_no,
                   MAX(description) AS description,
                   MIN(due_date) AS due_date,
                   MAX(bom_code) AS bom_code,
                   MAX(total_qty) AS total_qty,
                   MAX(partial_qty) AS partial_qty,
                   MAX(status) AS erp_status
            FROM pp_vouchers_cache
            WHERE {ps_predicate} AND pp_partial_no = %s
            GROUP BY ps_id, pp_partial_no
            """,
            (source_ps_id, pp_partial_no),
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


def update_temp_process_sheet(con, planner_ps_id, updates=None):
    """Update editable fields on a [Temp] process sheet."""
    planner_ps_id = canonical_temp_planner_ps_id(planner_ps_id)
    if not is_temp_planner_ps_id(planner_ps_id):
        raise ValueError("Not a temp process sheet")
    updates = dict(updates or {})
    if not updates:
        raise ValueError("No fields to update")
    _ensure_planner_temp_process_sheet_table(con)
    temp_row = one(
        con.execute(
            "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if not temp_row:
        raise ValueError(f"Temp process sheet {planner_ps_id} not found")
    ps_row = one(
        con.execute(
            """
            SELECT planner_ps_id, planned_qty, finished_qty, inventory_code, remarks
            FROM planner_process_sheet
            WHERE planner_ps_id = %s
            """,
            (planner_ps_id,),
        )
    )
    if not ps_row:
        raise ValueError(f"Temp process sheet {planner_ps_id} not found")

    temp_sets = []
    temp_vals = []
    ps_sets = []
    ps_vals = []

    if "due_date" in updates or "po_due_date" in updates:
        due_raw = updates.get("due_date") if "due_date" in updates else updates.get("po_due_date")
        due_val = _parse_temp_due_date(due_raw) if compact_text(due_raw) else None
        temp_sets.append("due_date = %s")
        temp_vals.append(due_val)

    qty_raw = updates.get("qty") if "qty" in updates else updates.get("reject_qty")
    if qty_raw is not None:
        qty = max(0.0, _to_float(qty_raw))
        if qty <= 0:
            raise ValueError("Quantity must be greater than zero.")
        finished_qty = _to_float(ps_row.get("finished_qty"))
        if qty + 1e-9 < finished_qty:
            raise ValueError(
                f"Quantity cannot be less than finished qty ({finished_qty:g})."
            )
        temp_sets.extend(["reject_qty = %s"])
        temp_vals.append(qty)
        ps_sets.extend(["planned_qty = %s"])
        ps_vals.append(qty)

    if "remarks" in updates:
        note = compact_text(updates.get("remarks"))
        temp_sets.append("remarks = %s")
        temp_vals.append(note)
        ps_sets.append("remarks = %s")
        ps_vals.append(note)

    if "part_no" in updates:
        part_no = compact_text(updates.get("part_no"))
        if not part_no:
            raise ValueError("Part number is required.")
        temp_sets.extend(["part_no = %s", "inventory_code = %s"])
        temp_vals.extend([part_no, part_no])
        ps_sets.extend(["inventory_code = %s"])
        ps_vals.append(part_no)

    if "part_desc" in updates:
        part_desc = compact_text(updates.get("part_desc"))
        temp_sets.append("part_desc = %s")
        temp_vals.append(part_desc)

    if "source_ps_id" in updates or "source_label" in updates:
        raw = (
            updates.get("source_ps_id")
            if "source_ps_id" in updates
            else updates.get("source_label")
        )
        raw = normalize_temp_ps_reference(raw)
        if not raw:
            raise ValueError("Source PS number is required.")
        source_ps_id, source_partial = parse_planner_ps_id(raw)
        if not source_ps_id:
            source_ps_id = raw
        if "source_pp_partial_no" in updates:
            try:
                source_partial = max(1, int(updates.get("source_pp_partial_no") or 1))
            except (TypeError, ValueError):
                source_partial = 1
        temp_sets.extend(["source_ps_id = %s", "source_pp_partial_no = %s"])
        temp_vals.extend([source_ps_id, source_partial])
        ps_sets.append("source_ps_id = %s")
        ps_vals.append(source_ps_id)

    if "current_stage_op_seq_id" in updates or "current_stage_seq_no" in updates:
        source_ps_id = compact_text(temp_row.get("source_ps_id"))
        source_partial = int(temp_row.get("source_pp_partial_no") or 1)
        raw_op_seq = updates.get("current_stage_op_seq_id") if "current_stage_op_seq_id" in updates else None
        raw_seq_no = updates.get("current_stage_seq_no") if "current_stage_seq_no" in updates else None
        clear_stage = False
        if "current_stage_op_seq_id" in updates:
            clear_stage = raw_op_seq in (None, "", 0, "0")
        elif "current_stage_seq_no" in updates:
            clear_stage = raw_seq_no in (None, "", 0, "0")
        if clear_stage:
            temp_sets.extend(
                [
                    "current_stage_op_seq_id = NULL",
                    "current_stage_seq_no = NULL",
                    "current_stage_desc = %s",
                    "current_stage_status = %s",
                ]
            )
            temp_vals.extend(["", ""])
        else:
            raw_stage = raw_op_seq if "current_stage_op_seq_id" in updates else raw_seq_no
            stage_row = _temp_source_ps_stage_row(
                con,
                source_ps_id,
                source_partial,
                stage_no=raw_stage,
            )
            if not stage_row:
                raise ValueError("Selected stage is not part of the source process sheet.")
            stage_no = int(stage_row.get("stage_no") or stage_row.get("op_seq_id") or 0)
            temp_sets.extend(
                [
                    "current_stage_op_seq_id = %s",
                    "current_stage_seq_no = %s",
                    "current_stage_desc = %s",
                    "current_stage_status = %s",
                ]
            )
            temp_vals.extend(
                [
                    stage_no,
                    stage_no,
                    compact_text(stage_row.get("label") or stage_row.get("stage_desc")),
                    compact_text(updates.get("current_stage_status") or "P"),
                ]
            )

    if not temp_sets and not ps_sets:
        raise ValueError("No supported fields to update")

    if temp_sets:
        temp_sets.append("updated_at = NOW()")
        con.execute(
            f"""
            UPDATE planner_temp_process_sheet
            SET {", ".join(temp_sets)}
            WHERE planner_ps_id = %s
            """,
            (*temp_vals, planner_ps_id),
        )
    if ps_sets:
        ps_sets.append("updated_at = NOW()")
        con.execute(
            f"""
            UPDATE planner_process_sheet
            SET {", ".join(ps_sets)}
            WHERE planner_ps_id = %s
            """,
            (*ps_vals, planner_ps_id),
        )

    refreshed = one(
        con.execute(
            """
            SELECT t.reject_qty, t.part_no, t.part_desc, t.due_date, t.remarks,
                   t.source_ps_id, t.source_pp_partial_no,
                   t.selected_bom_id, t.current_stage_op_seq_id, t.current_stage_seq_no,
                   t.current_stage_desc, t.current_stage_status,
                   ps.planned_qty, ps.finished_qty
            FROM planner_temp_process_sheet t
            JOIN planner_process_sheet ps ON ps.planner_ps_id = t.planner_ps_id
            WHERE t.planner_ps_id = %s
            """,
            (planner_ps_id,),
        )
    )
    source_ps_id = compact_text((refreshed or {}).get("source_ps_id"))
    source_partial = int((refreshed or {}).get("source_pp_partial_no") or 1)
    return {
        "planner_ps_id": planner_ps_id,
        "display_ps_id": temp_planner_ps_display_label(planner_ps_id),
        "reject_qty": _to_float((refreshed or {}).get("reject_qty")),
        "planned_qty": _to_float((refreshed or {}).get("planned_qty")),
        "finished_qty": _to_float((refreshed or {}).get("finished_qty")),
        "part_no": compact_text((refreshed or {}).get("part_no")),
        "part_desc": compact_text((refreshed or {}).get("part_desc")),
        "due_date": compact_text((refreshed or {}).get("due_date")),
        "remarks": compact_text((refreshed or {}).get("remarks")),
        "source_ps_id": source_ps_id,
        "source_pp_partial_no": source_partial,
        "source_label": format_planner_ps_id(source_ps_id, source_partial),
        "selected_bom_id": int((refreshed or {}).get("selected_bom_id") or 0),
        "current_stage_op_seq_id": int((refreshed or {}).get("current_stage_op_seq_id") or 0) or None,
        "current_stage_seq_no": int((refreshed or {}).get("current_stage_seq_no") or 0) or None,
        "current_stage_desc": compact_text((refreshed or {}).get("current_stage_desc")),
        "current_stage_status": compact_text((refreshed or {}).get("current_stage_status")),
        "bom_stages": _temp_source_ps_stages_for_keys(
            con, [(source_ps_id, source_partial)]
        ).get((source_ps_id, source_partial), []),
    }


def update_temp_process_sheet_due_date(con, planner_ps_id, due_date_raw):
    """Set or clear PO due date on a [Temp] process sheet."""
    return update_temp_process_sheet(con, planner_ps_id, {"due_date": due_date_raw})


def create_temp_process_sheet(con, source_ps_id, pp_partial_no, qty, remarks="", due_date=""):
    preview = temp_process_sheet_source_preview(con, source_ps_id, pp_partial_no)
    if compact_text(due_date):
        preview["due_date"] = compact_text(due_date)[:10]
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
    note = compact_text(remarks)
    if not note:
        note = f"Temp reject PS cloned from {format_planner_ps_id(source_ps_id, pp_partial_no)}"

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
            source_ps_id,
            temp_partial_no,
            inventory_code,
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
        "due_date": compact_text((temp_row or {}).get("due_date")) or preview.get("due_date") or "",
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
    due_date="",
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
        "due_date": compact_text(due_date)[:10] if compact_text(due_date) else "",
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
        "due_date": compact_text((temp_row or {}).get("due_date")) or preview.get("due_date") or "",
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


def _erp_ps_planner_bom_is_corrupt(con, bom_id):
    """True when a planner BOM is a temp placeholder route, not a real ERP flow."""
    bom_id = int(bom_id or 0)
    if bom_id <= 0:
        return True
    flow = one(
        con.execute(
            "SELECT bom_code FROM planner_bom_variation WHERE bom_id = %s",
            (bom_id,),
        )
    )
    if not flow:
        return True
    bom_code = compact_text(flow.get("bom_code")).upper()
    if bom_code in {"", "PLACEHOLDER"} or "TEMP-REWORK" in bom_code:
        return True
    placeholder_step = one(
        con.execute(
            """
            SELECT 1
            FROM planner_operation_seq
            WHERE bom_id = %s
              AND UPPER(TRIM(COALESCE(op_type, ''))) = 'PLACEHOLDER'
            LIMIT 1
            """,
            (bom_id,),
        )
    )
    return bool(placeholder_step)


def _resolve_planner_bom_from_erp(con, source_ps_id, pp_partial_no, inventory_code):
    """Find or create the planner BOM that matches ERP cache for a process sheet."""
    source_ps_id = compact_text(source_ps_id)
    inventory_code = compact_text(inventory_code)
    try:
        pp_partial_no = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1
    if not source_ps_id or not inventory_code:
        return 0

    cache_row = _voucher_partial_row(con, source_ps_id, pp_partial_no)
    erp_bom_code = compact_text((cache_row or {}).get("bom_code"))
    if erp_bom_code:
        flow = one(
            con.execute(
                """
                SELECT bom_id
                FROM planner_bom_variation
                WHERE inventory_code = %s AND bom_code = %s
                LIMIT 1
                """,
                (inventory_code, erp_bom_code),
            )
        )
        if flow:
            return int(flow["bom_id"])

    erp_steps = _erp_cache_steps_for_ps(con, source_ps_id, pp_partial_no)
    if not erp_steps:
        flow = one(
            con.execute(
                """
                SELECT bom_id
                FROM planner_bom_variation
                WHERE inventory_code = %s
                ORDER BY is_default DESC, bom_id
                LIMIT 1
                """,
                (inventory_code,),
            )
        )
        return int(flow["bom_id"]) if flow else 0

    from planning.flows import (
        _combined_flow_source_kind,
        _ensure_flow_source_columns,
        _insert_planner_bom_variation,
        _save_flow_steps,
    )

    _ensure_flow_source_columns(con)
    bom_code = erp_bom_code or _unique_temp_bom_code(con, inventory_code, f"{source_ps_id}-ROUTE")
    bom_desc = f"Planner route for {format_planner_ps_id(source_ps_id, pp_partial_no)}"
    flow_row = _insert_planner_bom_variation(
        con,
        inventory_code=inventory_code,
        bom_code=bom_code,
        bom_desc=bom_desc,
        is_default=bool(erp_bom_code),
        flow_source_kind="ERP",
    )
    bom_id = int(flow_row["bom_id"])
    stage_kinds = _save_flow_steps(con, bom_id, _erp_steps_to_flow_steps(erp_steps))
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


def _repair_erp_ps_planner_bom_if_missing(con, planner_ps_id):
    """Restore ERP planner BOM when missing or stuck on a temp placeholder route."""
    planner_ps_id = compact_text(planner_ps_id)
    if not planner_ps_id or is_temp_planner_ps_id(planner_ps_id):
        return 0
    ps_row = one(
        con.execute(
            """
            SELECT planner_ps_id, source_ps_id, pp_partial_no, inventory_code, selected_bom_id
            FROM planner_process_sheet
            WHERE planner_ps_id = %s
            """,
            (planner_ps_id,),
        )
    )
    if not ps_row:
        return 0
    current_bom_id = int(ps_row.get("selected_bom_id") or 0)
    if current_bom_id > 0 and not _erp_ps_planner_bom_is_corrupt(con, current_bom_id):
        return current_bom_id

    source_ps_id = compact_text(ps_row.get("source_ps_id"))
    pp_partial_no = int(ps_row.get("pp_partial_no") or 1)
    inventory_code = compact_text(ps_row.get("inventory_code"))
    if not source_ps_id or not inventory_code:
        return current_bom_id

    bom_id = _resolve_planner_bom_from_erp(con, source_ps_id, pp_partial_no, inventory_code)
    if bom_id <= 0 or bom_id == current_bom_id:
        return current_bom_id

    con.execute(
        """
        UPDATE planner_process_sheet
        SET selected_bom_id = %s, updated_at = NOW()
        WHERE planner_ps_id = %s
        """,
        (bom_id, planner_ps_id),
    )
    return bom_id


def delete_temp_process_sheet(con, planner_ps_id):
    planner_ps_id = canonical_temp_planner_ps_id(planner_ps_id)
    if not is_temp_planner_ps_id(planner_ps_id):
        raise ValueError("Only [Temp] process sheets can be deleted from this action.")
    ps_row = one(
        con.execute(
            "SELECT planner_ps_id FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    temp_row = one(
        con.execute(
            "SELECT planner_ps_id FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if not ps_row and not temp_row:
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
            # Break the run_block ↔ operation_sequence circular FK before deleting blocks.
            planner_try_savepoint(
                con,
                "temp_ps_clear_opseq",
                lambda: con.execute(
                    """
                    UPDATE planner_run_block
                    SET operation_sequence_id = NULL
                    WHERE block_id = ANY(%s)
                    """,
                    (block_ids,),
                ),
            )
            planner_try_savepoint(
                con,
                "temp_ps_del_opseq",
                lambda: con.execute(
                    "DELETE FROM planner_operation_sequence WHERE block_id = ANY(%s)",
                    (block_ids,),
                ),
            )
            con.execute(
                "DELETE FROM planner_run_block_segment WHERE block_id = ANY(%s)",
                (block_ids,),
            )
            con.execute("DELETE FROM planner_run_block WHERE block_id = ANY(%s)", (block_ids,))
        con.execute("DELETE FROM planner_operation WHERE operation_id = ANY(%s)", (op_ids,))

    # Delete the temp registry first. Live DBs may have RESTRICT instead of ON DELETE CASCADE
    # (CREATE TABLE IF NOT EXISTS never upgrades an existing FK).
    con.execute(
        "DELETE FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
        (planner_ps_id,),
    )
    if ps_row:
        con.execute(
            "DELETE FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    return {"ok": True, "planner_ps_id": planner_ps_id, "deleted": True}


def _void_active_actuals_for_block_date(con, block_id, report_date):
    for row in rows(
        con.execute(
            """
            SELECT actual_id
            FROM planner_production_actual
            WHERE block_id = %s
              AND report_date = %s
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            """,
            (int(block_id), report_date),
        )
    ):
        con.execute(
            """
            UPDATE planner_production_actual
            SET status = 'VOID', updated_at = NOW()
            WHERE actual_id = %s
            """,
            (int(row["actual_id"]),),
        )


def _record_block_actual_for_resolve(
    con,
    *,
    block_id,
    machine_id,
    report_date,
    output_qty,
    reject_qty=0.0,
    remarks="",
):
    """Insert a same-day actual row so refresh_block_actual_status can pop the block off."""
    output_qty = max(0.0, _to_float(output_qty))
    reject_qty = max(0.0, _to_float(reject_qty))
    _void_active_actuals_for_block_date(con, block_id, report_date)
    good_qty = max(0.0, output_qty - reject_qty)
    con.execute(
        """
        INSERT INTO planner_production_actual (
            segment_id, block_id, machine_id, report_date, remarks, reported_at,
            output_qty, reject_qty, target_qty_at_report, status, entry_type,
            correction_of_actual_id, good_qty_at_report, created_by
        ) VALUES (NULL, %s, %s, %s, %s, NOW(), %s, %s, %s, 'ACTIVE', 'REPORT', NULL, %s, %s)
        """,
        (
            int(block_id),
            int(machine_id or 0) or None,
            report_date,
            compact_text(remarks) or "Temp PS resolve",
            output_qty,
            reject_qty,
            output_qty,
            good_qty,
            "temp-ps-resolve",
        ),
    )


def resolve_temp_process_sheet(con, planner_ps_id, qty_produced, qty_rejected=0.0, *, remarks=""):
    """Record rework output for a [Temp] PS and pop queued blocks off the planner when done."""
    from .actuals import actual_totals_for_block, refresh_block_actual_status

    planner_ps_id = canonical_temp_planner_ps_id(planner_ps_id)
    if not is_temp_planner_ps_id(planner_ps_id):
        raise ValueError("Only [Temp] process sheets can be resolved from this action.")

    ps = one(
        con.execute(
            "SELECT * FROM planner_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    if not ps:
        raise ValueError("Temp process sheet not found.")

    temp_row = one(
        con.execute(
            "SELECT * FROM planner_temp_process_sheet WHERE planner_ps_id = %s",
            (planner_ps_id,),
        )
    )
    reject_qty = _to_float((temp_row or {}).get("reject_qty") or ps.get("planned_qty"))
    qty_produced = max(0.0, _to_float(qty_produced))
    qty_rejected = max(0.0, _to_float(qty_rejected))
    if qty_produced <= 0 and qty_rejected <= 0:
        raise ValueError("Enter output or reject quantity.")

    finished_qty = min(reject_qty, qty_produced) if reject_qty > 0 else qty_produced
    is_complete = reject_qty > 0 and qty_produced + 1e-9 >= reject_qty
    planner_status = "COMPLETED" if is_complete else compact_text(ps.get("planner_status") or "UNPLANNED")
    ps_status = "COMPLETED" if is_complete else compact_text(ps.get("status") or "ACTIVE")
    if planner_status not in {"COMPLETED"} and finished_qty > 0:
        planner_status = "PARTIALLY_PLANNED" if planner_status == "UNPLANNED" else planner_status

    con.execute(
        """
        UPDATE planner_process_sheet
        SET finished_qty = %s,
            planner_status = %s,
            status = %s,
            updated_at = NOW()
        WHERE planner_ps_id = %s
        """,
        (finished_qty, planner_status, ps_status, planner_ps_id),
    )

    selected_bom_id = int(ps.get("selected_bom_id") or 0)
    updated_op_seq_ids = []
    if selected_bom_id:
        steps_by_ps = _flow_steps_for_ps_ids(con, [planner_ps_id])
        steps = _resolve_process_sheet_steps(con, dict(ps), steps_by_ps.get(planner_ps_id, []))
        manual_targets = [step for step in _last_operation_steps(steps) if int(step.get("op_seq_id") or 0) > 0]
        if not manual_targets:
            manual_targets = [
                step for step in steps if int(step.get("op_seq_id") or 0) > 0
            ]
        _ensure_bom_step_qty_table(con)
        for step in manual_targets:
            op_seq_id = int(step.get("op_seq_id") or 0)
            if op_seq_id <= 0:
                continue
            if not (step_needs_manual_produced(step) or is_temp_planner_ps_id(planner_ps_id)):
                continue
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
                (planner_ps_id, op_seq_id, finished_qty, qty_rejected),
            )
            updated_op_seq_ids.append(op_seq_id)

    _, block_rows_by_ps = _block_metrics_for_ps_ids(con, [planner_ps_id])
    block_rows = block_rows_by_ps.get(planner_ps_id, [])
    report_date = date.today().isoformat()
    popped_block_ids = []
    remaining_to_allocate = finished_qty
    note = compact_text(remarks) or "Temp PS resolve"

    for row in block_rows:
        block_id = int(row.get("block_id") or 0)
        if block_id <= 0 or remaining_to_allocate <= 1e-9:
            break
        block = one(
            con.execute(
                """
                SELECT block_id, machine_id, scheduled_qty, active
                FROM planner_run_block
                WHERE block_id = %s
                """,
                (block_id,),
            )
        )
        if not block or not block.get("active", True):
            continue
        scheduled_qty = _to_float(block.get("scheduled_qty"))
        totals = actual_totals_for_block(con, block_id)
        current_good = _to_float(totals.get("good_qty"))
        if is_complete:
            target_good = scheduled_qty
        else:
            target_good = min(scheduled_qty, remaining_to_allocate)
        if target_good + 1e-9 <= current_good:
            remaining_to_allocate = max(0.0, remaining_to_allocate - target_good)
            continue
        output_qty = target_good
        if qty_rejected > 0 and is_complete and len(block_rows) == 1:
            output_qty = target_good + qty_rejected
        _record_block_actual_for_resolve(
            con,
            block_id=block_id,
            machine_id=int(block.get("machine_id") or 0),
            report_date=report_date,
            output_qty=output_qty,
            reject_qty=qty_rejected if len(block_rows) == 1 else 0.0,
            remarks=note,
        )
        refresh_block_actual_status(con, block_id, auto_unschedule=True)
        popped_block_ids.append(block_id)
        remaining_to_allocate = max(0.0, remaining_to_allocate - target_good)

    return {
        "ok": True,
        "planner_ps_id": planner_ps_id,
        "display_ps_id": temp_planner_ps_display_label(planner_ps_id),
        "qty_produced": qty_produced,
        "qty_rejected": qty_rejected,
        "finished_qty": finished_qty,
        "reject_qty": reject_qty,
        "is_resolved": is_complete,
        "planner_status": planner_status,
        "popped_block_ids": popped_block_ids,
        "updated_op_seq_ids": updated_op_seq_ids,
    }


_OVERLAY_COLUMN_CACHE = None


def _overlay_column_flags(con):
    """Detect overlay columns without DDL (safe on hot read paths)."""
    global _OVERLAY_COLUMN_CACHE
    if _OVERLAY_COLUMN_CACHE is not None:
        return _OVERLAY_COLUMN_CACHE
    flags = {"coway": False, "remarks": False, "material_in": False, "material_in_date": False}
    def _load_flags():
        for row in rows(
            con.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'planner_process_sheet'
                  AND column_name IN (
                      'coway_proposed_edd', 'remarks', 'material_in', 'material_in_date'
                  )
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
            elif name == "material_in_date":
                flags["material_in_date"] = True
        return True

    planner_try_savepoint(con, "overlay_column_flags", _load_flags)
    _OVERLAY_COLUMN_CACHE = flags
    return flags


def _ensure_planner_overlay_columns(con):
    """Apply overlay DDL only when a write path needs a missing column."""
    flags = _overlay_column_flags(con)
    if flags["coway"] and flags["remarks"] and flags["material_in"] and flags["material_in_date"]:
        return flags
    global _OVERLAY_COLUMN_CACHE
    def _ensure():
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
        if not flags["material_in_date"]:
            con.execute(
                """
                ALTER TABLE planner_process_sheet
                ADD COLUMN IF NOT EXISTS material_in_date DATE
                """
            )
            flags["material_in_date"] = True
        return True

    planner_try_savepoint(con, "ensure_planner_overlay_columns", _ensure)
    _OVERLAY_COLUMN_CACHE = dict(flags)
    return _OVERLAY_COLUMN_CACHE


def _ensure_coway_proposed_edd_column(con):
    _ensure_planner_overlay_columns(con)


def _hosted_sr_child_donor_cache_row(con, hosted_ps_id, pp_partial_no=1, donor_ps_id=""):
    """ERP cache row for a hosted SR child such as N26-[SR]22-12 (donor NPS26-0321-12)."""
    from planning.assembly_classify import (
        hosted_sr_child_donor_guesses,
        is_component_child_ps,
        is_sr_process_sheet,
        parent_ps_id_from_child,
    )

    hosted = compact_text(hosted_ps_id).split("::")[0]
    guesses: list[str] = []
    hint = compact_text(donor_ps_id).split("::")[0]
    if hint:
        guesses.append(hint)
    parent = parent_ps_id_from_child(hosted) if is_component_child_ps(hosted) else ""
    if parent and is_sr_process_sheet(parent):
        parent_row = _voucher_partial_row(con, parent, pp_partial_no)
        if not parent_row:
            found = _voucher_rows_for_source_ps(con, parent)
            parent_row = found[0] if found else None
        part = compact_text((parent_row or {}).get("part_no")).upper()
        related_ids = []
        if part:
            related_ids = [
                compact_text(row["ps_id"])
                for row in rows(
                    con.execute(
                        """
                        SELECT ps_id
                        FROM pp_vouchers_cache
                        WHERE UPPER(part_no) = %s
                        GROUP BY ps_id
                        """,
                        (part,),
                    )
                )
            ]
        for guess in hosted_sr_child_donor_guesses(hosted, related_ids):
            if guess not in guesses:
                guesses.append(guess)
    for donor in guesses:
        cache_row = _voucher_partial_row(con, donor, pp_partial_no)
        if cache_row:
            return donor, cache_row
        found = _voucher_rows_for_source_ps(con, donor, pp_partial_no)
        if found:
            return donor, found[0]
    return "", None


def ensure_planner_process_sheet(con, planner_ps_id, donor_ps_id=None):
    """Ensure a planner_process_sheet row exists for an ERP-sourced ps id.

    The trial catalog sidebar reads pp_vouchers_cache directly; scheduling writes
    planner_planning_card rows that FK to planner_process_sheet. Materialize on demand.

    Hosted SR children (``N26-[SR]22-12``) are not ERP vouchers; ``donor_ps_id``
    (or the matching NPS/APS COMP sheet) supplies the cache row while the hosted
    id stays on planner_process_sheet.
    """
    planner_ps_id = compact_text(planner_ps_id)
    if not planner_ps_id:
        return None

    source_ps_id, pp_partial_no = parse_planner_ps_id(planner_ps_id)
    source_ps_id = normalize_standard_ps_id(source_ps_id)
    requested_source = source_ps_id
    requested_partial = pp_partial_no
    if is_temp_planner_ps_id(source_ps_id):
        planner_ps_id = source_ps_id
    else:
        planner_ps_id = format_planner_ps_id(source_ps_id, pp_partial_no)

    existing = one(
        con.execute(
            """
            SELECT * FROM planner_process_sheet
            WHERE UPPER(planner_ps_id) = UPPER(%s)
            LIMIT 1
            """,
            (planner_ps_id,),
        )
    )
    if existing:
        return existing

    if is_temp_planner_ps_id(planner_ps_id):
        raise ValueError(
            f"Process sheet {planner_ps_id} was not found. Create the [Temp] PS first."
        )

    cache_row = _voucher_partial_row(con, source_ps_id, pp_partial_no)
    if not cache_row:
        partial_rows = _voucher_rows_for_source_ps(con, source_ps_id, pp_partial_no)
        if partial_rows:
            cache_row = partial_rows[0]
        elif pp_partial_no != 1:
            partial_rows = _voucher_rows_for_source_ps(con, source_ps_id, 1)
            if partial_rows:
                cache_row = partial_rows[0]
    if not cache_row:
        staging_row = _mfg_process_sheet_staging_row(con, source_ps_id)
        if staging_row:
            cache_row = dict(staging_row)
    if not cache_row and source_ps_id != planner_ps_id:
        cache_row = _voucher_partial_row(con, planner_ps_id, 1)

    used_donor_cache = False
    if not cache_row:
        _donor_id, donor_row = _hosted_sr_child_donor_cache_row(
            con, requested_source, requested_partial, donor_ps_id
        )
        if donor_row:
            cache_row = donor_row
            used_donor_cache = True

    if cache_row and not used_donor_cache:
        source_ps_id = normalize_standard_ps_id(compact_text(cache_row.get("ps_id"))) or source_ps_id
        pp_partial_no = int(cache_row.get("pp_partial_no") or pp_partial_no or 1)
        planner_ps_id = format_planner_ps_id(source_ps_id, pp_partial_no)
    elif cache_row and used_donor_cache:
        source_ps_id = requested_source
        pp_partial_no = requested_partial
        planner_ps_id = format_planner_ps_id(requested_source, requested_partial)

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

    planned_qty = _to_float(
        cache_row.get("partial_qty") or cache_row.get("total_qty") or cache_row.get("display_qty")
    )

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
            """
            SELECT * FROM planner_process_sheet
            WHERE UPPER(planner_ps_id) = UPPER(%s)
            LIMIT 1
            """,
            (planner_ps_id,),
        )
    )


def _set_process_sheet_read_timeouts(con):
    """Fail fast on Process Sheets list reads instead of waiting out a sync lock."""
    timeout_ms = int(os.getenv("PS_BOARD_STATEMENT_TIMEOUT_MS", "45000"))
    lock_ms = int(os.getenv("PS_BOARD_LOCK_TIMEOUT_MS", "8000"))
    try:
        con.execute(f"SET LOCAL statement_timeout = '{timeout_ms}'")
        con.execute(f"SET LOCAL lock_timeout = '{lock_ms}'")
    except Exception:
        pass


def _flow_steps_sql(*, merge_wo: bool | None = None) -> str:
    """BOM flow steps for specific planner_ps_ids.

    Default list SQL does not join ``pp_vouchers_cache`` per operation — ERP qty
    is overlaid in Python from ``_erp_cache_steps_batch``. Do not use the unscoped
    ``ERP_STAGE_OUTPUTS_CTE`` here. Set ``PS_SELECT_MERGE_WO=1`` to restore the
    per-step LATERAL join (also keyed to the current PS, not a full WO scan).
    """
    if merge_wo is None:
        merge_wo = _ps_select_merge_wo_enabled()
    if not merge_wo:
        return """
            SELECT ps.planner_ps_id AS ps_id,
                   pfs.op_seq_id, pfs.seq_no, pfs.op_no, pfs.op_type,
                   pfs.machine_category, pfs.preferred_machine,
                   pfs.cycle_time, pfs.setup_time, pfs.is_last_op,
                   pfs.source_kind, pfs.source_stage_no,
                   0 AS erp_required_qty,
                   0 AS erp_finished_qty,
                   0 AS erp_reject_qty,
                   '' AS erp_execution_status
            FROM planner_process_sheet ps
            JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id = ANY(%s)
            ORDER BY ps.planner_ps_id, pfs.seq_no, pfs.op_seq_id
        """
    return """
            SELECT ps.planner_ps_id AS ps_id,
                   pfs.op_seq_id, pfs.seq_no, pfs.op_no, pfs.op_type,
                   pfs.machine_category, pfs.preferred_machine,
                   pfs.cycle_time, pfs.setup_time, pfs.is_last_op,
                   pfs.source_kind, pfs.source_stage_no,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%' THEN 0
                        ELSE COALESCE(so.wo_qty_required, 0) END AS erp_required_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%' THEN 0
                        ELSE COALESCE(so.wo_qty_produced, 0) END AS erp_finished_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%' THEN 0
                        ELSE COALESCE(so.wo_qty_rejected, 0) END AS erp_reject_qty,
                   CASE WHEN ps.planner_ps_id LIKE '[Temp]%%' THEN ''
                        ELSE COALESCE(so.execution_status, '') END AS erp_execution_status
            FROM planner_process_sheet ps
            JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
            LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
            LEFT JOIN LATERAL (
                SELECT
                    MAX(COALESCE(ws.wo_qty_required, c.wo_qty_required)) AS wo_qty_required,
                    MAX(COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced)) AS wo_qty_produced,
                    MAX(COALESCE(ws.total_rej_qty_produced, c.wo_qty_rejected)) AS wo_qty_rejected,
                    MAX(COALESCE(NULLIF(TRIM(ws.execution_status), ''), c.execution_status)) AS execution_status
                FROM pp_vouchers_cache c
                LEFT JOIN mfg_wo_status ws
                       ON ws.source_mps_no = c.ps_id
                      AND ws.pp_partial_no = c.pp_partial_no
                      AND ws.stage_no = c.stage_no
                      AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
                WHERE c.ps_id = ps.source_ps_id
                  AND c.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
                  AND c.stage_no = pfs.source_stage_no
                  AND c.stage_no IS NOT NULL
            ) so ON TRUE
            WHERE ps.planner_ps_id = ANY(%s)
            ORDER BY ps.planner_ps_id, pfs.seq_no, pfs.op_seq_id
    """


def _flow_steps_for_ps_ids(con, ps_ids):
    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}
    result = {}
    for row in rows(
        con.execute(
            _flow_steps_sql(),
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
                    "stage_desc": stage_desc,
                    "machine_category": "",
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
                "stage_desc": stage_desc,
                "machine_category": "",
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


def _normalize_manufacturing_step(step):
    """Align op type labels with ERP stage_desc (e.g. Turning 20 -> Turning)."""
    from planning.erp_wo_merge import is_finishing_stage_desc

    row = dict(step or {})
    stage_desc = compact_text(row.get("stage_desc") or "")
    op_type = compact_text(row.get("op_type") or "")
    if is_finishing_stage_desc(stage_desc):
        row["op_type"] = stage_desc
        row["stage_desc"] = stage_desc
        row["machine_category"] = compact_text(row.get("machine_category") or "FINISHING")
        row["source_kind"] = compact_text(row.get("source_kind") or "ERP_WO")
        return row
    if stage_desc and not op_type:
        op_type = stage_desc.split()[0]
    elif stage_desc:
        base = stage_desc.split()[0]
        if op_type and op_type.upper().startswith(base.upper()) and op_type != base:
            op_type = base
    elif op_type and " " in op_type:
        op_type = op_type.split()[0]
    if not stage_desc and op_type:
        stage_desc = op_type
    row["op_type"] = op_type
    row["stage_desc"] = stage_desc or op_type
    return row


def _erp_cache_steps_for_partial(con, ps, erp_steps_cache=None):
    source_ps_id, pp_partial_no = _display_ids(ps)
    planner_ps_id = compact_text(ps.get("ps_id") or ps.get("planner_ps_id"))
    try:
        partial_int = _temp_source_partial_no(con, planner_ps_id, pp_partial_no)
    except (TypeError, ValueError):
        partial_int = 1
    cache_key = (compact_text(source_ps_id), partial_int)
    if erp_steps_cache is not None:
        return list(erp_steps_cache.get(cache_key) or [])
    return _erp_cache_steps_for_ps(con, source_ps_id, pp_partial_no)


def _merge_erp_metadata_into_flow_steps(flow_steps, erp_steps):
    if not flow_steps:
        return []
    erp_by_op = {
        compact_text(step.get("op_no")): step
        for step in (erp_steps or [])
        if compact_text(step.get("op_no"))
    }
    erp_by_stage = {
        int(step.get("source_stage_no") or 0): step
        for step in (erp_steps or [])
        if int(step.get("source_stage_no") or 0)
    }
    merged = []
    for step in flow_steps:
        row = dict(step)
        erp = erp_by_op.get(compact_text(row.get("op_no"))) or erp_by_stage.get(
            int(row.get("source_stage_no") or 0)
        )
        if erp:
            if compact_text(erp.get("stage_desc")):
                row["stage_desc"] = compact_text(erp.get("stage_desc"))
            for field in (
                "erp_execution_status",
                "erp_required_qty",
                "erp_finished_qty",
                "erp_reject_qty",
            ):
                if row.get(field) in (None, "", 0) and erp.get(field) not in (None, ""):
                    row[field] = erp.get(field)
        merged.append(_normalize_manufacturing_step(row))
    return merged


def _resolve_process_sheet_steps(con, ps, flow_steps, erp_steps_cache=None):
    planner_ps_id = compact_text(ps.get("ps_id") or ps.get("planner_ps_id"))
    is_temp = is_temp_planner_ps_id(planner_ps_id)
    if is_temp:
        if flow_steps:
            return [_normalize_manufacturing_step(step) for step in flow_steps]
        return [_normalize_manufacturing_step(step) for step in _scheduled_ops_as_steps(con, planner_ps_id)]
    erp_steps = _erp_cache_steps_for_partial(con, ps, erp_steps_cache)
    if flow_steps:
        return _merge_erp_metadata_into_flow_steps(flow_steps, erp_steps)
    if erp_steps:
        return [_normalize_manufacturing_step(step) for step in erp_steps]
    return [_normalize_manufacturing_step(step) for step in _scheduled_ops_as_steps(con, planner_ps_id)]


def _prepare_process_sheet_steps(con, ps, flow_steps, erp_steps_cache=None, wo_stages_cache=None):
    """Resolve BOM machining steps and append post-machining WO stages from mfg_wo_status."""
    from planning.erp_wo_merge import (
        filter_wo_stages_for_main_partial,
        mfg_wo_stages_batch,
        merge_finishing_steps_into_flow_steps,
    )

    steps = _resolve_process_sheet_steps(con, ps, flow_steps, erp_steps_cache)
    source_ps_id, pp_partial_no = _display_ids(ps)
    is_temp = is_temp_planner_ps_id(ps.get("ps_id") or ps.get("planner_ps_id"))
    try:
        partial_int = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        partial_int = 1
    cache_key = (compact_text(source_ps_id), partial_int)
    if is_temp:
        wo_stages = []
    else:
        if wo_stages_cache is None:
            wo_stages_cache = mfg_wo_stages_batch(con, [cache_key] if cache_key[0] else [])
        wo_stages = list(wo_stages_cache.get(cache_key, []))
        main_qty = _to_float(ps.get("partial_qty") or ps.get("planned_qty") or ps.get("total_qty"))
        wo_stages = filter_wo_stages_for_main_partial(wo_stages, main_qty)
    steps = merge_finishing_steps_into_flow_steps(steps, wo_stages)
    steps = [_normalize_manufacturing_step(step) for step in steps]
    return steps, wo_stages


def _block_metrics_for_ps_ids(con, ps_ids):
    ps_ids = [compact_text(x) for x in ps_ids if compact_text(x)]
    if not ps_ids:
        return {}, {}
    source_ids = set()
    for ps_id in ps_ids:
        source_ps_id, _, _ = _planner_ps_identity(ps_id)
        source_ids.add(source_ps_id)
        source_ids.add(ps_id)
    source_id_list = list(source_ids)
    metrics = {ps_id: {"by_op": {}, "machines": set(), "queued_machine_map": {},
                       "planned_qty_total": 0.0, "finished_qty_total": 0.0,
                       "reject_qty_total": 0.0, "expected_start": "", "expected_end": ""}
               for ps_id in ps_ids}
    block_rows = {ps_id: [] for ps_id in ps_ids}
    for row in rows(
        con.execute(
            """
            WITH matching_blocks AS (
                SELECT b.block_id
                FROM planner_operation o
                JOIN planner_run_block b ON b.operation_id = o.operation_id
                WHERE o.source_ps_id = ANY(%s)
                  AND b.active = TRUE
                  AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
            ),
            actual_by_block AS (
                SELECT
                    a.block_id,
                    COALESCE(SUM(COALESCE(a.output_qty, 0)), 0) AS output_qty,
                    COALESCE(SUM(COALESCE(a.reject_qty, 0)), 0) AS reject_qty,
                    COALESCE(SUM(COALESCE(a.output_qty, 0) - COALESCE(a.reject_qty, 0)), 0) AS good_qty,
                    COUNT(a.actual_id) AS actual_report_count
                FROM planner_production_actual a
                JOIN matching_blocks mb ON mb.block_id = a.block_id
                WHERE COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
                GROUP BY a.block_id
            ),
            segment_bounds AS (
                SELECT
                    s.block_id,
                    MIN(CASE WHEN s.segment_type = 'production' THEN s.start_datetime END) AS expected_start,
                    MAX(CASE WHEN s.segment_type = 'production' THEN s.end_datetime END) AS expected_end
                FROM planner_run_block_segment s
                JOIN matching_blocks mb ON mb.block_id = s.block_id
                GROUP BY s.block_id
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
            (source_id_list, source_id_list),
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


def _op_has_wo_evidence(op):
    required = _to_float(op.get("required_qty") or op.get("wo_qty_required"))
    finished = _to_float(op.get("finished_qty") or op.get("wo_qty_produced") or op.get("erp_finished_qty"))
    status = compact_text(op.get("execution_status") or op.get("erp_execution_status"))
    return required > 0.0001 or finished > 0.0001 or bool(status)


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


def _process_sheet_payload(ps, steps, metrics, material_status, manual_by_op_seq=None, wo_stages=None):
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
        tracked_ops = [op for op in ops if _op_has_wo_evidence(op)]
        execution_completed = bool(tracked_ops) and all(
            op_production_complete(op) for op in tracked_ops
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
    display_ps_id, pp_partial_no = _display_ids(ps)
    if is_temp_planner_ps_id(ps.get("ps_id") or ps.get("planner_ps_id")):
        display_ps_id = temp_planner_ps_display_label(ps.get("ps_id") or ps.get("planner_ps_id"))
    queued_machines = list(metrics.get("queued_machines") or [])
    queued_machine_details = list(metrics.get("queued_machine_details") or [])
    is_queued = bool(queued_machines) or raw_planned_qty > 0
    from planning.erp_wo_merge import wo_stages_all_complete

    erp_all_wo_complete = wo_stages_all_complete(wo_stages) if wo_stages else bool(
        ps.get("erp_all_wo_complete")
    )
    pending_do = pending_delivery_order(
        {
            "ops": ops,
            "so_det_qty": _to_float(ps.get("so_det_qty")) if ps.get("so_det_qty") is not None else None,
            "qty_shipped": qty_shipped,
            "shipped_completed": shipped_completed,
            "execution_completed": execution_completed,
            "erp_all_wo_complete": erp_all_wo_complete,
            "current_stage_status": compact_text(ps.get("current_stage_status") or ""),
            "execution_status": compact_text(ps.get("execution_status") or ""),
        }
    )
    is_completed = shipped_completed or (erp_all_wo_complete and not pending_do)
    payload = {
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
        "pending_do": pending_do,
        "erp_all_wo_complete": erp_all_wo_complete,
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
        "current_stage_no": 0 if is_temp else int(ps.get("current_stage_no") or 0),
        "current_stage_desc": "" if is_temp else compact_text(ps.get("current_stage_desc") or ""),
        "current_stage_status": "" if is_temp else compact_text(ps.get("current_stage_status") or ""),
        "ops": ops,
    }
    if not is_temp and wo_stages and not payload["current_stage_desc"]:
        from planning.erp_wo_merge import resolve_current_stage_from_wo_stages

        resolved = resolve_current_stage_from_wo_stages(
            wo_stages,
            shipped_completed=bool(payload.get("shipped_completed")),
        )
        if resolved:
            payload["current_stage_no"] = int(resolved.get("current_stage_no") or 0)
            payload["current_stage_desc"] = compact_text(resolved.get("current_stage_desc") or "")
            payload["current_stage_status"] = compact_text(resolved.get("current_stage_status") or "")
    if not payload.get("pending_do"):
        payload["pending_do"] = pending_delivery_order(payload)
    if payload["pending_do"]:
        payload["is_completed"] = bool(payload.get("shipped_completed"))
    return payload


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
        "stage_desc": compact_text(step.get("stage_desc") or step.get("op_type") or ""),
        "machine_category": step.get("machine_category") or "",
        "preferred_machine": step.get("preferred_machine") or "",
        "cycle_time": _to_float(step.get("cycle_time")),
        "setup_time": _to_float(step.get("setup_time")),
        "is_last_op": int(bool(step.get("is_last_op"))),
        "stage_no": int(step.get("source_stage_no") or 0),
        "source_kind": compact_text(step.get("source_kind") or ""),
        "needs_manual_produced": bool(step.get("needs_manual_produced")),
        "execution_status": sanitize_erp_execution_status(
            compact_text(step.get("erp_execution_status") or ""),
            required=wo_req_qty,
            finished=finished_qty,
            remaining=wo_remaining,
        ),
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


def _reconcile_partial_shipped_status(rows, *, tol=0.0001):
    """Allocate SO shipped qty across partials in order; recompute shipped_completed/is_completed."""
    if not rows:
        return
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
        so_qty = next((item.get("so_det_qty") for item in source_rows if item.get("so_det_qty") is not None), None)
        so_shipped_complete = so_qty is not None and shipped_quantity_completed(so_qty, shipped_total)

        for item in source_rows:
            req_qty = max(0.0, _to_float(item.get("display_qty") or item.get("wo_req_qty") or item.get("partial_qty")))
            ops = item.get("ops") or []
            tracked_ops = [op for op in ops if _op_has_wo_evidence(op)]
            if tracked_ops:
                production_done = all(op_production_complete(op) for op in tracked_ops)
            else:
                production_done = bool(item.get("production_completed")) or bool(item.get("execution_completed"))
            has_partial_erp_evidence = bool(
                compact_text(item.get("current_stage_status"))
                or any(
                    compact_text(op.get("execution_status") or op.get("erp_execution_status"))
                    for op in (item.get("ops") or [])
                )
            )
            covered_qty = min(req_qty, shipped_left) if req_qty > tol else 0.0
            sequential_shipped = (
                has_partial_erp_evidence
                and production_done
                and req_qty > tol
                and covered_qty >= (req_qty - tol)
            )
            shipped_left = max(0.0, shipped_left - covered_qty)
            item["shipped_completed"] = sequential_shipped or so_shipped_complete

            if sequential_shipped and req_qty > tol:
                item["finished_qty"] = max(_to_float(item.get("finished_qty")), req_qty)
                item["remaining_qty"] = 0.0
                for op in item.get("ops") or []:
                    op_req = _to_float(op.get("wo_qty_required") or op.get("required_qty") or req_qty)
                    if _to_float(op.get("finished_qty")) <= 0:
                        op["finished_qty"] = min(op_req, req_qty)
                    op["remaining_qty"] = max(0.0, op_req - _to_float(op.get("finished_qty")))

            erp_all_wo_complete = bool(item.get("erp_all_wo_complete"))
            pending_do = pending_delivery_order(item)
            if pending_do:
                item["is_completed"] = bool(item.get("shipped_completed"))
            else:
                item["is_completed"] = bool(item.get("shipped_completed")) or erp_all_wo_complete


def _apply_partial_shipped_rollup(rows):
    """Backward-compatible alias — reconcile before open/closed filtering."""
    _reconcile_partial_shipped_status(rows)


def _ps_select_merge_wo_enabled() -> bool:
    """Live mfg_wo_status join in list SQL. Off by default — cache already has WO fields."""
    return os.getenv("PS_SELECT_MERGE_WO", "").strip().lower() in {"1", "true", "yes", "on"}


def _ps_select_sql(con=None, *, merge_wo: bool | None = None):
    """Planner process-sheet list SQL.

    Aggregates ``pp_vouchers_cache`` only for planner-linked PS ids (index-friendly)
    instead of grouping the whole cache. Live ``mfg_wo_status`` join is off by
    default — that scan of ~50k+ WO rows routinely exceeds Supabase's 2‑minute
    statement timeout under load and freezes Process Sheets. Board/detail paths
    still merge WO stages via ``mfg_wo_stages_batch``. Set ``PS_SELECT_MERGE_WO=1``
    to force the old live join.
    """
    from planning.erp_wo_merge import ERP_STAGE_OUTPUTS_CTE

    if merge_wo is None:
        merge_wo = _ps_select_merge_wo_enabled()

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

    planner_keys_cte = """
    planner_keys AS (
        SELECT DISTINCT
            ps.source_ps_id AS ps_id,
            COALESCE(tps.source_pp_partial_no, ps.pp_partial_no, 1) AS pp_partial_no
        FROM planner_process_sheet ps
        LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
        WHERE NULLIF(TRIM(COALESCE(ps.source_ps_id, '')), '') IS NOT NULL
    )
"""

    if merge_wo:
        voucher_partials_cte = f"""
    WITH {ERP_STAGE_OUTPUTS_CTE},
    {planner_keys_cte},
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
        JOIN planner_keys k
          ON k.ps_id = c.ps_id
         AND k.pp_partial_no = COALESCE(c.pp_partial_no, 1)
        LEFT JOIN erp_stage_outputs e
               ON e.ps_id = c.ps_id
              AND e.pp_partial_no = c.pp_partial_no
              AND e.stage_no = c.stage_no
        GROUP BY c.ps_id, c.pp_partial_no
    )
"""
    else:
        voucher_partials_cte = f"""
    WITH {planner_keys_cte},
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
            MAX(c.execution_status) AS execution_status,
            MAX(c.total_qty) AS total_qty,
            MAX(c.partial_qty) AS partial_qty,
            MAX(c.wo_qty_required) AS wo_qty_required,
            MAX(c.wo_qty_produced) AS wo_qty_produced,
            MAX(c.wo_qty_rejected) AS wo_qty_rejected,
            MAX(c.source_voucher_no) AS source_voucher_no,
            MAX(c.qty_shipped) AS qty_shipped,
            MAX(c.so_det_qty) AS so_det_qty,
            MAX(c.current_stage_no) AS current_stage_no,
            MAX(c.current_stage_desc) AS current_stage_desc,
            MAX(c.current_stage_status) AS current_stage_status,
            COALESCE(
                BOOL_AND(
                    CASE
                        WHEN NULLIF(TRIM(COALESCE(c.execution_status, '')), '') IS NULL THEN NULL
                        ELSE UPPER(REPLACE(REPLACE(COALESCE(c.execution_status, ''), '-', '_'), ' ', '_')) IN ('C', 'COMPLETED')
                    END
                ),
                FALSE
            ) AS execution_completed
        FROM pp_vouchers_cache c
        JOIN planner_keys k
          ON k.ps_id = c.ps_id
         AND k.pp_partial_no = COALESCE(c.pp_partial_no, 1)
        GROUP BY c.ps_id, c.pp_partial_no
    )
"""

    return f"""
    {voucher_partials_cte}
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


def _ps_select_search_clause(search):
    """Narrow planner_process_sheet rows for board / bulk-lookup search.

    Comma-separated process sheet numbers use ``= ANY`` instead of one LIKE of
    the whole pasted list (which matched nothing and forced a full-board scan).
    """
    terms = split_process_sheet_search_terms(search)
    if not terms:
        return "", []

    exact_bases = []
    exact_partials = []
    like_terms = []
    seen_bases = set()
    seen_partials = set()
    for term in terms:
        base_term, partial_no = parse_bulk_lookup_ps_term(term)
        if not base_term:
            continue
        if is_ps_base_id(base_term) and partial_no is not None:
            key = (base_term.upper(), int(partial_no))
            if key not in seen_partials:
                seen_partials.add(key)
                exact_partials.append(key)
        elif is_ps_base_id(base_term):
            key = base_term.upper()
            if key not in seen_bases:
                seen_bases.add(key)
                exact_bases.append(key)
        else:
            like_terms.append(term)

    clauses = []
    params = []
    if exact_bases:
        clauses.append("UPPER(COALESCE(ps.source_ps_id, '')) = ANY(%s)")
        params.append(exact_bases)
        clauses.append("UPPER(COALESCE(ps.planner_ps_id, '')) = ANY(%s)")
        params.append(exact_bases)
    if exact_partials:
        values_sql = ", ".join(["(UPPER(%s), %s)"] * len(exact_partials))
        clauses.append(
            f"(UPPER(COALESCE(ps.source_ps_id, '')), COALESCE(ps.pp_partial_no, 1)) IN ({values_sql})"
        )
        for base, partial in exact_partials:
            params.extend([base, partial])
    for term in like_terms:
        pattern = f"%{term}%"
        clauses.append(
            """(
                UPPER(COALESCE(ps.source_ps_id, '')) LIKE UPPER(%s)
                OR UPPER(COALESCE(ps.planner_ps_id, '')) LIKE UPPER(%s)
                OR UPPER(COALESCE(v.part_no, '')) LIKE UPPER(%s)
                OR UPPER(COALESCE(v.description, '')) LIKE UPPER(%s)
                OR CAST(COALESCE(ps.pp_partial_no, 1) AS TEXT) LIKE %s
            )"""
        )
        params.extend([pattern, pattern, pattern, pattern, pattern])
    if not clauses:
        return "", []
    return " WHERE (" + " OR ".join(clauses) + ")", params


def _board_item_search_haystack(item):
    return " ".join(
        compact_text(item.get(key)).lower()
        for key in (
            "ps_id",
            "source_ps_id",
            "display_ps_id",
            "pp_partial_no",
            "part_name",
            "part_no",
            "part_desc",
            "inventory_code",
            "remarks",
            "current_stage_desc",
        )
    )


def board_item_matches_search(item, search):
    needle = compact_text(search).lower()
    if not needle:
        return True
    base_term, partial_no = parse_bulk_lookup_ps_term(needle)
    source = compact_text(
        item.get("source_ps_id") or item.get("display_ps_id") or item.get("ps_id") or ""
    ).split("::")[0].lower()
    try:
        entry_partial = int(item.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        entry_partial = 1
    ps_id = compact_text(item.get("ps_id") or "")
    if not item.get("pp_partial_no") and "::" in ps_id:
        try:
            entry_partial = int(ps_id.rsplit("::", 1)[1])
        except ValueError:
            pass
    if partial_no is not None and is_ps_base_id(base_term):
        return source == base_term.lower() and entry_partial == partial_no
    if needle in _board_item_search_haystack(item):
        return True
    if is_ps_base_id(base_term) and source == base_term.lower():
        return True
    return False


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
                   BOOL_AND(
                       COALESCE(execution_status, '') = 'C'
                       AND (
                           COALESCE(wo_qty_required, 0) <= 0.0001
                           OR COALESCE(total_acc_qty_produced, 0)
                              >= COALESCE(wo_qty_required, 0) - 0.0001
                       )
                   ) AS all_complete,
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


def _payload_filter_arg(name, explicit, *, default="", bool_values=False):
    if explicit is not None:
        if bool_values:
            return bool(explicit)
        return compact_text(explicit)
    if has_request_context():
        raw = request.args.get(name)
        if bool_values:
            return compact_text(raw).lower() in {"1", "true", "yes", "on"}
        return compact_text(raw or default)
    return default if not bool_values else False


def list_process_sheets_payload(
    con,
    *,
    search=None,
    status_filter=None,
    planner_filter=None,
    show_completed=None,
    overdue_only=None,
):
    _set_process_sheet_read_timeouts(con)
    _overlay_column_flags(con)
    search = _payload_filter_arg("search", search).lower()
    status_filter = _payload_filter_arg("status", status_filter).upper()
    planner_filter = _payload_filter_arg("planner_status", planner_filter).upper()
    show_completed = _payload_filter_arg("show_completed", show_completed, bool_values=True)
    overdue_only = _payload_filter_arg("overdue_only", overdue_only, bool_values=True)
    search_terms = split_process_sheet_search_terms(search)

    search_clause, search_params = _ps_select_search_clause(search)
    ps_rows = [
        dict(row)
        for row in rows(
            con.execute(
                _ps_select(con)
                + search_clause
                + " ORDER BY COALESCE(v.due_date::TEXT, ''), ps.planner_ps_id",
                tuple(search_params),
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
    temp_registry_by_ps = _temp_registry_by_ps_ids(con, ps_ids)

    erp_step_keys = []
    erp_step_seen = set()
    for ps in ps_rows:
        if is_temp_planner_ps_id(compact_text(ps.get("ps_id"))):
            continue
        source_ps_id, pp_partial_no = _display_ids(ps)
        try:
            partial_int = int(pp_partial_no or 1)
        except (TypeError, ValueError):
            partial_int = 1
        key = (compact_text(source_ps_id), partial_int)
        if key[0] and key not in erp_step_seen:
            erp_step_keys.append(key)
            erp_step_seen.add(key)
    erp_steps_cache = _erp_cache_steps_batch(con, erp_step_keys)
    from planning.erp_wo_merge import mfg_wo_stages_batch, wo_stages_all_complete

    wo_stage_keys = []
    wo_stage_seen = set()
    for ps in ps_rows:
        source_ps_id, pp_partial_no = _display_ids(ps)
        try:
            partial_int = int(pp_partial_no or 1)
        except (TypeError, ValueError):
            partial_int = 1
        key = (compact_text(source_ps_id), partial_int)
        if key[0] and key not in wo_stage_seen:
            wo_stage_keys.append(key)
            wo_stage_seen.add(key)
    wo_stages_cache = mfg_wo_stages_batch(con, wo_stage_keys)
    wo_complete_by_partial = {
        key: wo_stages_all_complete(stages) for key, stages in wo_stages_cache.items()
    }

    candidates = []
    today = date.today().isoformat()
    for ps in ps_rows:
        ps_id = compact_text(ps["ps_id"])
        steps, wo_stages = _prepare_process_sheet_steps(
            con,
            ps,
            steps_by_ps.get(ps_id, []),
            erp_steps_cache,
            wo_stages_cache,
        )
        payload = _process_sheet_payload(
            ps,
            steps,
            metrics_by_ps.get(ps_id, {}),
            material_status_by_ps.get(ps_id, {}),
            manual_qty_by_ps.get(ps_id, {}),
            wo_stages=wo_stages,
        )
        if is_temp_planner_ps_id(ps_id):
            if not int(ps.get("selected_bom_id") or 0):
                try:
                    repaired_bom_id = _repair_temp_ps_bom_if_missing(con, ps_id)
                    if repaired_bom_id:
                        ps["selected_bom_id"] = repaired_bom_id
                        steps, wo_stages = _prepare_process_sheet_steps(
                            con,
                            ps,
                            _flow_steps_for_ps_ids(con, [ps_id]).get(ps_id, []),
                            erp_steps_cache,
                            wo_stages_cache,
                        )
                        payload = _process_sheet_payload(
                            ps,
                            steps,
                            metrics_by_ps.get(ps_id, {}),
                            material_status_by_ps.get(ps_id, {}),
                            manual_qty_by_ps.get(ps_id, {}),
                            wo_stages=wo_stages,
                        )
                except Exception:
                    pass
            temp_reg = temp_registry_by_ps.get(ps_id)
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
                _apply_temp_ps_stage_fields(payload, temp_reg)
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
        candidates.append(payload)

    _reconcile_partial_shipped_status(candidates)

    result = []
    for payload in candidates:
        if search_terms and not any(board_item_matches_search(payload, term) for term in search_terms):
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
    enrich_items_material_inventory_codes(con, result)
    return result


def _delivery_schedule_search_clause(search):
    """Filter planner rows for delivery schedule search."""
    needle = compact_text(search).lower()
    if not needle:
        return "", []
    base_term, partial_no = parse_bulk_lookup_ps_term(needle)
    if partial_no is not None and base_term:
        if is_ps_base_id(base_term):
            return (
                """
                WHERE UPPER(COALESCE(ps.source_ps_id, '')) = UPPER(%s)
                  AND COALESCE(ps.pp_partial_no, 1) = %s
                """,
                [base_term, partial_no],
            )
        partial_pattern = f"%{base_term}%"
        return (
            """
            WHERE UPPER(COALESCE(ps.source_ps_id, '')) LIKE UPPER(%s)
              AND COALESCE(ps.pp_partial_no, 1) = %s
            """,
            [partial_pattern, partial_no],
        )
    pattern = f"%{needle}%"
    return (
        """
        WHERE (
            UPPER(COALESCE(ps.source_ps_id, '')) LIKE UPPER(%s)
            OR UPPER(COALESCE(ps.planner_ps_id, '')) LIKE UPPER(%s)
        )
        """,
        [pattern, pattern],
    )


def _delivery_schedule_matches_search(item: dict, search: str) -> bool:
    needle = compact_text(search).lower()
    if not needle:
        return True
    base_term, partial_no = parse_bulk_lookup_ps_term(needle)
    if partial_no is not None and base_term:
        source = compact_text(item.get("source_ps_id")).lower()
        if is_ps_base_id(base_term):
            return source == base_term.lower() and int(item.get("pp_partial_no") or 1) == int(partial_no)
        return base_term in source and int(item.get("pp_partial_no") or 1) == int(partial_no)
    haystack = " ".join(
        str(item.get(key) or "")
        for key in (
            "source_ps_id",
            "display_ps_id",
            "ps_id",
            "part_no",
            "part_name",
            "part_desc",
        )
    ).lower()
    return needle in haystack


def _delivery_schedule_select_sql(con=None):
    """Fast delivery query — pp_vouchers_cache join (proven delivery schedule path)."""
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
    WITH voucher_partials AS (
        SELECT
            c.ps_id,
            c.pp_partial_no,
            MAX(c.part_no) AS part_no,
            MAX(c.description) AS description,
            MIN(c.due_date) AS due_date,
            MAX(c.status) AS status,
            MAX(c.execution_status) AS execution_status,
            MAX(c.total_qty) AS total_qty,
            MAX(c.partial_qty) AS partial_qty,
            MAX(c.qty_shipped) AS qty_shipped,
            MAX(c.so_det_qty) AS so_det_qty,
            MAX(c.current_stage_no) AS current_stage_no,
            MAX(c.current_stage_desc) AS current_stage_desc,
            MAX(c.current_stage_status) AS current_stage_status,
            COALESCE(
                BOOL_AND(
                    CASE
                        WHEN NULLIF(TRIM(COALESCE(c.execution_status, '')), '') IS NULL THEN NULL
                        ELSE UPPER(REPLACE(REPLACE(c.execution_status, '-', '_'), ' ', '_')) IN ('C', 'COMPLETED')
                    END
                ),
                FALSE
            ) AS execution_completed
        FROM pp_vouchers_cache c
        GROUP BY c.ps_id, c.pp_partial_no
    )
    SELECT
        ps.planner_ps_id AS ps_id,
        ps.source_ps_id,
        ps.pp_partial_no,
        {coway_expr}
        {remarks_expr}
        ps.planner_status,
        tps.reject_qty AS temp_qty,
        v.part_no,
        v.part_no AS part_name,
        v.description AS part_desc,
        v.partial_qty,
        v.total_qty,
        v.so_det_qty,
        v.qty_shipped,
        v.due_date,
        v.execution_status,
        v.execution_completed,
        v.current_stage_no,
        v.current_stage_desc,
        v.current_stage_status
    FROM planner_process_sheet ps
    LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
    LEFT JOIN voucher_partials v
           ON v.ps_id = ps.source_ps_id
          AND v.pp_partial_no = COALESCE(tps.source_pp_partial_no, ps.pp_partial_no)
    """


def _delivery_schedule_row_from_ps_row(ps_row):
    """Lightweight delivery row from planner_process_sheet + voucher join (no flow/metrics)."""
    ps_id = compact_text(ps_row.get("ps_id"))
    source, partial_raw = _display_ids(ps_row)
    try:
        partial_no = int(partial_raw or 1)
    except (TypeError, ValueError):
        partial_no = 1
    if is_temp_planner_ps_id(ps_id):
        display_ps_id = temp_planner_ps_display_label(ps_id)
    else:
        display_ps_id = format_planner_ps_id(source, partial_no)

    partial_qty = _to_float(ps_row.get("partial_qty"))
    display_qty = partial_qty or _to_float(ps_row.get("total_qty"))
    is_temp = is_temp_planner_ps_id(ps_id)
    temp_qty = _to_float(ps_row.get("temp_qty"))
    # Temp PS carries the qty the planner stipulated (reject/rework qty), which
    # differs from the source voucher partial qty it was cloned from.
    pp_partial_qty = temp_qty if is_temp else partial_qty
    execution_completed = bool(ps_row.get("execution_completed"))
    qty_shipped = _to_float(ps_row.get("qty_shipped"))
    so_qty = _to_float(ps_row.get("so_det_qty")) if ps_row.get("so_det_qty") is not None else None
    shipped_completed = (
        execution_completed
        and display_qty > 0
        and qty_shipped >= (display_qty - 0.0001)
    ) or (so_qty is not None and shipped_quantity_completed(so_qty, qty_shipped))

    item = {
        "ps_id": ps_id,
        "source_ps_id": source,
        "pp_partial_no": partial_no,
        "display_ps_id": display_ps_id,
        "is_temp_ps": is_temp_planner_ps_id(ps_id),
        "part_no": compact_text(ps_row.get("part_no")),
        "part_name": compact_text(ps_row.get("part_no")),
        "part_desc": compact_text(ps_row.get("part_desc")),
        "due_date": compact_text(ps_row.get("due_date")),
        "coway_proposed_edd": compact_text(ps_row.get("coway_proposed_edd")),
        "remarks": compact_text(ps_row.get("remarks")),
        "current_stage_desc": compact_text(ps_row.get("current_stage_desc")),
        "current_stage_status": compact_text(ps_row.get("current_stage_status")),
        "current_stage_no": int(ps_row.get("current_stage_no") or 0),
        "execution_status": compact_text(ps_row.get("execution_status")),
        "planner_status": compact_text(ps_row.get("planner_status")),
        "so_det_qty": so_qty,
        "qty_shipped": qty_shipped,
        "partial_qty": partial_qty,
        "temp_qty": temp_qty,
        "pp_partial_qty": pp_partial_qty,
        "display_qty": display_qty,
        "wo_req_qty": display_qty,
        "execution_completed": execution_completed,
        "production_completed": execution_completed,
        "shipped_completed": shipped_completed,
        "erp_all_wo_complete": execution_completed,
        "ops": [],
        "is_queued": False,
        "queued_machines": [],
    }
    item["pending_do"] = pending_delivery_order(item)
    item["is_completed"] = bool(item.get("shipped_completed")) or (
        execution_completed and not item["pending_do"]
    )
    return item


def _delivery_schedule_source_clause(base_term):
    """All planner rows for one PS base (exact or partial PS number match)."""
    base = compact_text(base_term).lower()
    if not base:
        return "", []
    if is_ps_base_id(base):
        return (
            " WHERE UPPER(COALESCE(ps.source_ps_id, '')) = UPPER(%s) ",
            [base],
        )
    pattern = f"%{base}%"
    return (
        " WHERE UPPER(COALESCE(ps.source_ps_id, '')) LIKE UPPER(%s) ",
        [pattern],
    )


def _delivery_schedule_planner_items(con, search=""):
    needle = compact_text(search).lower()
    base_term, partial_no = parse_bulk_lookup_ps_term(needle)
    if partial_no is not None and base_term:
        search_clause, search_params = _delivery_schedule_source_clause(base_term)
    else:
        search_clause, search_params = _delivery_schedule_search_clause(search)
    ps_rows = [
        dict(row)
        for row in rows(
            con.execute(
                _delivery_schedule_select_sql(con)
                + search_clause
                + " ORDER BY COALESCE(v.due_date::TEXT, ''), ps.planner_ps_id",
                tuple(search_params),
            )
        )
    ]
    candidates = [_delivery_schedule_row_from_ps_row(row) for row in ps_rows]
    _reconcile_partial_shipped_status(candidates)
    open_items = [item for item in candidates if not item.get("is_completed")]
    if partial_no is not None and base_term:
        open_items = [
            item for item in open_items
            if int(item.get("pp_partial_no") or 1) == int(partial_no)
        ]
    return open_items


def _delivery_schedule_erp_only_partial_keys(con, search):
    """ERP open partials with no planner_process_sheet row, optionally filtered by search."""
    from planning.utils import SHIPPED_QTY_TOLERANCE

    shipped_complete = (
        "c.so_det_qty IS NOT NULL "
        f"AND COALESCE(c.qty_shipped, 0) >= c.so_det_qty - {SHIPPED_QTY_TOLERANCE}"
    )
    params: list = []
    search_sql = ""
    search_text = compact_text(search).lower()
    if search_text:
        needle = f"%{search_text}%"
        search_sql = """
          AND (
              LOWER(p.ps_id) LIKE %s
              OR LOWER(COALESCE(p.part_no, '')) LIKE %s
              OR LOWER(COALESCE(p.description, '')) LIKE %s
              OR LOWER(COALESCE(p.pp_partial_no::TEXT, '')) LIKE %s
          )
        """
        params.extend([needle, needle, needle, needle])

    sql = f"""
        WITH partials AS (
            SELECT
                c.ps_id,
                c.pp_partial_no,
                MAX(c.part_no) AS part_no,
                MAX(c.description) AS description
            FROM pp_vouchers_cache c
            WHERE NOT ({shipped_complete})
            GROUP BY c.ps_id, c.pp_partial_no
        )
        SELECT p.ps_id, p.pp_partial_no
        FROM partials p
        LEFT JOIN planner_process_sheet ps
               ON ps.source_ps_id = p.ps_id
              AND ps.pp_partial_no = p.pp_partial_no
        WHERE ps.planner_ps_id IS NULL
        {search_sql}
        ORDER BY p.ps_id, p.pp_partial_no
    """
    return [
        (compact_text(row.get("ps_id")), int(row.get("pp_partial_no") or 1))
        for row in rows(con.execute(sql, tuple(params) if params else None))
        if compact_text(row.get("ps_id"))
    ]


def _delivery_schedule_finalize_erp_entries(entries):
    if not entries:
        return []
    from app import _apply_sequential_partial_shipped, _finalize_pp_voucher_entry

    for entry in entries:
        _finalize_pp_voucher_entry(entry)
    _apply_sequential_partial_shipped(entries)
    open_entries = []
    for entry in entries:
        entry["is_completed"] = bool(entry.get("shipped_completed")) or bool(entry.get("execution_completed"))
        entry["pending_do"] = pending_delivery_order(entry)
        if not entry.get("is_completed"):
            open_entries.append(entry)
    return open_entries


def list_delivery_schedule_board_items(con, *, search="", full=False):
    """Open partial-level rows for delivery schedule (planner registrations + ERP-only partials)."""
    search = compact_text(search).lower()
    if not search and not full:
        return []

    planner_items = _delivery_schedule_planner_items(con, search)
    merged = list(planner_items)
    if not search:
        return merged

    planner_keys = {process_sheet_board_identity_key(item) for item in planner_items}
    partial_keys = [
        key
        for key in _delivery_schedule_erp_only_partial_keys(con, search)
        if process_sheet_board_identity_key(
            {
                "source_ps_id": key[0],
                "pp_partial_no": key[1],
                "ps_id": format_planner_ps_id(key[0], key[1]),
            }
        )
        not in planner_keys
    ]
    if not partial_keys:
        return merged

    # Cap ERP-only enrichment — lane catalog is heavier than planner rows.
    partial_keys = partial_keys[:25]

    from app import pp_vouchers_lane_catalog_entries

    erp_only = _delivery_schedule_finalize_erp_entries(
        pp_vouchers_lane_catalog_entries(con, partial_keys, include_completed=False)
    )
    if erp_only:
        enrich_board_planner_fields(con, erp_only)
        merged.extend(erp_only)
    return merged


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


def material_in_date_from_subcon(raw) -> str:
    """ISO date from S/O Material in / Sub-con. Empty when Arrived or free text."""
    from .anticipated_material_service import parse_material_subcon_date

    parsed = parse_material_subcon_date(raw)
    return parsed.isoformat() if parsed else ""


def _iso_date_text(value) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return compact_text(value.isoformat())[:10]
    return material_in_date_from_subcon(value)


def material_in_card_date(material_subcon=None, sheet_date=None) -> str:
    """Prefer the S/O expected date; fall back to planner_process_sheet.material_in_date."""
    return material_in_date_from_subcon(material_subcon) or _iso_date_text(sheet_date)


def material_in_overlay_for_planner_ps_ids(con, planner_ps_ids):
    """Return {planner_ps_id: {material_in, material_in_date}} for board / catalog cards."""
    flags = _overlay_column_flags(con)
    ids = [compact_text(i) for i in (planner_ps_ids or []) if compact_text(i)]
    if not ids:
        return {}
    out = {pid: {"material_in": False, "material_in_date": ""} for pid in ids}
    if not flags.get("material_in"):
        return out
    date_select = "ps.material_in_date" if flags.get("material_in_date") else "NULL::date AS material_in_date"

    def _load_joined():
        return rows(
            con.execute(
                f"""
                SELECT ps.planner_ps_id,
                       COALESCE(ps.material_in, FALSE) AS material_in,
                       {date_select},
                       COALESCE(n_src.material_subcon, n_base.material_subcon) AS material_subcon
                FROM planner_process_sheet ps
                LEFT JOIN planner_so_pp_notes n_src
                  ON n_src.pp_voucher_no = NULLIF(BTRIM(ps.source_ps_id), '')
                LEFT JOIN planner_so_pp_notes n_base
                  ON n_base.pp_voucher_no = split_part(ps.planner_ps_id, '::', 1)
                WHERE ps.planner_ps_id = ANY(%s)
                """,
                (ids,),
            )
        )

    def _load_flags_only():
        sheet_date = "material_in_date" if flags.get("material_in_date") else "NULL::date AS material_in_date"
        return rows(
            con.execute(
                f"""
                SELECT planner_ps_id,
                       COALESCE(material_in, FALSE) AS material_in,
                       {sheet_date}
                FROM planner_process_sheet
                WHERE planner_ps_id = ANY(%s)
                """,
                (ids,),
            )
        )

    query_rows = planner_try_savepoint(con, "material_in_overlay", _load_joined, default=None)
    if query_rows is None:
        query_rows = planner_try_savepoint(con, "material_in_flags", _load_flags_only, default=[])
    for row in query_rows or []:
        pid = compact_text(row.get("planner_ps_id"))
        if not pid:
            continue
        out[pid] = {
            "material_in": bool(row.get("material_in")),
            "material_in_date": material_in_card_date(
                row.get("material_subcon"),
                row.get("material_in_date"),
            ),
        }
    return out


def material_in_map_for_planner_ps_ids(con, planner_ps_ids):
    """Return {planner_ps_id: bool} for scheduler catalog material-in flags."""
    overlay = material_in_overlay_for_planner_ps_ids(con, planner_ps_ids)
    return {pid: bool(meta.get("material_in")) for pid, meta in overlay.items()}


def due_date_map_for_planner_ps_ids(con, planner_ps_ids):
    """Return {planner_ps_id: due_date ISO string} for board lite loads."""
    ids = [compact_text(i) for i in (planner_ps_ids or []) if compact_text(i)]
    if not ids:
        return {}
    out = {pid: "" for pid in ids}

    def _load_due_rows():
        return rows(
            con.execute(
                """
                SELECT ps.planner_ps_id,
                       MIN(c.due_date)::TEXT AS due_date,
                       ps.coway_proposed_edd::TEXT AS coway_proposed_edd
                FROM planner_process_sheet ps
                LEFT JOIN pp_vouchers_cache c
                       ON c.ps_id = ps.source_ps_id
                      AND c.pp_partial_no = ps.pp_partial_no
                WHERE ps.planner_ps_id = ANY(%s)
                GROUP BY ps.planner_ps_id, ps.coway_proposed_edd
                """,
                (ids,),
            )
        )

    query_rows = planner_try_savepoint(con, "due_date_map", _load_due_rows, default=None)
    if query_rows is None:
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


def _so_line_pricing_key(sales_order_no, line_item_no) -> str:
    so = compact_text(sales_order_no)
    line = compact_text(line_item_no)
    if line:
        line = re.sub(r"\.0+$", "", line)
    return f"{so}|{line}" if so and line else ""


def fetch_so_line_pricing_map(keys: list[tuple[str, str]]) -> dict[str, dict]:
    """Home-currency SO line unit cost + exchange rate keyed by sales_order_no|line_item_no."""
    from planning.sales_report_route import _EXCH_OST_SQL, _UNIT_FC_SQL, _UNIT_HOME_SQL
    from planning.staged_erp import _EXCH_STAGED, _UNIT_FC_STAGED, _UNIT_HOME_STAGED, fetch_rows

    unique: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for sales_order_no, line_item_no in keys:
        so = compact_text(sales_order_no)
        line = compact_text(line_item_no)
        if line:
            line = re.sub(r"\.0+$", "", line)
        if not so or not line:
            continue
        pair = (so, line)
        if pair in seen:
            continue
        seen.add(pair)
        unique.append(pair)
    if not unique:
        return {}

    sos = [pair[0] for pair in unique]
    lines = [pair[1] for pair in unique]
    staged_sql = f"""
    SELECT
        det.sales_order_no,
        det.line_item_no,
        {_UNIT_FC_STAGED} AS unit_cost,
        {_EXCH_STAGED} AS exch_rate,
        {_UNIT_HOME_STAGED.strip()} AS unit_cost_home
    FROM public.so_order_line det
    WHERE (det.sales_order_no, det.line_item_no) IN (
        SELECT * FROM unnest(%s::text[], %s::text[])
    )
    """
    live_sql = f"""
    SELECT
        det.sales_order_no,
        regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        {_UNIT_FC_SQL} AS unit_cost,
        {_EXCH_OST_SQL} AS exch_rate,
        {_UNIT_HOME_SQL.strip()} AS unit_cost_home
    FROM public.so_order_ost_det det
    JOIN public.so_order_ost_hdr ost ON ost.sales_order_no = det.sales_order_no
    WHERE (det.sales_order_no, regexp_replace(det.line_item_no::TEXT, '\\.0+$', ''))
        IN (SELECT * FROM unnest(%s::text[], %s::text[]))
    """
    fetched = fetch_rows(staged_sql, (sos, lines), live_sql=live_sql, domain="sales_orders")
    out: dict[str, dict] = {}
    for row in fetched:
        key = _so_line_pricing_key(row.get("sales_order_no"), row.get("line_item_no"))
        if not key:
            continue
        out[key] = {
            "unit_cost": _to_float(row.get("unit_cost")),
            "exch_rate": _to_float(row.get("exch_rate")),
            "unit_cost_home": _to_float(row.get("unit_cost_home")),
        }
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


def _update_material_in(con, ps_id, material_in, material_in_date=None):
    _ensure_planner_overlay_columns(con)
    _, _, canonical_ps_id = _planner_ps_identity(ps_id)
    try:
        ensure_planner_process_sheet(con, canonical_ps_id)
    except ValueError as exc:
        return None, str(exc)
    material_in_bool = bool(material_in)
    parsed_date = None
    date_text = compact_text(material_in_date)
    if date_text:
        from .anticipated_material_service import parse_material_subcon_date

        parsed_date = parse_material_subcon_date(date_text)
    if material_in_bool:
        con.execute(
            """
            UPDATE planner_process_sheet
            SET material_in = TRUE,
                material_in_date = COALESCE(%s, material_in_date, CURRENT_DATE),
                updated_at = NOW()
            WHERE planner_ps_id = %s
            """,
            (parsed_date, canonical_ps_id),
        )
    else:
        con.execute(
            """
            UPDATE planner_process_sheet
            SET material_in = FALSE,
                material_in_date = COALESCE(%s, material_in_date),
                updated_at = NOW()
            WHERE planner_ps_id = %s
            """,
            (parsed_date, canonical_ps_id),
        )
    row = one(
        con.execute(
            """
            SELECT material_in, material_in_date
            FROM planner_process_sheet
            WHERE planner_ps_id = %s
            """,
            (canonical_ps_id,),
        )
    )
    try:
        from app import _invalidate_pp_vouchers_with_ops_cache

        _invalidate_pp_vouchers_with_ops_cache()
    except Exception:
        pass
    material_in_date = (row or {}).get("material_in_date")
    try:
        from planning.sales_orders_route import patch_sales_orders_material_in

        patch_sales_orders_material_in(canonical_ps_id, {
            "material_in": bool((row or {}).get("material_in")),
            "material_in_date": material_in_date.isoformat() if material_in_date else None,
        })
    except Exception:
        pass
    return {
        "ps_id": canonical_ps_id,
        "material_in": bool((row or {}).get("material_in")),
        "material_in_date": material_in_date.isoformat() if material_in_date else None,
    }, None


_TOOLING_COLUMN_CACHE = None
_TOOLING_DEFAULTS_APPLIED = False


def _apply_tooling_assumed_ready_defaults(con):
    """One-time data fix. Do not call from board/catalog read paths — ALTER TABLE
    takes an exclusive lock on planner_operation and can stall planner load ~30s.
    """
    global _TOOLING_DEFAULTS_APPLIED, _TOOLING_COLUMN_CACHE
    if _TOOLING_DEFAULTS_APPLIED:
        return
    _ensure_tooling_columns(con)
    try:
        con.execute(
            """
            ALTER TABLE planner_operation
            ALTER COLUMN tooling_ready SET DEFAULT TRUE
            """
        )
        con.execute(
            """
            UPDATE planner_operation
            SET tooling_ready = TRUE,
                tooling_ready_date = NULL
            WHERE tooling_ready IS NOT TRUE
              AND tooling_ready_date IS NULL
            """
        )
    except Exception:
        pass
    _TOOLING_DEFAULTS_APPLIED = True
    _TOOLING_COLUMN_CACHE = None


def _tooling_column_flags(con):
    """Detect planner_operation tooling columns without DDL on hot read paths."""
    global _TOOLING_COLUMN_CACHE
    if _TOOLING_COLUMN_CACHE is not None:
        return _TOOLING_COLUMN_CACHE
    flags = {"tooling_ready": False, "tooling_ready_date": False}
    try:
        for row in rows(
            con.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'planner_operation'
                  AND column_name IN ('tooling_ready', 'tooling_ready_date')
                """
            )
        ):
            name = compact_text(row.get("column_name"))
            if name == "tooling_ready":
                flags["tooling_ready"] = True
            elif name == "tooling_ready_date":
                flags["tooling_ready_date"] = True
    except Exception:
        pass
    _TOOLING_COLUMN_CACHE = flags
    return flags


def _ensure_tooling_columns(con):
    """Apply tooling DDL only when a write path needs missing columns."""
    flags = _tooling_column_flags(con)
    if flags["tooling_ready"] and flags["tooling_ready_date"]:
        return flags
    global _TOOLING_COLUMN_CACHE
    try:
        if not flags["tooling_ready"]:
            con.execute(
                """
                ALTER TABLE planner_operation
                ADD COLUMN IF NOT EXISTS tooling_ready BOOLEAN NOT NULL DEFAULT TRUE
                """
            )
            flags["tooling_ready"] = True
        if not flags["tooling_ready_date"]:
            con.execute(
                """
                ALTER TABLE planner_operation
                ADD COLUMN IF NOT EXISTS tooling_ready_date DATE
                """
            )
            flags["tooling_ready_date"] = True
    except Exception:
        pass
    _TOOLING_COLUMN_CACHE = dict(flags)
    return _TOOLING_COLUMN_CACHE


def tooling_map_for_operation_ids(con, operation_ids):
    """Return {operation_id: bool}; defaults True — False only for flagged exceptions."""
    flags = _tooling_column_flags(con)
    ids = sorted({int(i) for i in (operation_ids or []) if int(i or 0) > 0})
    if not ids:
        return {}
    if not flags.get("tooling_ready"):
        return {op_id: True for op_id in ids}
    out = {op_id: True for op_id in ids}
    for row in rows(
        con.execute(
            """
            SELECT operation_id, COALESCE(tooling_ready, TRUE) AS tooling_ready
            FROM planner_operation
            WHERE operation_id = ANY(%s)
            """,
            (ids,),
        )
    ):
        op_id = int(row.get("operation_id") or 0)
        if op_id:
            out[op_id] = bool(row.get("tooling_ready"))
    return out


def tooling_map_for_ps_op_keys(con, keys):
    """Return {(planner_ps_id, source_op_seq_id): bool}; defaults True — False only for exceptions."""
    flags = _tooling_column_flags(con)
    normalized = []
    seen = set()
    for key in keys or []:
        if not key or not isinstance(key, (tuple, list)) or len(key) < 2:
            continue
        ps_id = compact_text(key[0])
        seq_id = int(key[1] or 0)
        if not ps_id or seq_id <= 0:
            continue
        token = (ps_id, seq_id)
        if token in seen:
            continue
        seen.add(token)
        normalized.append(token)
    if not normalized:
        return {}
    if not flags.get("tooling_ready"):
        return {token: True for token in normalized}
    ps_ids = list(dict.fromkeys(ps for ps, _ in normalized))
    op_rows = rows(
        con.execute(
            """
            SELECT source_ps_id, job_no, source_op_seq_id,
                   COALESCE(tooling_ready, TRUE) AS tooling_ready
            FROM planner_operation
            WHERE source_ps_id = ANY(%s)
               OR split_part(COALESCE(source_ps_id, ''), '::', 1) = ANY(%s)
               OR split_part(COALESCE(job_no, ''), '::', 1) = ANY(%s)
            """,
            (
                ps_ids,
                [_readiness_source_ps_base(pid) for pid in ps_ids],
                [_readiness_source_ps_base(pid) for pid in ps_ids],
            ),
        )
    )
    return _apply_ready_exceptions_to_ps_op_keys(
        normalized,
        _ready_exception_bases_from_operation_rows(op_rows, "tooling_ready"),
    )


def _readiness_source_ps_base(ps_id):
    """Canonical source process-sheet id (no ::partial) for tooling/program fan-out."""
    text = compact_text(ps_id)
    if not text:
        return ""
    source, _, _ = _planner_ps_identity(text)
    return compact_text(source)


def collapse_block_ready_flags_by_source_ps(blocks):
    """Share tooling/program exceptions across BOM steps of the same process sheet.

    False wins so lane card colours stay consistent for the same PS (and part).
    """
    tooling_false = set()
    program_false = set()
    for row in blocks or []:
        base = _readiness_source_ps_base(
            row.get("planner_ps_id") or row.get("source_ps_id") or row.get("job_no")
        )
        if not base:
            continue
        if row.get("tooling_ready") is False:
            tooling_false.add(base)
        if row.get("program_ready") is False:
            program_false.add(base)
    for row in blocks or []:
        base = _readiness_source_ps_base(
            row.get("planner_ps_id") or row.get("source_ps_id") or row.get("job_no")
        )
        if not base:
            continue
        if base in tooling_false:
            row["tooling_ready"] = False
        if base in program_false:
            row["program_ready"] = False
    return blocks


def _ready_exception_bases_from_operation_rows(op_rows, ready_key):
    bases = set()
    for row in op_rows or []:
        if bool(row.get(ready_key, True)):
            continue
        base = _readiness_source_ps_base(row.get("source_ps_id") or row.get("job_no"))
        if base:
            bases.add(base)
    return bases


def _apply_ready_exceptions_to_ps_op_keys(tokens, exception_bases):
    out = {token: True for token in tokens}
    for token in tokens:
        base = _readiness_source_ps_base(token[0])
        if base and base in exception_bases:
            out[token] = False
    return out


def _sibling_operation_ids_for_source_ps(con, source_ps_id):
    source_base = _readiness_source_ps_base(source_ps_id)
    if not source_base:
        return []
    found = rows(
        con.execute(
            """
            SELECT operation_id, source_ps_id, job_no
            FROM planner_operation
            WHERE split_part(COALESCE(source_ps_id, ''), '::', 1) = %s
               OR split_part(COALESCE(job_no, ''), '::', 1) = %s
            """,
            (source_base, source_base),
        )
    )
    out = []
    seen = set()
    for row in found:
        op_id = int(row.get("operation_id") or 0)
        if op_id <= 0 or op_id in seen:
            continue
        for candidate in (row.get("source_ps_id"), row.get("job_no")):
            if _readiness_source_ps_base(candidate) == source_base:
                seen.add(op_id)
                out.append(op_id)
                break
    return out


def _resolve_operation_id_for_tooling(con, operation_id=None, ps_id=None, source_op_seq_id=None):
    op_id = int(operation_id or 0)
    if op_id > 0:
        return op_id
    canonical_ps_id = compact_text(ps_id)
    seq_id = int(source_op_seq_id or 0)
    if not canonical_ps_id or seq_id <= 0:
        return 0
    _, _, planner_ps_id = _planner_ps_identity(canonical_ps_id)
    row = one(
        con.execute(
            """
            SELECT operation_id
            FROM planner_operation
            WHERE source_ps_id = %s
              AND source_op_seq_id = %s
            ORDER BY operation_id DESC
            LIMIT 1
            """,
            (planner_ps_id, seq_id),
        )
    )
    return int((row or {}).get("operation_id") or 0)


def _source_ps_for_operation(con, op_id, fallback_ps_id=""):
    row = one(
        con.execute(
            """
            SELECT source_ps_id, job_no
            FROM planner_operation
            WHERE operation_id = %s
            """,
            (int(op_id or 0),),
        )
    )
    return (
        compact_text((row or {}).get("source_ps_id"))
        or compact_text((row or {}).get("job_no"))
        or compact_text(fallback_ps_id)
    )


def _update_operation_ready_flag(
    con,
    *,
    ready_bool,
    column,
    date_column,
    operation_id=None,
    ps_id=None,
    source_op_seq_id=None,
):
    op_id = _resolve_operation_id_for_tooling(
        con,
        operation_id=operation_id,
        ps_id=ps_id,
        source_op_seq_id=source_op_seq_id,
    )
    source_ps = compact_text(ps_id)
    if op_id > 0:
        source_ps = _source_ps_for_operation(con, op_id, source_ps)
    sibling_ids = _sibling_operation_ids_for_source_ps(con, source_ps)
    if op_id > 0 and op_id not in sibling_ids:
        sibling_ids.insert(0, op_id)
    if not sibling_ids:
        return None, "operation not found"
    return_id = op_id if op_id > 0 else sibling_ids[0]
    con.execute(
        f"""
        UPDATE planner_operation
        SET {column} = %s,
            {date_column} = CASE
                WHEN NOT %s THEN COALESCE({date_column}, CURRENT_DATE)
                ELSE NULL
            END,
            updated_at = NOW()
        WHERE operation_id = ANY(%s)
        """,
        (ready_bool, ready_bool, sibling_ids),
    )
    row = one(
        con.execute(
            f"""
            SELECT operation_id, source_ps_id, source_op_seq_id,
                   {column}, {date_column}
            FROM planner_operation
            WHERE operation_id = %s
            """,
            (return_id,),
        )
    )
    ready_date = (row or {}).get(date_column)
    return {
        "operation_id": return_id,
        "ps_id": compact_text((row or {}).get("source_ps_id")),
        "source_op_seq_id": int((row or {}).get("source_op_seq_id") or 0),
        column: bool((row or {}).get(column)),
        date_column: ready_date.isoformat() if ready_date else None,
        "updated_operation_ids": sibling_ids,
    }, None


def _update_tooling(con, tooling_ready, operation_id=None, ps_id=None, source_op_seq_id=None):
    _ensure_tooling_columns(con)
    return _update_operation_ready_flag(
        con,
        ready_bool=bool(tooling_ready),
        column="tooling_ready",
        date_column="tooling_ready_date",
        operation_id=operation_id,
        ps_id=ps_id,
        source_op_seq_id=source_op_seq_id,
    )


def tooling_post_response():
    """Shared handler for tooling exception flags (scheduler op card modal)."""
    data = request.get_json(force=True, silent=True) or {}
    if "tooling_ready" not in data:
        return jsonify({"error": "tooling_ready is required"}), 400
    try:
        tooling_ready = _parse_material_in_field(data.get("tooling_ready"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    operation_id = int(data.get("operation_id") or 0)
    ps_id = compact_text(data.get("ps_id"))
    source_op_seq_id = int(data.get("source_op_seq_id") or 0)
    if operation_id <= 0 and (not ps_id or source_op_seq_id <= 0):
        return jsonify({"error": "operation_id or (ps_id + source_op_seq_id) is required"}), 400
    try:
        with planner_db() as con:
            payload, err = _update_tooling(
                con,
                tooling_ready,
                operation_id=operation_id,
                ps_id=ps_id,
                source_op_seq_id=source_op_seq_id,
            )
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        raise


@process_sheets_bp.post("/api/trial/operations/tooling-flag")
@process_sheets_bp.post("/api/operations/tooling-flag")
def api_operation_tooling_post():
    return tooling_post_response()


_PROGRAM_COLUMN_CACHE = None


def _program_column_flags(con):
    """Detect planner_operation program columns without DDL on hot read paths."""
    global _PROGRAM_COLUMN_CACHE
    if _PROGRAM_COLUMN_CACHE is not None:
        return _PROGRAM_COLUMN_CACHE
    flags = {"program_ready": False, "program_ready_date": False}
    try:
        for row in rows(
            con.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'planner_operation'
                  AND column_name IN ('program_ready', 'program_ready_date')
                """
            )
        ):
            name = compact_text(row.get("column_name"))
            if name == "program_ready":
                flags["program_ready"] = True
            elif name == "program_ready_date":
                flags["program_ready_date"] = True
    except Exception:
        pass
    _PROGRAM_COLUMN_CACHE = flags
    return flags


def _ensure_program_columns(con):
    """Apply program DDL only when a write path needs missing columns."""
    flags = _program_column_flags(con)
    if flags["program_ready"] and flags["program_ready_date"]:
        return flags
    global _PROGRAM_COLUMN_CACHE
    try:
        if not flags["program_ready"]:
            con.execute(
                """
                ALTER TABLE planner_operation
                ADD COLUMN IF NOT EXISTS program_ready BOOLEAN NOT NULL DEFAULT TRUE
                """
            )
            flags["program_ready"] = True
        if not flags["program_ready_date"]:
            con.execute(
                """
                ALTER TABLE planner_operation
                ADD COLUMN IF NOT EXISTS program_ready_date DATE
                """
            )
            flags["program_ready_date"] = True
    except Exception:
        pass
    _PROGRAM_COLUMN_CACHE = dict(flags)
    return _PROGRAM_COLUMN_CACHE


def program_map_for_operation_ids(con, operation_ids):
    """Return {operation_id: bool}; defaults True — False only for flagged exceptions."""
    flags = _program_column_flags(con)
    ids = sorted({int(i) for i in (operation_ids or []) if int(i or 0) > 0})
    if not ids:
        return {}
    if not flags.get("program_ready"):
        return {op_id: True for op_id in ids}
    out = {op_id: True for op_id in ids}
    for row in rows(
        con.execute(
            """
            SELECT operation_id, COALESCE(program_ready, TRUE) AS program_ready
            FROM planner_operation
            WHERE operation_id = ANY(%s)
            """,
            (ids,),
        )
    ):
        op_id = int(row.get("operation_id") or 0)
        if op_id:
            out[op_id] = bool(row.get("program_ready"))
    return out


def program_map_for_ps_op_keys(con, keys):
    """Return {(planner_ps_id, source_op_seq_id): bool}; defaults True — False only for exceptions."""
    flags = _program_column_flags(con)
    normalized = []
    seen = set()
    for key in keys or []:
        if not key or not isinstance(key, (tuple, list)) or len(key) < 2:
            continue
        ps_id = compact_text(key[0])
        seq_id = int(key[1] or 0)
        if not ps_id or seq_id <= 0:
            continue
        token = (ps_id, seq_id)
        if token in seen:
            continue
        seen.add(token)
        normalized.append(token)
    if not normalized:
        return {}
    if not flags.get("program_ready"):
        return {token: True for token in normalized}
    ps_ids = list(dict.fromkeys(ps for ps, _ in normalized))
    op_rows = rows(
        con.execute(
            """
            SELECT source_ps_id, job_no, source_op_seq_id,
                   COALESCE(program_ready, TRUE) AS program_ready
            FROM planner_operation
            WHERE source_ps_id = ANY(%s)
               OR split_part(COALESCE(source_ps_id, ''), '::', 1) = ANY(%s)
               OR split_part(COALESCE(job_no, ''), '::', 1) = ANY(%s)
            """,
            (
                ps_ids,
                [_readiness_source_ps_base(pid) for pid in ps_ids],
                [_readiness_source_ps_base(pid) for pid in ps_ids],
            ),
        )
    )
    return _apply_ready_exceptions_to_ps_op_keys(
        normalized,
        _ready_exception_bases_from_operation_rows(op_rows, "program_ready"),
    )


def _update_program(con, program_ready, operation_id=None, ps_id=None, source_op_seq_id=None):
    _ensure_program_columns(con)
    return _update_operation_ready_flag(
        con,
        ready_bool=bool(program_ready),
        column="program_ready",
        date_column="program_ready_date",
        operation_id=operation_id,
        ps_id=ps_id,
        source_op_seq_id=source_op_seq_id,
    )


def program_post_response():
    """Shared handler for program exception flags (scheduler op card modal)."""
    data = request.get_json(force=True, silent=True) or {}
    if "program_ready" not in data:
        return jsonify({"error": "program_ready is required"}), 400
    try:
        program_ready = _parse_material_in_field(data.get("program_ready"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    operation_id = int(data.get("operation_id") or 0)
    ps_id = compact_text(data.get("ps_id"))
    source_op_seq_id = int(data.get("source_op_seq_id") or 0)
    if operation_id <= 0 and (not ps_id or source_op_seq_id <= 0):
        return jsonify({"error": "operation_id or (ps_id + source_op_seq_id) is required"}), 400
    try:
        with planner_db() as con:
            payload, err = _update_program(
                con,
                program_ready,
                operation_id=operation_id,
                ps_id=ps_id,
                source_op_seq_id=source_op_seq_id,
            )
            if err:
                return jsonify({"error": err}), 404
            return jsonify(payload)
    except Exception as e:
        friendly = planner_db_connect_error(e)
        if friendly:
            return jsonify({"error": friendly}), 503
        raise


@process_sheets_bp.post("/api/trial/operations/program-flag")
@process_sheets_bp.post("/api/operations/program-flag")
def api_operation_program_post():
    return program_post_response()


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


@process_sheets_bp.post("/api/trial/delivery-schedule/flags")
@process_sheets_bp.post("/api/process-sheets/delivery-flags")
def api_delivery_schedule_flags_post():
    from .delivery_planner_service import delivery_flags_post_response

    return delivery_flags_post_response()


@process_sheets_bp.post("/api/trial/delivery-schedule/flags/bulk")
@process_sheets_bp.post("/api/process-sheets/delivery-flags/bulk")
def api_delivery_schedule_flags_bulk_post():
    from .delivery_planner_service import delivery_flags_bulk_post_response

    return delivery_flags_bulk_post_response()


@process_sheets_bp.post("/api/trial/process-sheets/so-line-pricing")
@process_sheets_bp.post("/api/process-sheets/so-line-pricing")
def api_process_sheets_so_line_pricing():
    data = request.get_json(force=True, silent=True) or {}
    raw_keys = data.get("keys") or []
    pairs: list[tuple[str, str]] = []
    for item in raw_keys:
        if not isinstance(item, dict):
            continue
        pairs.append((item.get("sales_order_no"), item.get("line_item_no")))
    try:
        return jsonify({"pricing": fetch_so_line_pricing_map(pairs)})
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
            steps, wo_stages = _prepare_process_sheet_steps(
                con,
                dict(ps_row),
                steps_by_ps.get(canonical_ps_id, []),
            )
            summary = _process_sheet_payload(
                dict(ps_row),
                steps,
                metrics_by_ps.get(canonical_ps_id, {}),
                material_status_by_ps.get(canonical_ps_id, {}),
                manual_qty_by_ps.get(canonical_ps_id, {}),
                wo_stages=wo_stages,
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

            if not is_temp_planner_ps_id(canonical_ps_id):
                try:
                    repaired_bom_id = _repair_erp_ps_planner_bom_if_missing(con, canonical_ps_id)
                    if repaired_bom_id and repaired_bom_id != int(ps.get("selected_bom_id") or 0):
                        ps = one(
                            con.execute(
                                _ps_select(con) + " WHERE ps.planner_ps_id = %s",
                                (canonical_ps_id,),
                            )
                        ) or ps
                except Exception:
                    pass

            source_ps_id, _, _ = _planner_ps_identity(canonical_ps_id)
            steps_by_ps = _flow_steps_for_ps_ids(con, [canonical_ps_id])
            metrics_by_ps, block_rows_by_ps = _block_metrics_for_ps_ids(con, [canonical_ps_id])
            material_status_by_ps = material_status_map_for_ps_ids(
                con,
                [canonical_ps_id],
                {canonical_ps_id: metrics_by_ps.get(canonical_ps_id, {}).get("expected_start", "")},
            )
            manual_qty_by_ps = _manual_qty_by_ps_ids(con, [canonical_ps_id])
            steps, wo_stages = _prepare_process_sheet_steps(
                con,
                dict(ps),
                steps_by_ps.get(canonical_ps_id, []),
            )
            summary = _process_sheet_payload(
                dict(ps),
                steps,
                metrics_by_ps.get(canonical_ps_id, {}),
                material_status_by_ps.get(canonical_ps_id, {}),
                manual_qty_by_ps.get(canonical_ps_id, {}),
                wo_stages=wo_stages,
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

            enrich_items_material_inventory_codes(con, [summary])

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
    due_date = compact_text(data.get("due_date") or data.get("po_due_date") or "")
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
                    due_date=due_date,
                )
            else:
                if not source_ps_id:
                    return jsonify({"error": "source_ps_id is required"}), 400
                result = create_temp_process_sheet(
                    con, source_ps_id, pp_partial_no, qty, remarks=remarks, due_date=due_date
                )
            try:
                from app import _invalidate_pp_vouchers_with_ops_cache

                _invalidate_pp_vouchers_with_ops_cache(schedule_rebuild=True)
            except Exception:
                pass
            return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.patch("/api/trial/temp-process-sheets/<path:planner_ps_id>")
@process_sheets_bp.patch("/api/temp-process-sheets/<path:planner_ps_id>")
def api_patch_temp_process_sheet(planner_ps_id):
    data = request.get_json(silent=True) or {}
    allowed = {
        "due_date",
        "po_due_date",
        "qty",
        "reject_qty",
        "remarks",
        "part_no",
        "part_desc",
        "source_ps_id",
        "source_label",
        "source_pp_partial_no",
        "current_stage_op_seq_id",
        "current_stage_seq_no",
        "current_stage_status",
    }
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return jsonify({"error": "At least one updatable field is required"}), 400
    try:
        with planner_db() as con:
            _ensure_planner_temp_process_sheet_table(con)
            result = update_temp_process_sheet(con, planner_ps_id, updates)
            try:
                from app import _invalidate_pp_vouchers_with_ops_cache

                _invalidate_pp_vouchers_with_ops_cache(schedule_rebuild=True)
            except Exception:
                pass
            return jsonify({"ok": True, **result})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@process_sheets_bp.post("/api/trial/temp-process-sheets/<path:planner_ps_id>/resolve")
@process_sheets_bp.post("/api/temp-process-sheets/<path:planner_ps_id>/resolve")
def api_resolve_temp_process_sheet(planner_ps_id):
    data = request.get_json(silent=True) or {}
    qty_produced = data.get("qty_produced")
    if qty_produced is None:
        qty_produced = data.get("output_qty") or data.get("qty") or data.get("quantity")
    qty_rejected = data.get("qty_rejected")
    if qty_rejected is None:
        qty_rejected = data.get("reject_qty") or 0
    remarks = compact_text(data.get("remarks") or "")
    try:
        with planner_db() as con:
            _ensure_planner_temp_process_sheet_table(con)
            result = resolve_temp_process_sheet(
                con,
                planner_ps_id,
                qty_produced,
                qty_rejected=qty_rejected,
                remarks=remarks,
            )
            try:
                from app import _invalidate_pp_vouchers_with_ops_cache

                _invalidate_pp_vouchers_with_ops_cache(schedule_rebuild=True)
            except Exception:
                pass
            return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _api_delete_temp_process_sheet_result(planner_ps_id):
    with planner_db() as con:
        _ensure_planner_temp_process_sheet_table(con)
        result = delete_temp_process_sheet(con, planner_ps_id)
    try:
        from app import _invalidate_pp_vouchers_with_ops_cache

        _invalidate_pp_vouchers_with_ops_cache(schedule_rebuild=True)
    except Exception:
        pass
    return result


@process_sheets_bp.post("/api/trial/temp-process-sheets/<path:planner_ps_id>/delete")
@process_sheets_bp.post("/api/temp-process-sheets/<path:planner_ps_id>/delete")
@process_sheets_bp.delete("/api/trial/temp-process-sheets/<path:planner_ps_id>")
@process_sheets_bp.delete("/api/temp-process-sheets/<path:planner_ps_id>")
def api_delete_temp_process_sheet(planner_ps_id):
    try:
        return jsonify(_api_delete_temp_process_sheet_result(planner_ps_id))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
