"""Join pp_vouchers_cache with mfg_wo_status for authoritative per-partial WO fields."""

from __future__ import annotations

import re

from planning.utils import compact_text, op_production_complete

# Post-machining stages live in mfg_wo_status but are omitted from pp_voucher BOM rows.
FINISHING_STAGE_DESCS = frozenset({
    "Deburring",
    "Final Inspection",
    "Packing",
    "Engraving & Packing",
    "Packing & Engraving",
})

MATERIAL_ISSUE_ASSEMBLY_STAGE_DESC = "Material Issue & Assembly"

# ERP sometimes stores the abbreviated "Final Insp" (and a "Final Ispection" typo).
_FINAL_INSPECTION_RE = re.compile(r"^final\s+(?:insp|ispection)", re.IGNORECASE)

_FINISHING_STAGE_PATTERNS = (
    re.compile(r"^deburring$", re.IGNORECASE),
    _FINAL_INSPECTION_RE,
    re.compile(r"^packing$", re.IGNORECASE),
    re.compile(r"engraving.*packing|packing.*engraving", re.IGNORECASE),
)


def finishing_final_inspection_sql_match(column: str) -> str:
    """SQL: Final Inspection plus ERP abbreviations/typos (Final Insp, Final Ispection)."""
    return (
        f"{column} ILIKE 'Final Insp%%' "
        f"OR {column} ILIKE 'Final Ispection%%'"
    )


def finishing_stage_sql_match(column: str) -> str:
    """SQL predicate: deburr / inspect / pack / combined pack+engrave (either word order)."""
    final_insp = finishing_final_inspection_sql_match(f"TRIM(COALESCE({column}, ''))")
    return f"""(
           TRIM(COALESCE({column}, '')) = ANY(%s)
        OR TRIM(COALESCE({column}, '')) = 'Deburring'
        OR TRIM(COALESCE({column}, '')) = 'Final Inspection'
        OR TRIM(COALESCE({column}, '')) = 'Packing'
        OR {final_insp}
        OR {column} ILIKE 'Engraving%%Packing%%'
        OR {column} ILIKE 'Packing%%Engraving%%'
    )"""


def finishing_pack_stage_sql_match(column: str) -> str:
    """SQL predicate: packing or combined pack+engrave stage only."""
    return f"""(
           TRIM(COALESCE({column}, '')) = 'Packing'
        OR TRIM(COALESCE({column}, '')) IN ('Engraving & Packing', 'Packing & Engraving')
        OR {column} ILIKE 'Engraving%%Packing%%'
        OR {column} ILIKE 'Packing%%Engraving%%'
    )"""


_ASSEMBLY_STAGE_WORD = re.compile(r"(?:^|[^a-z])assembly(?:[^a-z]|$)", re.IGNORECASE)


def material_issue_assembly_stage_sql_match(column: str) -> str:
    """SQL predicate: WO stage description contains the word assembly."""
    return f"({column} ~* '(^|[^a-z])assembly([^a-z]|$)')"


def is_material_issue_assembly_stage_desc(stage_desc: str) -> bool:
    text = compact_text(stage_desc)
    if not text:
        return False
    return bool(_ASSEMBLY_STAGE_WORD.search(text))


def is_final_inspection_stage_desc(stage_desc: str) -> bool:
    """True for Final Inspection and ERP aliases such as 'Final Insp'."""
    text = compact_text(stage_desc)
    return bool(text) and bool(_FINAL_INSPECTION_RE.search(text))


def is_finishing_stage_desc(stage_desc: str) -> bool:
    text = compact_text(stage_desc)
    if not text:
        return False
    if text in FINISHING_STAGE_DESCS:
        return True
    lowered = text.casefold()
    if any(known.casefold() == lowered for known in FINISHING_STAGE_DESCS):
        return True
    return any(pattern.search(text) for pattern in _FINISHING_STAGE_PATTERNS)


def filter_wo_stages_for_main_partial(wo_stages, main_qty):
    """Drop rework/satellite WOs (e.g. qty-3 reject lines) from the main ERP PS view."""
    try:
        main_qty = float(main_qty or 0)
    except (TypeError, ValueError):
        main_qty = 0.0
    if main_qty <= 0:
        return list(wo_stages or [])
    kept = []
    for row in wo_stages or []:
        try:
            req = float(row.get("wo_qty_required") or 0)
        except (TypeError, ValueError):
            req = 0.0
        if req <= 0 or req >= main_qty - 0.0001:
            kept.append(row)
            continue
        stage_desc = compact_text(row.get("stage_desc"))
        # Reject/rework WOs belong on [Temp] PS — keep them off the source line.
        if is_finishing_stage_desc(stage_desc) or req <= main_qty * 0.25:
            continue
        kept.append(row)
    return kept


