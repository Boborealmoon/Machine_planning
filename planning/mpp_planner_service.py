"""MPP planner — machine fleet resolution and frame-agreement job intake."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .frame_agreement_service import (
    apply_fa_mpp_overrides,
    ensure_frame_agreement_schema,
    fetch_mpp_job_candidates as _fetch_erp_mpp_job_candidates,
    is_frame_agreement_part,
    load_frame_agreement_mpp_lookup,
    load_frame_agreement_part_keys,
    normalize_part_key,
    resolve_fa_mpp_settings,
)
from .helpers import rows
from .machines import fetch_machines
from .process_sheets import format_planner_ps_id, manual_qty_by_ps_ids
from .utils import compact_text, parse_number

MPP_PLANNER_EXTRA_MACHINE_CODES = frozenset({"CNC 41"})
MPP_DEFAULT_LOAD_MIN_PER_PALLET = 15.0
MPP_DEFAULT_UNLOAD_MIN_PER_PALLET = 15.0
# Load/unload are once per unattended cycle (DB column names kept for compatibility).
MPP_DEFAULT_LOAD_MIN_PER_CYCLE = MPP_DEFAULT_LOAD_MIN_PER_PALLET
MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE = MPP_DEFAULT_UNLOAD_MIN_PER_PALLET


@dataclass
class MppIntakeContext:
    planned_qty_by_op: dict
    queued_machines_by_op: dict
    bom_stage_keys: set
    master_cache: Any
    erp_steps_cache: dict[tuple[str, int], list[dict[str, Any]]]
    manual_qty_by_ps: dict[str, dict]
    mpp_codes: set[str]
    fa_mpp_by_part: dict[str, dict[str, Any]]


def mpp_machine_slug(machine_no: str) -> str:
    return re.sub(r"\s+", "", compact_text(machine_no)).lower()


def serialize_mpp_machine(row: dict[str, Any]) -> dict[str, Any]:
    code = compact_text(row.get("machine_no") or row.get("machine_code"))
    shift = compact_text(row.get("shift_profile")) or "STANDARD"
    category = compact_text(row.get("machine_category")) or "MPP"
    return {
        "id": mpp_machine_slug(code),
        "machineId": int(row.get("machine_id") or 0),
        "code": code,
        "category": category,
        "shift": shift,
    }


def fetch_mpp_planner_machines(con) -> list[dict[str, Any]]:
    """Active planner machines for the MPP board: category MPP + CNC 41."""
    all_active = fetch_machines(con) or []
    by_code: dict[str, dict[str, Any]] = {}
    for row in all_active:
        code = compact_text(row.get("machine_no") or row.get("machine_code"))
        if code:
            by_code[code.upper()] = row

    selected: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in sorted(all_active, key=lambda r: compact_text(r.get("machine_no") or r.get("machine_code"))):
        code = compact_text(row.get("machine_no") or row.get("machine_code"))
        if compact_text(row.get("machine_category")).upper() != "MPP":
            continue
        key = code.upper()
        if not key or key in seen:
            continue
        seen.add(key)
        selected.append(serialize_mpp_machine(row))

    for extra in sorted(MPP_PLANNER_EXTRA_MACHINE_CODES, key=str.upper):
        key = extra.upper()
        if key in seen:
            continue
        row = by_code.get(key)
        if not row:
            continue
        seen.add(key)
        selected.append(serialize_mpp_machine(row))

    selected.sort(key=lambda m: m["code"])
    return selected


def mpp_machine_code_set(con) -> set[str]:
    return {compact_text(m["code"]).upper() for m in fetch_mpp_planner_machines(con) if compact_text(m.get("code"))}


def _is_mpp_catalog_op(op: dict[str, Any], mpp_codes: set[str]) -> bool:
    if compact_text(op.get("machine_category")).upper() == "MPP":
        return True
    if compact_text(op.get("compatible_machine_group")).upper() == "MPP":
        return True
    pref = compact_text(op.get("preferred_machine")).upper()
    if pref and pref in mpp_codes:
        return True
    for code in op.get("queued_machines") or []:
        if compact_text(code).upper() in mpp_codes:
            return True
    return False


def _is_mpp_intake_op(op: dict[str, Any], mpp_codes: set[str]) -> bool:
    from .catalog import _is_machining_plannable_op
    from .erp_wo_merge import is_finishing_stage_desc

    stage_desc = compact_text(op.get("stage_desc") or op.get("op_type") or op.get("operation_name") or "")
    if is_finishing_stage_desc(stage_desc):
        return False
    if _is_mpp_catalog_op(op, mpp_codes):
        return True
    if not _is_machining_plannable_op(
        op.get("op_type"),
        op.get("machine_category"),
        op.get("source_kind"),
        op.get("preferred_machine"),
    ):
        return False
    pref = compact_text(op.get("preferred_machine")).upper()
    if pref and pref not in mpp_codes:
        return False
    return True


def _mpp_job_id(source_ps_id: str, pp_partial_no: int, op_no: str, op_seq_id: int) -> str:
    op_token = compact_text(op_no) or str(op_seq_id or 0)
    return f"{source_ps_id.lower()}::p{max(1, int(pp_partial_no or 1))}::op{op_token}"


def _op_label_from_row(op: dict[str, Any], card: dict[str, Any] | None = None) -> str:
    card = card or {}
    op_no = compact_text(
        card.get("operation_label")
        or card.get("source_op_no")
        or op.get("op_no")
        or op.get("source_op_no")
        or ""
    )
    if op_no.upper().startswith("OP"):
        op_no = op_no[2:].strip()
    op_type = compact_text(card.get("operation_name") or op.get("op_type") or op.get("operation_name") or "")
    if op_no and op_type:
        return f"OP{op_no} {op_type}".strip()
    return op_type or (f"OP{op_no}" if op_no else "MPP op")


def _mpp_planned_qty_maps(con, mpp_machine_ids: list[int]) -> tuple[dict, dict]:
    """Planned + queued qty from MPP planner cycles only (not legacy scheduler blocks)."""
    from .catalog import _canonical_catalog_ps_id, trial_catalog_op_key
    from .mpp_planner_queue_service import ensure_mpp_queue_schema

    mids = [int(mid) for mid in mpp_machine_ids if int(mid or 0) > 0]
    if not mids:
        return {}, {}
    ensure_mpp_queue_schema(con)
    planned_qty_by_op: dict = {}
    queued_machines_by_op: dict = {}
    for row in rows(
        con.execute(
            """
            SELECT co.source_ps_id,
                   co.source_op_no,
                   co.source_op_seq_id,
                   COALESCE(SUM(
                       COALESCE(co.pallet_count, 1) * COALESCE(co.pcs_per_pallet, 1)
                   ), 0) AS planned_qty
            FROM planner_mpp_cycle_op co
            JOIN planner_mpp_cycle c ON c.cycle_id = co.cycle_id
            WHERE c.machine_id = ANY(%s)
              AND COALESCE(co.source_ps_id, '') <> ''
            GROUP BY co.source_ps_id, co.source_op_no, co.source_op_seq_id
            """,
            (mids,),
        )
    ):
        canonical_ps = _canonical_catalog_ps_id(row["source_ps_id"])
        key = trial_catalog_op_key(canonical_ps, row["source_op_no"], row["source_op_seq_id"])
        planned_qty_by_op[key] = float(planned_qty_by_op.get(key, 0) or 0) + float(row["planned_qty"] or 0)
    for row in rows(
        con.execute(
            """
            SELECT DISTINCT co.source_ps_id, co.source_op_no, co.source_op_seq_id,
                   m.machine_no AS machine_code
            FROM planner_mpp_cycle_op co
            JOIN planner_mpp_cycle c ON c.cycle_id = co.cycle_id
            JOIN planner_machines m ON m.machine_id = c.machine_id
            WHERE c.machine_id = ANY(%s)
              AND COALESCE(co.source_ps_id, '') <> ''
            ORDER BY m.machine_no
            """,
            (mids,),
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


def _mpp_job_schedule_meta(op: dict[str, Any], wo_qty: float = 0) -> tuple[bool, str]:
    """Whether an MPP op can be scheduled and why not when blocked."""
    erp_fin = float(op.get("erp_finished_qty") or 0)
    mpp_planned = float(op.get("planned_qty") or 0)
    remaining = float(op.get("remaining_qty") or 0)
    if remaining <= 0 and wo_qty > 0:
        remaining = max(0.0, wo_qty - erp_fin - mpp_planned)
    if remaining > 0:
        return True, ""
    target = wo_qty if wo_qty > 0 else float(op.get("required_qty") or op.get("ready_qty") or 0)
    if erp_fin > 0 and target > 0 and erp_fin >= target:
        return False, "MPP qty met (ERP)"
    if mpp_planned > 0 and remaining <= 0:
        return False, "Fully on MPP queue"
    return False, "Fully accounted"


def _mpp_op_times_from_master(
    item: dict[str, Any],
    op: dict[str, Any],
    ctx: MppIntakeContext | None,
) -> tuple[float, float]:
    """Master production cycle/setup for MPP job intake (before FA overrides)."""
    fallback_cycle = float(op.get("cycle_time") or 0)
    fallback_setup = float(op.get("setup_time") or 0)
    if not ctx or not ctx.master_cache:
        return fallback_cycle, fallback_setup
    from .cycle_time_service import _parse_op_no

    part_no = compact_text(item.get("part_no") or item.get("inventory_code") or "")
    if not part_no:
        return fallback_cycle, fallback_setup
    bom_code = compact_text(item.get("selected_bom_code") or item.get("erp_bom_code") or "")
    master = ctx.master_cache.lookup(
        part_no=part_no,
        bom_code=bom_code,
        op_no=_parse_op_no(op.get("op_no") or op.get("source_op_no")),
        op_type=compact_text(op.get("op_type") or ""),
        stage_no=int(op.get("source_stage_no") or 0) or None,
        extra_part_nos=[compact_text(item.get("part_desc") or "")],
    )
    if not master:
        return fallback_cycle, fallback_setup
    ideal = parse_number(master.get("ideal_cycle_time"), 0)
    production = parse_number(master.get("cycle_time"), 0)
    cycle = production if production > 0 else ideal
    setup = parse_number(master.get("set_up_time"), 0)
    return (
        cycle if cycle > 0 else fallback_cycle,
        setup if setup > 0 else fallback_setup,
    )


def _serialize_catalog_mpp_job(
    item: dict[str, Any],
    op: dict[str, Any],
    ctx: MppIntakeContext | None = None,
) -> dict[str, Any]:
    source_ps_id = compact_text(item.get("source_ps_id") or "")
    if not source_ps_id:
        raw_ps = compact_text(item.get("ps_id") or "")
        source_ps_id = raw_ps.split("::", 1)[0] if raw_ps else ""
    pp_partial_no = int(item.get("pp_partial_no") or 1)
    ps_display = compact_text(item.get("display_ps_id") or "") or format_planner_ps_id(source_ps_id, pp_partial_no)
    op_seq_id = int(op.get("source_op_seq_id") or 0)
    op_no = compact_text(op.get("op_no") or op.get("source_op_no") or "")
    if op_no.upper().startswith("OP"):
        op_no = op_no[2:].strip()
    cycle_time, setup_minutes = _mpp_op_times_from_master(item, op, ctx)
    min_per_pallet = max(1, int(round(cycle_time))) if cycle_time > 0 else 90
    setup_minutes = max(0.0, setup_minutes)
    wo_qty = float(
        op.get("erp_required_qty")
        or op.get("required_qty")
        or item.get("partial_qty")
        or item.get("display_qty")
        or 0
    )
    remaining = float(op.get("remaining_qty") or 0)
    schedulable, blocked_reason = _mpp_job_schedule_meta(op, wo_qty)
    due = compact_text(item.get("due_date") or "")
    if due and " " in due:
        due = due.split(" ", 1)[0]
    inventory_code = compact_text(item.get("part_no") or item.get("inventory_code") or "")
    is_fa = bool(item.get("isFrameAgreement"))
    return {
        "jobId": _mpp_job_id(source_ps_id, pp_partial_no, op_no, op_seq_id),
        "sourcePsId": source_ps_id,
        "psId": ps_display,
        "partNo": compact_text(item.get("part_no") or item.get("inventory_code") or ""),
        "partDesc": compact_text(item.get("part_desc") or item.get("part_name") or ""),
        "opLabel": _op_label_from_row(op),
        "minPerPallet": min_per_pallet,
        "setupMinutes": setup_minutes,
        "loadMinPerPallet": MPP_DEFAULT_LOAD_MIN_PER_CYCLE,
        "unloadMinPerPallet": MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE,
        "loadMinPerCycle": MPP_DEFAULT_LOAD_MIN_PER_CYCLE,
        "unloadMinPerCycle": MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE,
        "pcsPerPallet": 1,
        "defaultPalletsPerCycle": 1,
        "qty": wo_qty or remaining,
        "out": float(op.get("erp_finished_qty") or 0),
        "remainingQty": remaining,
        "requiredQty": float(op.get("required_qty") or op.get("wo_qty_required") or wo_qty or 0),
        "erpFinished": float(op.get("erp_finished_qty") or 0),
        "plannedQty": float(op.get("planned_qty") or 0),
        "schedulable": schedulable,
        "blockedReason": blocked_reason,
        "due": due,
        "bomCode": compact_text(item.get("selected_bom_code") or item.get("erp_bom_code") or ""),
        "erpBomCode": compact_text(item.get("erp_bom_code") or ""),
        "bomStageStatus": compact_text(item.get("bom_stage_status") or ""),
        "partialQty": float(item.get("partial_qty") or item.get("display_qty") or 0),
        "totalQty": float(item.get("total_qty") or 0),
        "qtyShipped": float(item.get("qty_shipped") or 0) if item.get("qty_shipped") is not None else 0,
        "currentStageDesc": compact_text(item.get("current_stage_desc") or ""),
        "currentStageStatus": compact_text(item.get("current_stage_status") or ""),
        "materialIn": bool(item.get("material_in")),
        "sourceVoucher": compact_text(item.get("source_voucher") or item.get("source_voucher_no") or ""),
        "plannerStatus": compact_text(item.get("planner_status") or item.get("status") or ""),
        "inventoryCode": compact_text(item.get("inventory_code") or item.get("part_no") or ""),
        "preferredMachine": compact_text(op.get("preferred_machine") or ""),
        "machineCategory": compact_text(op.get("machine_category") or "MPP"),
        "status": compact_text(item.get("status") or item.get("planner_status") or ""),
        "isFrameAgreement": is_fa,
        "opSeqId": op_seq_id,
        "opNo": op_no,
        "ppPartialNo": pp_partial_no,
        "source": "process_sheet",
    }


def _voucher_summary_for_partial(con, source_ps_id: str, pp_partial_no: int) -> dict[str, Any]:
    batch = _voucher_summaries_batch(con, [(source_ps_id, pp_partial_no)])
    return batch.get((source_ps_id, pp_partial_no), {})


def _voucher_summaries_batch(
    con, partial_keys: list[tuple[str, int]]
) -> dict[tuple[str, int], dict[str, Any]]:
    keys = [
        (compact_text(ps_id), max(1, int(pp_partial_no or 1)))
        for ps_id, pp_partial_no in partial_keys
        if compact_text(ps_id)
    ]
    if not keys:
        return {}
    unique_keys = list(dict.fromkeys(keys))
    values_sql = ", ".join(["(%s, %s)"] * len(unique_keys))
    params: list[Any] = []
    for ps_id, pp_partial_no in unique_keys:
        params.extend([ps_id, pp_partial_no])
    raw = rows(
        con.execute(
            f"""
            SELECT
                v.ps_id,
                v.pp_partial_no,
                MIN(v.due_date)::text AS due_date,
                MAX(COALESCE(v.partial_qty, 0)) AS partial_qty,
                MAX(COALESCE(v.total_qty, 0)) AS total_qty,
                MAX(COALESCE(v.qty_shipped, 0)) AS qty_shipped,
                MAX(COALESCE(v.source_line_item_no, '')) AS source_line_item_no,
                MAX(TRIM(COALESCE(v.description, ''))) AS part_desc,
                MAX(NULLIF(TRIM(v.bom_code), '')) AS erp_bom_code,
                MAX(TRIM(COALESCE(v.current_stage_desc, ''))) AS current_stage_desc,
                MAX(TRIM(COALESCE(v.current_stage_status, ''))) AS current_stage_status,
                MAX(NULLIF(TRIM(v.source_voucher_no), '')) AS source_voucher_no
            FROM pp_vouchers_cache v
            INNER JOIN (VALUES {values_sql}) AS k(ps_id, pp_partial_no)
                ON v.ps_id = k.ps_id AND v.pp_partial_no = k.pp_partial_no
            GROUP BY v.ps_id, v.pp_partial_no
            """,
            tuple(params),
        )
    )
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in raw:
        key = (compact_text(row.get("ps_id")), int(row.get("pp_partial_no") or 1))
        out[key] = dict(row)
    return out


def _ps_has_schedulable_qty(voucher: dict[str, Any]) -> bool:
    from .catalog import _should_show_for_shipped_qty

    partial_qty = float(voucher.get("partial_qty") or 0)
    total_qty = float(voucher.get("total_qty") or 0)
    if partial_qty <= 0 and total_qty <= 0:
        return False
    return _should_show_for_shipped_qty(
        total_qty or partial_qty,
        voucher.get("qty_shipped"),
        voucher.get("source_line_item_no"),
    )


def _build_intake_context(con, sheet_rows: list[dict[str, Any]], mpp_codes: set[str]) -> MppIntakeContext:
    from .catalog import _bom_op_stage_keys
    from .cycle_time_service import MasterTimeCache
    from .process_sheets import _erp_cache_steps_batch

    partial_keys = [
        (compact_text(row.get("source_ps_id")), int(row.get("pp_partial_no") or 1))
        for row in sheet_rows
        if compact_text(row.get("source_ps_id"))
    ]
    planner_ps_ids = [compact_text(row.get("ps_id")) for row in sheet_rows if compact_text(row.get("ps_id"))]
    mpp_machine_ids = [
        int(m.get("machineId") or 0)
        for m in fetch_mpp_planner_machines(con)
        if int(m.get("machineId") or 0) > 0
    ]
    planned_qty_by_op, queued_machines_by_op = _mpp_planned_qty_maps(con, mpp_machine_ids)
    return MppIntakeContext(
        planned_qty_by_op=planned_qty_by_op,
        queued_machines_by_op=queued_machines_by_op,
        bom_stage_keys=_bom_op_stage_keys(con),
        master_cache=MasterTimeCache.load(con),
        erp_steps_cache=_erp_cache_steps_batch(con, partial_keys),
        manual_qty_by_ps=manual_qty_by_ps_ids(con, planner_ps_ids),
        mpp_codes=mpp_codes,
        fa_mpp_by_part={},
    )


def _merge_erp_into_ops(entry: dict[str, Any], ctx: MppIntakeContext) -> None:
    from .process_sheets import _merge_erp_metadata_into_flow_steps

    source = compact_text(entry.get("source_ps_id"))
    partial = int(entry.get("pp_partial_no") or 1)
    erp_steps = ctx.erp_steps_cache.get((source, partial), [])
    if not erp_steps:
        return

    flow_like = []
    for op in entry.get("all_ops") or []:
        flow_like.append(
            {
                "op_no": op.get("op_no") or op.get("source_op_no"),
                "source_stage_no": int(op.get("source_stage_no") or 0),
                "stage_desc": op.get("op_type") or op.get("operation_name"),
                "op_type": op.get("op_type"),
                "machine_category": op.get("machine_category"),
                "source_kind": op.get("source_kind"),
                "erp_finished_qty": op.get("erp_finished_qty"),
                "erp_required_qty": op.get("erp_required_qty"),
                "erp_reject_qty": op.get("erp_reject_qty"),
                "erp_execution_status": op.get("execution_status"),
            }
        )
    merged = _merge_erp_metadata_into_flow_steps(flow_like, erp_steps)
    by_op_no = {compact_text(step.get("op_no")): step for step in merged if compact_text(step.get("op_no"))}
    by_stage = {int(step.get("source_stage_no") or 0): step for step in merged if int(step.get("source_stage_no") or 0)}

    refreshed: list[dict[str, Any]] = []
    for op in entry.get("all_ops") or []:
        row = dict(op)
        erp = by_op_no.get(compact_text(row.get("op_no") or row.get("source_op_no"))) or by_stage.get(
            int(row.get("source_stage_no") or 0)
        )
        if erp:
            row["erp_finished_qty"] = max(0.0, float(erp.get("erp_finished_qty") or 0))
            row["erp_required_qty"] = float(erp.get("erp_required_qty") or row.get("required_qty") or 0)
            row["erp_reject_qty"] = float(erp.get("erp_reject_qty") or 0)
            if erp.get("erp_execution_status"):
                row["execution_status"] = erp.get("erp_execution_status")
            if compact_text(erp.get("stage_desc")):
                row["stage_desc"] = compact_text(erp.get("stage_desc"))
        remaining = max(0.0, float(row.get("remaining_qty") or 0))
        finished = max(0.0, float(row.get("erp_finished_qty") or 0))
        if not compact_text(row.get("execution_status")) and finished > 0 and remaining <= 0:
            row["execution_status"] = "C"
        refreshed.append(row)
    entry["all_ops"] = refreshed


def _enrich_entry_ops(con, entry: dict[str, Any], ctx: MppIntakeContext) -> dict[str, Any]:
    from .catalog import _apply_catalog_op_qty_cascade, attach_planner_bom_ops_to_catalog_entry

    bom_id = int(entry.get("selected_bom_id") or 0)
    if bom_id <= 0:
        return entry
    attach_planner_bom_ops_to_catalog_entry(
        con,
        entry,
        planned_qty_by_op=ctx.planned_qty_by_op,
        queued_machines_by_op=ctx.queued_machines_by_op,
        bom_stage_keys=ctx.bom_stage_keys,
        master_cache=ctx.master_cache,
    )
    _merge_erp_into_ops(entry, ctx)
    ps_id = compact_text(entry.get("ps_id"))
    manual_map = dict(ctx.manual_qty_by_ps.get(ps_id) or {})
    _apply_catalog_op_qty_cascade(entry, {ps_id: manual_map} if ps_id else {})
    return entry


def _load_mpp_planner_process_sheet_rows(con, fa_keys: set[str]) -> list[dict[str, Any]]:
    """Open frame-agreement process sheets from planner_process_sheet (FA master list only)."""
    raw = rows(
        con.execute(
            """
            SELECT
                ps.planner_ps_id,
                ps.source_ps_id,
                ps.pp_partial_no,
                ps.inventory_code,
                ps.selected_bom_id,
                ps.planner_status,
                ps.status,
                ps.planned_qty,
                bv.bom_code AS selected_bom_code
            FROM planner_process_sheet ps
            LEFT JOIN planner_bom_variation bv ON bv.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id NOT LIKE '[Temp]%'
              AND COALESCE(ps.planner_status, '') NOT IN ('COMPLETED', 'CANCELLED')
              AND COALESCE(ps.status, '') NOT IN ('COMPLETED', 'CANCELLED')
            ORDER BY ps.source_ps_id, ps.pp_partial_no, ps.planner_ps_id
            """
        )
    )
    partial_keys = [
        (compact_text(row.get("source_ps_id")), int(row.get("pp_partial_no") or 1))
        for row in raw
        if compact_text(row.get("source_ps_id"))
    ]
    voucher_by_key = _voucher_summaries_batch(con, partial_keys)
    out: list[dict[str, Any]] = []
    seen_partials: set[tuple[str, int]] = set()
    for row in raw:
        inventory_code = compact_text(row.get("inventory_code"))
        if not fa_keys or not is_frame_agreement_part(inventory_code, fa_keys):
            continue
        source_ps_id = compact_text(row.get("source_ps_id"))
        pp_partial_no = int(row.get("pp_partial_no") or 1)
        partial_key = (source_ps_id, pp_partial_no)
        if partial_key in seen_partials:
            continue
        seen_partials.add(partial_key)
        voucher = voucher_by_key.get((source_ps_id, pp_partial_no), {})
        if voucher and not _ps_has_schedulable_qty(voucher):
            continue
        if int(row.get("selected_bom_id") or 0) <= 0:
            continue
        partial_qty = float(voucher.get("partial_qty") or row.get("planned_qty") or 0)
        if partial_qty <= 0:
            partial_qty = float(voucher.get("total_qty") or row.get("planned_qty") or 0)
        if partial_qty <= 0:
            continue
        planner_ps_id = compact_text(row.get("planner_ps_id")) or format_planner_ps_id(source_ps_id, pp_partial_no)
        out.append(
            {
                "ps_id": planner_ps_id,
                "display_ps_id": planner_ps_id,
                "source_ps_id": source_ps_id,
                "pp_partial_no": pp_partial_no,
                "inventory_code": inventory_code,
                "part_no": inventory_code,
                "part_desc": compact_text(voucher.get("part_desc")),
                "part_name": inventory_code,
                "due_date": compact_text(voucher.get("due_date")),
                "partial_qty": partial_qty,
                "total_qty": float(voucher.get("total_qty") or partial_qty),
                "display_qty": partial_qty,
                "wo_req_qty": partial_qty,
                "selected_bom_id": int(row.get("selected_bom_id") or 0),
                "selected_bom_code": compact_text(row.get("selected_bom_code")),
                "erp_bom_code": compact_text(voucher.get("erp_bom_code")),
                "current_stage_desc": compact_text(voucher.get("current_stage_desc")),
                "current_stage_status": compact_text(voucher.get("current_stage_status")),
                "source_voucher": compact_text(voucher.get("source_voucher_no")),
                "inventory_code": inventory_code,
                "status": compact_text(row.get("status") or row.get("planner_status")),
                "planner_status": compact_text(row.get("planner_status")),
                "planner_ps_ids": [planner_ps_id],
                "isFrameAgreement": True,
                "ops": [],
                "all_ops": [],
                "op_cards": [],
            }
        )
    return out


def _emit_jobs_from_item(
    item: dict[str, Any],
    ctx: MppIntakeContext,
    jobs: list[dict[str, Any]],
    seen: set[str],
) -> None:
    for op in item.get("all_ops") or []:
        if not _is_mpp_intake_op(op, ctx.mpp_codes):
            continue
        job = _serialize_catalog_mpp_job(item, op, ctx)
        if job.get("isFrameAgreement"):
            part_key = normalize_part_key(job.get("partNo") or job.get("inventoryCode") or "")
            bom_code = compact_text(job.get("bomCode") or job.get("erpBomCode") or "")
            op_no = compact_text(job.get("opNo") or "")
            apply_fa_mpp_overrides(
                job,
                resolve_fa_mpp_settings(ctx.fa_mpp_by_part, part_key, bom_code, op_no),
            )
        if job["jobId"] in seen:
            continue
        seen.add(job["jobId"])
        jobs.append(job)


def _mpp_jobs_from_process_sheets(con, fa_keys: set[str], mpp_codes: set[str]) -> list[dict[str, Any]]:
    from .process_sheets import material_in_map_for_planner_ps_ids

    sheet_rows = _load_mpp_planner_process_sheet_rows(con, fa_keys)
    if not sheet_rows:
        return []
    planner_ids = [compact_text(row.get("ps_id")) for row in sheet_rows if compact_text(row.get("ps_id"))]
    material_map = material_in_map_for_planner_ps_ids(con, planner_ids)
    for entry in sheet_rows:
        pid = compact_text(entry.get("ps_id"))
        entry["material_in"] = bool(material_map.get(pid))
    ctx = _build_intake_context(con, sheet_rows, mpp_codes)
    ctx.fa_mpp_by_part = load_frame_agreement_mpp_lookup(con)
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in sheet_rows:
        enriched = _enrich_entry_ops(con, dict(entry), ctx)
        _emit_jobs_from_item(enriched, ctx, jobs, seen)
    return jobs


def fetch_mpp_planner_jobs(con) -> list[dict[str, Any]]:
    """
    Outstanding frame-agreement process sheets with schedulable MPP ops.

    Only parts on the Frame Agreement Parts master list are included.
    """
    ensure_frame_agreement_schema(con)
    fa_keys = load_frame_agreement_part_keys(con)
    if not fa_keys:
        return []

    mpp_codes = mpp_machine_code_set(con)
    fa_mpp_lookup = load_frame_agreement_mpp_lookup(con)
    jobs = _mpp_jobs_from_process_sheets(con, fa_keys, mpp_codes)
    seen = {job["jobId"] for job in jobs}

    for row in _fetch_erp_mpp_job_candidates(con, mpp_machine_codes=mpp_codes):
        job_id = compact_text(row.get("jobId"))
        if not job_id or job_id in seen:
            continue
        seen.add(job_id)
        merged = dict(row)
        merged["source"] = "erp"
        part_key = normalize_part_key(merged.get("partNo") or merged.get("inventoryCode") or "")
        bom_code = compact_text(merged.get("bomCode") or "")
        op_no = compact_text(merged.get("opNo") or "")
        if not op_no:
            op_label = compact_text(merged.get("opLabel") or "")
            if op_label.upper().startswith("OP"):
                op_no = op_label[2:].split(" ", 1)[0].strip()
        apply_fa_mpp_overrides(merged, resolve_fa_mpp_settings(fa_mpp_lookup, part_key, bom_code, op_no))
        jobs.append(merged)

    jobs.sort(key=lambda j: (j.get("due") or "9999-12-31", j.get("psId") or "", j.get("opLabel") or ""))
    return jobs


def fetch_mpp_planner_intake_meta(con) -> dict[str, Any]:
    ensure_frame_agreement_schema(con)
    fa_keys = load_frame_agreement_part_keys(con)
    return {"frameAgreementPartCount": len(fa_keys)}