def finishing_stage_bucket(stage_desc: str) -> str:
    text = compact_text(stage_desc)
    lowered = text.casefold()
    if lowered == "deburring":
        return "deburring"
    if is_final_inspection_stage_desc(text):
        return "final_inspection"
    if "engraving" in lowered and "packing" in lowered:
        return "engraving_packing"
    if lowered == "packing":
        return "packing"
    return "other"

MFG_WO_STATUS_STAGE_JOIN = """
       ON ws.source_mps_no = c.ps_id
      AND ws.pp_partial_no = c.pp_partial_no
      AND ws.stage_no = c.stage_no
      AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
"""

ERP_STAGE_OUTPUTS_CTE = """
    erp_stage_outputs AS (
        SELECT c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc,
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
        WHERE c.stage_no IS NOT NULL
        GROUP BY c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc
    )
"""

PP_VOUCHERS_CACHE_DIRECT_FROM = """
FROM pp_vouchers_cache c
"""

PP_VOUCHERS_CACHE_DIRECT_SELECT = """
    c.ps_id,
    c.pp_partial_no,
    c.part_no,
    c.description,
    c.total_qty,
    c.partial_qty,
    c.due_date,
    c.order_date,
    c.bom_code,
    c.source_voucher_no,
    c.source_line_item_no,
    c.customer_po_no,
    c.qty_shipped,
    c.so_det_qty,
    c.status,
    c.execution_status,
    c.wo_qty_required,
    c.wo_qty_produced,
    c.wo_qty_rejected,
    c.stage_no,
    c.stage_desc,
    c.op_no,
    c.current_stage_no,
    c.current_stage_desc,
    c.current_stage_status
"""

PP_VOUCHERS_CACHE_WO_MERGE_FROM = """
FROM pp_vouchers_cache c
LEFT JOIN mfg_wo_status ws
       ON ws.source_mps_no = c.ps_id
      AND ws.pp_partial_no = c.pp_partial_no
      AND ws.stage_no = c.stage_no
      AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
"""

PP_VOUCHERS_CACHE_WO_MERGE_SELECT = """
    c.ps_id,
    c.pp_partial_no,
    c.part_no,
    c.description,
    c.total_qty,
    c.partial_qty,
    c.due_date,
    c.order_date,
    c.bom_code,
    c.source_voucher_no,
    c.source_line_item_no,
    c.customer_po_no,
    c.qty_shipped,
    c.so_det_qty,
    c.status,
    COALESCE(NULLIF(TRIM(ws.execution_status), ''), c.execution_status) AS execution_status,
    COALESCE(ws.wo_qty_required, c.wo_qty_required) AS wo_qty_required,
    COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced) AS wo_qty_produced,
    COALESCE(ws.total_rej_qty_produced, c.wo_qty_rejected) AS wo_qty_rejected,
    c.stage_no,
    c.stage_desc,
    c.op_no,
    c.current_stage_no,
    c.current_stage_desc,
    c.current_stage_status
"""

ERP_CACHE_STEPS_SELECT = """
    SELECT c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc, c.op_no,
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
"""

ERP_CACHE_STEPS_WHERE_PARTIALS = """
    WHERE (c.ps_id, c.pp_partial_no) IN ({values_sql})
      AND NULLIF(TRIM(COALESCE(c.stage_desc, '')), '') IS NOT NULL
    GROUP BY c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc, c.op_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no, c.op_no
"""

ERP_CACHE_STEPS_WHERE_SINGLE = """
    WHERE c.ps_id = %s
      AND c.pp_partial_no = %s
      AND NULLIF(TRIM(COALESCE(c.stage_desc, '')), '') IS NOT NULL
    GROUP BY c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc, c.op_no
    ORDER BY c.stage_no, c.op_no
"""


def normalize_op_no_key(op_no) -> str:
    text = compact_text(op_no)
    if text.upper().startswith("OP"):
        return text[2:].lstrip()
    return text


def voucher_erp_qty_maps_for_partial(con, source_ps_id, pp_partial_no) -> tuple[
    dict[str, float], dict[int, float], dict[str, str], dict[int, str]
]:
    """ERP accepted/required qty and execution status per op_no and stage_no for one PS partial."""
    from planning.helpers import rows

    source_ps_id = compact_text(source_ps_id)
    if not source_ps_id:
        return {}, {}, {}, {}
    try:
        pp_partial_no = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1

    by_op: dict[str, float] = {}
    by_stage: dict[int, float] = {}
    status_by_op: dict[str, str] = {}
    status_by_stage: dict[int, str] = {}
    for row in rows(
        con.execute(
            ERP_CACHE_STEPS_SELECT + ERP_CACHE_STEPS_WHERE_SINGLE,
            (source_ps_id, pp_partial_no),
        )
    ):
        op_no = compact_text(row.get("op_no")) or (
            str(int(row.get("stage_no") or 0)) if int(row.get("stage_no") or 0) else ""
        )
        stage_no = int(row.get("stage_no") or 0)
        produced = max(0.0, float(row.get("wo_qty_produced") or 0))
        status = compact_text(row.get("execution_status") or "")
        for key in {op_no, normalize_op_no_key(op_no)}:
            if key:
                by_op[key] = max(by_op.get(key, 0.0), produced)
                if status:
                    status_by_op[key] = status
        if stage_no:
            by_stage[stage_no] = max(by_stage.get(stage_no, 0.0), produced)
            if status:
                status_by_stage[stage_no] = status
    return by_op, by_stage, status_by_op, status_by_stage


def erp_exec_status_for_op(
    status_by_op: dict[str, str],
    status_by_stage: dict[int, str],
    *,
    op_no,
    source_stage_no: int = 0,
) -> str:
    for key in {compact_text(op_no), normalize_op_no_key(op_no)}:
        if key and key in status_by_op:
            return status_by_op[key]
    return status_by_stage.get(int(source_stage_no or 0), "")


def erp_accepted_qty_for_op(
    erp_by_op: dict[str, float],
    erp_by_stage: dict[int, float],
    *,
    op_no,
    source_stage_no: int = 0,
) -> float:
    for key in {compact_text(op_no), normalize_op_no_key(op_no)}:
        if key and key in erp_by_op:
            return erp_by_op[key]
    return erp_by_stage.get(int(source_stage_no or 0), 0.0)


def _normalize_execution_status(value) -> str:
    return compact_text(value).upper().replace("-", "_").replace(" ", "_")


def _execution_status_rank(value) -> int:
    normalized = _normalize_execution_status(value)
    ranks = {
        "I": 0,
        "IN_PROCESS": 0,
        "R": 1,
        "READY_TO_START": 1,
        "P": 2,
        "PENDING_SI": 2,
    }
    return ranks.get(normalized, 3)


def _execution_status_completed(value) -> bool:
    return _normalize_execution_status(value) in {"C", "COMPLETED"}


def mfg_wo_stages_batch(con, partial_keys) -> dict[tuple[str, int], list[dict]]:
    """Fetch all mfg_wo_status stages for many (source_ps_id, pp_partial_no) pairs."""
    from planning.helpers import rows

    keys: list[tuple[str, int]] = []
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

    grouped: dict[tuple[str, int], list[dict]] = {}
    chunk_size = 200
    for start in range(0, len(keys), chunk_size):
        chunk = keys[start : start + chunk_size]
        values_sql = ", ".join(["(%s, %s)"] * len(chunk))
        params = [part for pair in chunk for part in pair]
        for row in rows(
            con.execute(
                f"""
                SELECT source_mps_no, pp_partial_no, stage_no, stage_desc,
                       execution_status, wo_qty_required,
                       total_acc_qty_produced, total_rej_qty_produced
                FROM mfg_wo_status
                WHERE (source_mps_no, pp_partial_no) IN ({values_sql})
                  AND NULLIF(TRIM(COALESCE(stage_desc, '')), '') IS NOT NULL
                ORDER BY source_mps_no, pp_partial_no, stage_no, stage_desc
                """,
                params,
            )
        ):
            cache_key = (compact_text(row.get("source_mps_no")), int(row.get("pp_partial_no") or 1))
            grouped.setdefault(cache_key, []).append(dict(row))
    return grouped


def _wo_stage_row_to_flow_step(row, seq_no: int) -> dict:
    stage_desc = compact_text(row.get("stage_desc"))
    stage_no = int(row.get("stage_no") or 0)
    finishing = is_finishing_stage_desc(stage_desc)
    op_type = stage_desc if finishing else (stage_desc.split()[0] if stage_desc else "")
    return {
        "op_seq_id": stage_no or seq_no,
        "seq_no": seq_no,
        "op_no": str(stage_no) if stage_no else str(seq_no),
        "op_type": op_type,
        "stage_desc": stage_desc,
        "machine_category": "FINISHING" if finishing else op_type.upper(),
        "source_kind": "ERP_WO" if finishing else "",
        "preferred_machine": "",
        "cycle_time": 0,
        "setup_time": 0,
        "is_last_op": 0,
        "source_stage_no": stage_no,
        "erp_required_qty": row.get("wo_qty_required"),
        "erp_finished_qty": row.get("total_acc_qty_produced"),
        "erp_reject_qty": row.get("total_rej_qty_produced"),
        "erp_execution_status": row.get("execution_status"),
    }


def merge_finishing_steps_into_flow_steps(steps, wo_stages) -> list:
    """Append post-machining WO stages from mfg_wo_status when absent from BOM flow."""
    existing = {
        compact_text(step.get("stage_desc") or step.get("op_type") or "")
        for step in (steps or [])
    }
    merged = list(steps or [])
    next_seq = max((int(step.get("seq_no") or 0) for step in merged), default=0) + 1
    for row in sorted(wo_stages or [], key=lambda item: int(item.get("stage_no") or 0)):
        stage_desc = compact_text(row.get("stage_desc"))
        if not is_finishing_stage_desc(stage_desc) or stage_desc in existing:
            continue
        merged.append(_wo_stage_row_to_flow_step(row, next_seq))
        next_seq += 1
        existing.add(stage_desc)
    merged.sort(
        key=lambda step: (
            int(step.get("source_stage_no") or 0),
            int(step.get("seq_no") or 0),
        )
    )
    return merged


def _wo_stage_to_op_card(row, entry: dict) -> dict:
    stage_desc = compact_text(row.get("stage_desc"))
    stage_no = int(row.get("stage_no") or 0)
    row_execution_status = row.get("execution_status") or ""
    required_qty = float(row.get("wo_qty_required") or 0)
    produced_qty = float(row.get("total_acc_qty_produced") or 0)
    rejected_qty = float(row.get("total_rej_qty_produced") or 0)
    display_qty = float(
        entry.get("display_qty") or entry.get("partial_qty") or entry.get("total_qty") or 0
    )
    qty = display_qty if display_qty > 0 else required_qty
    stage_required = qty if qty > 0 else required_qty
    stage_produced = min(
        max(0.0, produced_qty),
        stage_required if stage_required > 0 else produced_qty,
    )
    stage_rejected = min(
        max(0.0, rejected_qty),
        stage_required if stage_required > 0 else rejected_qty,
    )
    remaining_qty = max(0.0, qty - stage_produced) if qty > 0 else 0.0
    op_no = str(stage_no) if stage_no else stage_desc
    machine_group = stage_desc.split()[0].upper() if stage_desc else ""
    return {
        "card_kind": "single",
        "card_id": None,
        "ps_id": entry.get("ps_id"),
        "operation_label": op_no,
        "operation_name": stage_desc,
        "op_type": stage_desc,
        "stage_no": stage_no,
        "stage_desc": stage_desc,
        "execution_status": row_execution_status,
        "target_qty": qty,
        "required_qty": stage_required,
        "wo_qty_required": stage_required,
        "wo_qty_produced": stage_produced,
        "wo_qty_rejected": stage_rejected,
        "qty_shipped": float(entry.get("qty_shipped") or 0),
        "planned_qty": 0.0,
        "finished_qty": stage_produced,
        "reject_qty": stage_rejected,
        "remaining_qty": remaining_qty,
        "source_ps_id": entry.get("source_ps_id") or entry.get("ps_id"),
        "source_op_seq_id": stage_no,
        "source_op_no": op_no,
        "part_no": entry.get("part_no") or "",
        "job_no": entry.get("ps_id"),
        "planning_status": "UNSCHEDULED",
        "card_type": "SINGLE",
        "is_scheduled": False,
        "setup_minutes": 180.0,
        "cycle_minutes_per_qty": 20.0,
        "compatible_machine_group": machine_group,
    }


def merge_finishing_op_cards_into_entry(entry: dict, wo_stages) -> None:
    """Attach finishing WO stages to pp-voucher catalog ops when BOM cache omits them."""
    existing = {
        compact_text(op.get("stage_desc") or op.get("op_type") or op.get("operation_name") or "")
        for op in (entry.get("ops") or [])
    }
    for row in sorted(wo_stages or [], key=lambda item: int(item.get("stage_no") or 0)):
        stage_desc = compact_text(row.get("stage_desc"))
        if not is_finishing_stage_desc(stage_desc) or stage_desc in existing:
            continue
        op_card = _wo_stage_to_op_card(row, entry)
        entry.setdefault("ops", []).append(op_card)
        entry.setdefault("op_cards", []).append(op_card)
        existing.add(stage_desc)


def resolve_current_stage_from_wo_stages(wo_stages, *, shipped_completed: bool = False) -> dict | None:
    """Pick active WO stage; when all stages are done but not shipped, surface finishing."""
    if not wo_stages:
        return None

    open_stages = [
        row
        for row in wo_stages
        if not _execution_status_completed(row.get("execution_status"))
    ]
    if open_stages:
        active = sorted(
            open_stages,
            key=lambda row: (
                _execution_status_rank(row.get("execution_status")),
                int(row.get("stage_no") or 0),
            ),
        )[0]
        return {
            "current_stage_no": int(active.get("stage_no") or 0) or None,
            "current_stage_desc": compact_text(active.get("stage_desc") or ""),
            "current_stage_status": compact_text(active.get("execution_status") or ""),
        }

    if shipped_completed:
        return None

    finishing = [
        row
        for row in wo_stages
        if is_finishing_stage_desc(row.get("stage_desc"))
    ]
    if not finishing:
        return None

    latest = max(finishing, key=lambda row: int(row.get("stage_no") or 0))
    return {
        "current_stage_no": int(latest.get("stage_no") or 0) or None,
        "current_stage_desc": compact_text(latest.get("stage_desc") or ""),
        "current_stage_status": compact_text(latest.get("execution_status") or ""),
    }


def apply_wo_current_stage(entry: dict, wo_stages) -> None:
    """Fill current_stage_* from mfg_wo_status when the cache view has no open stage."""
    if compact_text(entry.get("current_stage_desc")):
        return
    shipped_completed = bool(entry.get("shipped_completed"))
    resolved = resolve_current_stage_from_wo_stages(
        wo_stages,
        shipped_completed=shipped_completed,
    )
    if not resolved:
        return
    entry["current_stage_no"] = resolved.get("current_stage_no")
    entry["current_stage_desc"] = resolved.get("current_stage_desc") or ""
    entry["current_stage_status"] = resolved.get("current_stage_status") or ""


def wo_stages_all_complete(wo_stages) -> bool:
    if not wo_stages:
        return False
    tracked = []
    for row in wo_stages:
        required = float(row.get("wo_qty_required") or 0)
        finished = float(row.get("total_acc_qty_produced") or row.get("wo_qty_produced") or 0)
        status = compact_text(row.get("execution_status") or "")
        if required > 0.0001 or finished > 0.0001 or status:
            tracked.append(row)
    if not tracked:
        return False
    return all(
        op_production_complete(
            {
                "required_qty": float(row.get("wo_qty_required") or 0),
                "finished_qty": float(row.get("total_acc_qty_produced") or row.get("wo_qty_produced") or 0),
                "remaining_qty": max(
                    0.0,
                    float(row.get("wo_qty_required") or 0)
                    - float(row.get("total_acc_qty_produced") or row.get("wo_qty_produced") or 0),
                ),
                "execution_status": row.get("execution_status") or "",
            }
        )
        for row in tracked
    )


def apply_wo_stage_metadata(entry: dict, wo_stages) -> None:
    """Attach current_stage_* and ERP completion flags — never add finishing stages to ops."""
    apply_wo_current_stage(entry, wo_stages)
    entry["erp_wo_stage_count"] = len(wo_stages or [])
    entry["erp_all_wo_complete"] = wo_stages_all_complete(wo_stages)


def apply_wo_stage_metadata_to_voucher_entries(entries, con) -> None:
    """Resolve current stage from mfg_wo_status; attach finishing op cards when missing."""
    if not entries:
        return
    keys = []
    seen = set()
    for entry in entries:
        source = compact_text(entry.get("source_ps_id") or "")
        if not source:
            ps_id = compact_text(entry.get("ps_id") or "")
            source = ps_id.split("::", 1)[0] if ps_id else ""
        partial = int(entry.get("pp_partial_no") or 1)
        key = (source, partial)
        if source and key not in seen:
            keys.append(key)
            seen.add(key)
    wo_cache = mfg_wo_stages_batch(con, keys)
    for entry in entries:
        source = compact_text(entry.get("source_ps_id") or "")
        if not source:
            ps_id = compact_text(entry.get("ps_id") or "")
            source = ps_id.split("::", 1)[0] if ps_id else ""
        partial = int(entry.get("pp_partial_no") or 1)
        wo_stages = wo_cache.get((source, partial), [])
        apply_wo_stage_metadata(entry, wo_stages)
        merge_finishing_op_cards_into_entry(entry, wo_stages)


# Backward-compatible alias — metadata + finishing op cards for PP sidebar.
merge_finishing_stages_into_voucher_entries = apply_wo_stage_metadata_to_voucher_entries
