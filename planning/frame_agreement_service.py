"""Frame agreement parts — master list for S/O flags and MPP planner intake."""
from __future__ import annotations

import logging
import re
from typing import Any, Callable

import psycopg2.extras

from .bom_materials import _list_bom_codes_with_counts, resolve_bom_materials
from .bom_operations import fetch_machining_operations, machining_op_counts_by_bom as erp_machining_op_counts
from .cycle_time_service import MasterTimeCache, resolve_step_times
from .helpers import one, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

_SCHEMA_READY = False
_PART_KEY_RE = re.compile(r"\s+")
_FA_MPP_MACHINE_CODES = frozenset({"CNC 35", "CNC 36", "CNC 41"})
_MPP_MACHINE_NOTE_RE = re.compile(r"\bCNC\s*3[561]\b", re.IGNORECASE)
FA_NORMAL_DAY_MINUTES = 630.0  # 10.5h weekday shift 08:30–20:00
FA_MPP_DAY_MINUTES = 1440.0  # 24h MPP coverage


def normalize_mpp_machine_no(value: Any) -> str:
    raw = compact_text(value).upper().replace("  ", " ")
    if raw in {code.upper() for code in _FA_MPP_MACHINE_CODES}:
        for code in _FA_MPP_MACHINE_CODES:
            if raw == code.upper():
                return code
    match = _MPP_MACHINE_NOTE_RE.search(compact_text(value))
    if not match:
        return ""
    token = re.sub(r"\s+", " ", match.group(0).upper())
    for code in _FA_MPP_MACHINE_CODES:
        if token.replace(" ", "") == code.replace(" ", ""):
            return code
    return ""


def parse_mpp_machine_from_notes(notes: str) -> str:
    return normalize_mpp_machine_no(notes)


def infer_fa_mpp_machine(description: str = "", notes: str = "") -> str:
    """Business defaults: valve body → CNC 36, end cap → CNC 35."""
    blob = f"{description} {notes}".upper()
    if "END CAP" in blob or "PISTON END CAP" in blob:
        return "CNC 35"
    if "VALVE BODY" in blob:
        return "CNC 36"
    parsed = parse_mpp_machine_from_notes(notes)
    if parsed:
        return parsed
    return parse_mpp_machine_from_notes(description)


def normalize_bom_key(bom_code: str) -> str:
    return compact_text(bom_code).upper()


def normalize_op_no(op_no: Any) -> str:
    raw = compact_text(op_no).upper()
    if raw.startswith("OP"):
        raw = raw[2:].strip()
    return raw


def fa_op_lookup_key(part_no: str, bom_code: str, op_no: Any) -> str:
    return f"{normalize_part_key(part_no)}::{normalize_bom_key(bom_code)}::{normalize_op_no(op_no)}"


def fa_mpp_lookup_key(part_no: str, bom_code: str = "", op_no: Any = "") -> str:
    op_key = normalize_op_no(op_no)
    if op_key:
        return fa_op_lookup_key(part_no, bom_code, op_key)
    return f"{normalize_part_key(part_no)}::{normalize_bom_key(bom_code)}"


def _derive_run_min_per_pallet(cycle_min_per_piece: float, pcs_per_pallet: float, run_min_per_pallet: float) -> float:
    if run_min_per_pallet > 0:
        return run_min_per_pallet
    if cycle_min_per_piece > 0 and pcs_per_pallet > 0:
        return cycle_min_per_piece * pcs_per_pallet
    return 0.0


def effective_fa_op_settings(row: dict[str, Any]) -> dict[str, Any]:
    cycle_pc = max(0.0, float(row.get("cycle_min_per_piece") or 0))
    pcs = max(0.0, float(row.get("pcs_per_pallet") or row.get("mpp_pcs_per_pallet") or 0))
    run_pallet = _derive_run_min_per_pallet(
        cycle_pc,
        pcs,
        max(0.0, float(row.get("run_min_per_pallet") or row.get("mpp_run_min_per_pallet") or 0)),
    )
    pallets = max(0.0, float(row.get("pallets_count") or row.get("mpp_pallets_per_cycle") or 0))
    machine = normalize_mpp_machine_no(row.get("mpp_machine_no"))
    if not machine:
        machine = infer_fa_mpp_machine(
            compact_text(row.get("description")),
            compact_text(row.get("notes")),
        )
    setup_min = max(0.0, float(row.get("setup_minutes") or row.get("mpp_setup_minutes") or 0))
    return {
        "part_no": compact_text(row.get("part_no")),
        "bom_code": compact_text(row.get("bom_code")),
        "op_no": normalize_op_no(row.get("op_no")),
        "stage_no": row.get("stage_no"),
        "stage_desc": compact_text(row.get("stage_desc")),
        "cycle_min_per_piece": cycle_pc,
        "pcs_per_pallet": pcs,
        "run_min_per_pallet": run_pallet,
        "pallets_count": pallets,
        "mpp_machine_no": machine,
        "setup_minutes": setup_min,
        "mpp_setup_minutes": setup_min,
        # MPP planner aliases
        "mpp_run_min_per_pallet": run_pallet,
        "mpp_pcs_per_pallet": pcs,
        "mpp_pallets_per_cycle": pallets,
    }


def effective_fa_mpp_settings(row: dict[str, Any]) -> dict[str, Any]:
    return effective_fa_op_settings(row)


def load_frame_agreement_mpp_by_part(con) -> dict[str, dict[str, Any]]:
    return load_frame_agreement_mpp_lookup(con)


def load_frame_agreement_mpp_lookup(con) -> dict[str, dict[str, Any]]:
    """FA MPP overrides keyed by part::bom::op (with part-level fallback)."""
    ensure_frame_agreement_schema(con)
    out: dict[str, dict[str, Any]] = {}
    for row in rows(
        con.execute(
            """
            SELECT part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes
            FROM planner_frame_agreement_part
            """
        )
    ):
        part_key = normalize_part_key(row.get("part_no"))
        if not part_key:
            continue
        settings = effective_fa_op_settings(dict(row))
        out[fa_mpp_lookup_key(row.get("part_no"), "")] = settings
        out[part_key] = settings
    for row in rows(
        con.execute(
            """
            SELECT part_no, bom_code, op_no, stage_no, stage_desc,
                   cycle_min_per_piece, pcs_per_pallet, run_min_per_pallet,
                   pallets_count, setup_minutes, mpp_machine_no
            FROM planner_frame_agreement_op_config
            """
        )
    ):
        if not normalize_op_no(row.get("op_no")):
            continue
        settings = effective_fa_op_settings(dict(row))
        out[fa_op_lookup_key(row.get("part_no"), row.get("bom_code"), row.get("op_no"))] = settings
    return out


def resolve_fa_mpp_settings(
    lookup: dict[str, dict[str, Any]],
    part_no: str,
    bom_code: str = "",
    op_no: Any = "",
) -> dict[str, Any] | None:
    part_key = normalize_part_key(part_no)
    if not part_key:
        return None
    op_key = normalize_op_no(op_no)
    bom_key = normalize_bom_key(bom_code)
    if op_key and bom_key:
        exact = lookup.get(fa_op_lookup_key(part_no, bom_code, op_key))
        if exact:
            return exact
    if bom_key:
        bom_only = lookup.get(fa_mpp_lookup_key(part_no, bom_code))
        if bom_only:
            return bom_only
    return lookup.get(fa_mpp_lookup_key(part_no, "")) or lookup.get(part_key)


def load_frame_agreement_op_configs(
    con, part_no: str, bom_code: str | None = None
) -> dict[str, dict[str, Any]]:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        return {}
    params: list[Any] = [part_no]
    bom_filter = ""
    if compact_text(bom_code):
        bom_filter = " AND bom_code = %s"
        params.append(compact_text(bom_code))
    out: dict[str, dict[str, Any]] = {}
    for row in rows(
        con.execute(
            f"""
            SELECT part_no, bom_code, op_no, stage_no, stage_desc,
                   cycle_min_per_piece, pcs_per_pallet, run_min_per_pallet,
                   pallets_count, setup_minutes, mpp_machine_no,
                   created_at, updated_at
            FROM planner_frame_agreement_op_config
            WHERE part_no = %s{bom_filter}
            ORDER BY bom_code, stage_no NULLS LAST, op_no
            """,
            tuple(params),
        )
    ):
        op_no = normalize_op_no(row.get("op_no"))
        if not op_no:
            continue
        out[op_no] = {
            **effective_fa_op_settings(dict(row)),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }
    return out


def load_frame_agreement_op_configs_batch(
    con, part_nos: list[str]
) -> dict[str, dict[str, dict[str, dict[str, Any]]]]:
    """part_no -> bom_code -> op_no -> config."""
    ensure_frame_agreement_schema(con)
    cleaned = [compact_text(p) for p in part_nos if compact_text(p)]
    if not cleaned:
        return {}
    out: dict[str, dict[str, dict[str, dict[str, Any]]]] = {part_no: {} for part_no in cleaned}
    for row in rows(
        con.execute(
            """
            SELECT part_no, bom_code, op_no, stage_no, stage_desc,
                   cycle_min_per_piece, pcs_per_pallet, run_min_per_pallet,
                   pallets_count, setup_minutes, mpp_machine_no,
                   created_at, updated_at
            FROM planner_frame_agreement_op_config
            WHERE part_no = ANY(%s)
            ORDER BY part_no, bom_code, stage_no NULLS LAST, op_no
            """,
            (cleaned,),
        )
    ):
        part_no = compact_text(row.get("part_no"))
        bom_code = compact_text(row.get("bom_code"))
        op_no = normalize_op_no(row.get("op_no"))
        if not part_no or not bom_code or not op_no:
            continue
        out.setdefault(part_no, {}).setdefault(bom_code, {})[op_no] = {
            **effective_fa_op_settings(dict(row)),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }
    return out


def upsert_frame_agreement_op_config(
    con,
    part_no: str,
    bom_code: str,
    op_no: Any,
    *,
    stage_no: int | None = None,
    stage_desc: str | None = None,
    cycle_min_per_piece: float | None = None,
    pcs_per_pallet: float | None = None,
    run_min_per_pallet: float | None = None,
    pallets_count: float | None = None,
    setup_minutes: float | None = None,
    mpp_machine_no: str | None = None,
) -> dict[str, Any]:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    bom_code = compact_text(bom_code)
    op_no_text = normalize_op_no(op_no)
    if not part_no:
        raise ValueError("part_no is required")
    if not bom_code:
        raise ValueError("bom_code is required")
    if not op_no_text:
        raise ValueError("op_no is required")
    existing = one(
        con.execute(
            """
            SELECT stage_no, stage_desc, cycle_min_per_piece, pcs_per_pallet,
                   run_min_per_pallet, pallets_count, setup_minutes, mpp_machine_no
            FROM planner_frame_agreement_op_config
            WHERE part_no = %s AND bom_code = %s AND op_no = %s
            """,
            (part_no, bom_code, op_no_text),
        )
    ) or {}
    stage_no_val = int(stage_no) if stage_no is not None else existing.get("stage_no")
    stage_desc_val = compact_text(stage_desc) if stage_desc is not None else compact_text(existing.get("stage_desc"))
    cycle_pc = (
        max(0.0, float(cycle_min_per_piece))
        if cycle_min_per_piece is not None
        else max(0.0, float(existing.get("cycle_min_per_piece") or 0))
    )
    pcs = (
        max(0.0, float(pcs_per_pallet))
        if pcs_per_pallet is not None
        else max(0.0, float(existing.get("pcs_per_pallet") or 0))
    )
    run_pallet = (
        max(0.0, float(run_min_per_pallet))
        if run_min_per_pallet is not None
        else max(0.0, float(existing.get("run_min_per_pallet") or 0))
    )
    if run_min_per_pallet is None and cycle_min_per_piece is not None and pcs > 0 and cycle_pc > 0:
        run_pallet = cycle_pc * pcs
    pallets = (
        max(0.0, float(pallets_count))
        if pallets_count is not None
        else max(0.0, float(existing.get("pallets_count") or 0))
    )
    setup = (
        max(0.0, float(setup_minutes))
        if setup_minutes is not None
        else max(0.0, float(existing.get("setup_minutes") or 0))
    )
    machine = (
        normalize_mpp_machine_no(mpp_machine_no)
        if mpp_machine_no is not None
        else normalize_mpp_machine_no(existing.get("mpp_machine_no"))
    )
    row = one(
        con.execute(
            """
            INSERT INTO planner_frame_agreement_op_config (
                part_no, bom_code, op_no, stage_no, stage_desc,
                cycle_min_per_piece, pcs_per_pallet, run_min_per_pallet,
                pallets_count, setup_minutes, mpp_machine_no, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (part_no, bom_code, op_no) DO UPDATE SET
                stage_no = EXCLUDED.stage_no,
                stage_desc = EXCLUDED.stage_desc,
                cycle_min_per_piece = EXCLUDED.cycle_min_per_piece,
                pcs_per_pallet = EXCLUDED.pcs_per_pallet,
                run_min_per_pallet = EXCLUDED.run_min_per_pallet,
                pallets_count = EXCLUDED.pallets_count,
                setup_minutes = EXCLUDED.setup_minutes,
                mpp_machine_no = EXCLUDED.mpp_machine_no,
                updated_at = NOW()
            RETURNING part_no, bom_code, op_no, stage_no, stage_desc,
                      cycle_min_per_piece, pcs_per_pallet, run_min_per_pallet,
                      pallets_count, setup_minutes, mpp_machine_no,
                      created_at, updated_at
            """,
            (
                part_no,
                bom_code,
                op_no_text,
                stage_no_val,
                stage_desc_val,
                cycle_pc,
                pcs,
                run_pallet,
                pallets,
                setup,
                machine,
            ),
        )
    )
    return {
        **effective_fa_op_settings(dict(row or {})),
        "created_at": (row or {}).get("created_at"),
        "updated_at": (row or {}).get("updated_at"),
    }


_BOM_STAGE_FILTER = """
      AND (
          s.stage_desc LIKE 'Turning%%'
       OR s.stage_desc LIKE 'Milling%%'
       OR s.stage_desc LIKE 'Turnmill%%'
      )
"""


def _resolve_machining_op_no(stage_desc: str, stage_no: Any, raw_op_no: Any = None) -> str:
    op = normalize_op_no(raw_op_no)
    if op:
        return op
    desc = compact_text(stage_desc)
    if desc:
        tail = re.search(r" (\d+)$", desc)
        if tail:
            op = normalize_op_no(tail.group(1))
            if op:
                return op
        parts = desc.split(None, 2)
        if len(parts) >= 2:
            op = normalize_op_no(parts[1])
            if op:
                return op
    stage = int(stage_no or 0)
    if stage > 0:
        return str(stage)
    return ""


def _normalize_machining_op_row(row: dict[str, Any]) -> dict[str, Any] | None:
    stage_no = row.get("stage_no")
    stage_desc = compact_text(row.get("stage_desc"))
    op_no = _resolve_machining_op_no(stage_desc, stage_no, row.get("op_no"))
    if not op_no:
        return None
    return {
        "stage_no": stage_no,
        "stage_desc": stage_desc,
        "op_no": op_no,
        "machine_no": compact_text(row.get("machine_no")),
        "setup_time": max(0.0, float(row.get("setup_time") or 0)),
        "cycle_time": max(0.0, float(row.get("cycle_time") or 0)),
    }


def _sort_machining_ops(ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def _key(row: dict[str, Any]) -> tuple[int, int, str]:
        op_no = compact_text(row.get("op_no"))
        try:
            return (0, int(op_no), op_no)
        except ValueError:
            return (1, int(row.get("stage_no") or 0), op_no)

    return sorted(ops, key=_key)


def machining_op_counts_by_bom(db_query: Callable, part_no: str) -> dict[str, int]:
    """BOM code -> machining stage count (same source as Steps modal)."""
    return erp_machining_op_counts(db_query, part_no)


def fetch_bom_machining_operations(db_query: Callable, part_no: str, bom_code: str) -> list[dict[str, Any]]:
    """Machining ops for FA MPP config — aligned with GET /api/bom/operations."""
    raw = fetch_machining_operations(db_query, part_no, bom_code)
    by_op: dict[str, dict[str, Any]] = {}
    for row in raw:
        normalized = _normalize_machining_op_row(row)
        if not normalized:
            continue
        op_key = normalized["op_no"]
        prev = by_op.get(op_key)
        if prev is None or int(normalized.get("stage_no") or 0) < int(prev.get("stage_no") or 0):
            by_op[op_key] = normalized
    return _sort_machining_ops(list(by_op.values()))


def build_fa_operation_line_items(
    db_query: Callable,
    con,
    part_row: dict[str, Any],
    bom_code: str,
) -> list[dict[str, Any]]:
    part_no = compact_text(part_row.get("part_no"))
    bom_code = compact_text(bom_code)
    if not part_no or not bom_code:
        return []
    ops = fetch_bom_machining_operations(db_query, part_no, bom_code)
    saved = load_frame_agreement_op_configs(con, part_no, bom_code)
    desc = compact_text(part_row.get("description"))
    notes = compact_text(part_row.get("notes"))
    default_machine = normalize_mpp_machine_no(part_row.get("mpp_machine_no")) or infer_fa_mpp_machine(desc, notes)
    line_items: list[dict[str, Any]] = []
    seen_ops: set[str] = set()

    def _append_line(op_no: str, op: dict[str, Any], config: dict[str, Any]) -> None:
        erp_machine = normalize_mpp_machine_no(op.get("machine_no"))
        cycle_pc = float(config.get("cycle_min_per_piece") or op.get("cycle_time") or 0)
        pcs = float(config.get("pcs_per_pallet") or 0)
        run_pallet = _derive_run_min_per_pallet(
            cycle_pc,
            pcs,
            float(config.get("run_min_per_pallet") or 0),
        )
        setup = float(
            config.get("setup_minutes")
            or config.get("mpp_setup_minutes")
            or op.get("setup_time")
            or 0
        )
        line_items.append(
            {
                "part_no": part_no,
                "bom_code": bom_code,
                "op_no": op_no,
                "stage_no": op.get("stage_no"),
                "stage_desc": compact_text(config.get("stage_desc")) or compact_text(op.get("stage_desc")),
                "cycle_min_per_piece": cycle_pc,
                "pcs_per_pallet": pcs,
                "run_min_per_pallet": run_pallet,
                "pallets_count": float(config.get("pallets_count") or 0),
                "setup_minutes": setup,
                "mpp_machine_no": compact_text(config.get("mpp_machine_no")) or erp_machine or default_machine,
                "updated_at": config.get("updated_at"),
            }
        )
        seen_ops.add(op_no)

    for op in ops:
        op_no = normalize_op_no(op.get("op_no"))
        if not op_no:
            continue
        _append_line(op_no, op, saved.get(op_no, {}))

    for op_no, config in saved.items():
        if op_no in seen_ops:
            continue
        _append_line(
            op_no,
            {
                "stage_no": config.get("stage_no"),
                "stage_desc": config.get("stage_desc"),
                "machine_no": config.get("mpp_machine_no"),
                "cycle_time": config.get("cycle_min_per_piece"),
                "setup_time": config.get("setup_minutes") or config.get("mpp_setup_minutes"),
            },
            config,
        )

    return _sort_machining_ops(line_items)


def apply_fa_mpp_overrides(job: dict[str, Any], fa_settings: dict[str, Any] | None) -> None:
    """Apply FA master run time + machine to an MPP planner job payload."""
    if not fa_settings:
        return
    machine = compact_text(fa_settings.get("mpp_machine_no"))
    if machine:
        job["preferredMachine"] = machine
    run_min = float(
        fa_settings.get("run_min_per_pallet")
        or fa_settings.get("mpp_run_min_per_pallet")
        or 0
    )
    if run_min > 0:
        job["minPerPallet"] = max(0.1, run_min)
    setup = float(fa_settings.get("setup_minutes") or fa_settings.get("mpp_setup_minutes") or 0)
    if setup > 0:
        job["setupMinutes"] = setup
    pcs = float(fa_settings.get("pcs_per_pallet") or fa_settings.get("mpp_pcs_per_pallet") or 0)
    if pcs > 0:
        job["pcsPerPallet"] = max(1, int(round(pcs)))
    pallets = float(fa_settings.get("pallets_count") or fa_settings.get("mpp_pallets_per_cycle") or 0)
    if pallets > 0:
        job["defaultPalletsPerCycle"] = max(1, int(round(pallets)))
    job["faMppMaster"] = True


def normalize_part_key(part_no: str) -> str:
    return _PART_KEY_RE.sub(" ", compact_text(part_no)).upper()


def compute_fg_per_day(available_min: float, total_cycle: float, total_setup: float) -> float | None:
    """Finished pieces / day = (available − setup) / cycle when cycle > 0."""
    cycle = float(total_cycle or 0)
    if cycle <= 0:
        return None
    available = float(available_min or 0)
    setup = max(0.0, float(total_setup or 0))
    return max(0.0, (available - setup) / cycle)


def build_normal_master_ops_for_bom(
    db_query: Callable,
    con,
    part_no: str,
    bom_code: str,
    *,
    master_cache: MasterTimeCache | None = None,
) -> dict[str, Any]:
    """Resolve machining ops against planner_cycle_time_master for Normal FA FG/day."""
    part_no = compact_text(part_no)
    bom_code = compact_text(bom_code)
    empty = {
        "bom_code": bom_code,
        "ops": [],
        "total_cycle": 0.0,
        "total_setup": 0.0,
        "fg_per_day": None,
        "master_hit_count": 0,
    }
    if not part_no or not bom_code:
        return empty

    cache = master_cache or MasterTimeCache.load(con)
    ops = fetch_bom_machining_operations(db_query, part_no, bom_code)
    master_ops: list[dict[str, Any]] = []
    total_cycle = 0.0
    total_setup = 0.0
    master_hit_count = 0

    for op in ops:
        op_no = normalize_op_no(op.get("op_no"))
        if not op_no:
            continue
        step = {
            "op_no": op_no,
            "op_type": compact_text(op.get("op_type")),
            "stage_no": op.get("stage_no"),
            "source_stage_no": op.get("stage_no"),
            "cycle_time": op.get("cycle_time") or 0,
            "setup_time": op.get("setup_time") or 0,
        }
        resolved = resolve_step_times(
            con,
            part_no=part_no,
            bom_code=bom_code,
            step=step,
            master_cache=cache,
        )
        cycle = float(resolved.get("cycle_time") or 0)
        setup = float(resolved.get("set_up_time") or 0)
        source = compact_text(resolved.get("source")) or "bom_step"
        master_id = resolved.get("master_id")
        if source == "master" and master_id:
            master_hit_count += 1
        if cycle > 0:
            total_cycle += cycle
        if setup > 0:
            total_setup += setup
        master_ops.append(
            {
                "op_no": op_no,
                "stage_no": op.get("stage_no"),
                "stage_desc": compact_text(op.get("stage_desc")),
                "op_type": compact_text(op.get("op_type")),
                "cycle_time": cycle,
                "set_up_time": setup,
                "ideal_cycle_time": float(resolved.get("ideal_cycle_time") or 0),
                "source": source,
                "master_id": master_id,
            }
        )

    return {
        "bom_code": bom_code,
        "ops": master_ops,
        "total_cycle": total_cycle,
        "total_setup": total_setup,
        "fg_per_day": compute_fg_per_day(FA_NORMAL_DAY_MINUTES, total_cycle, total_setup),
        "master_hit_count": master_hit_count,
    }


def ensure_frame_agreement_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_frame_agreement_part (
            part_no     TEXT         PRIMARY KEY,
            notes       TEXT         NOT NULL DEFAULT '',
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_frame_agreement_part_updated
            ON planner_frame_agreement_part (updated_at DESC)
        """
    )
    con.execute(
        """
        ALTER TABLE planner_frame_agreement_part
            ADD COLUMN IF NOT EXISTS mpp_machine_no TEXT NOT NULL DEFAULT ''
        """
    )
    con.execute(
        """
        ALTER TABLE planner_frame_agreement_part
            ADD COLUMN IF NOT EXISTS mpp_run_min_per_pallet NUMERIC NOT NULL DEFAULT 0
        """
    )
    con.execute(
        """
        ALTER TABLE planner_frame_agreement_part
            ADD COLUMN IF NOT EXISTS mpp_setup_minutes NUMERIC NOT NULL DEFAULT 0
        """
    )
    con.execute(
        """
        ALTER TABLE planner_frame_agreement_part
            ADD COLUMN IF NOT EXISTS deburring_cycle_min_per_piece NUMERIC NOT NULL DEFAULT 0
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_frame_agreement_bom_config (
            part_no                  TEXT         NOT NULL,
            bom_code                 TEXT         NOT NULL DEFAULT '',
            mpp_machine_no           TEXT         NOT NULL DEFAULT '',
            mpp_run_min_per_pallet   NUMERIC      NOT NULL DEFAULT 0,
            mpp_setup_minutes        NUMERIC      NOT NULL DEFAULT 0,
            mpp_pcs_per_pallet       NUMERIC      NOT NULL DEFAULT 0,
            mpp_pallets_per_cycle    NUMERIC      NOT NULL DEFAULT 0,
            created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (part_no, bom_code)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_fa_bom_config_part
            ON planner_frame_agreement_bom_config (part_no)
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_frame_agreement_op_config (
            part_no              TEXT         NOT NULL,
            bom_code             TEXT         NOT NULL DEFAULT '',
            op_no                TEXT         NOT NULL DEFAULT '',
            stage_no             INTEGER,
            stage_desc           TEXT         NOT NULL DEFAULT '',
            cycle_min_per_piece  NUMERIC      NOT NULL DEFAULT 0,
            pcs_per_pallet       NUMERIC      NOT NULL DEFAULT 0,
            run_min_per_pallet   NUMERIC      NOT NULL DEFAULT 0,
            pallets_count        NUMERIC      NOT NULL DEFAULT 0,
            setup_minutes        NUMERIC      NOT NULL DEFAULT 0,
            mpp_machine_no       TEXT         NOT NULL DEFAULT '',
            created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (part_no, bom_code, op_no)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_fa_op_config_part_bom
            ON planner_frame_agreement_op_config (part_no, bom_code)
        """
    )
    for stmt in (
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS stage_no INTEGER",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS stage_desc TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS cycle_min_per_piece NUMERIC NOT NULL DEFAULT 0",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS pcs_per_pallet NUMERIC NOT NULL DEFAULT 0",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS run_min_per_pallet NUMERIC NOT NULL DEFAULT 0",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS pallets_count NUMERIC NOT NULL DEFAULT 0",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS setup_minutes NUMERIC NOT NULL DEFAULT 0",
        "ALTER TABLE planner_frame_agreement_op_config ADD COLUMN IF NOT EXISTS mpp_machine_no TEXT NOT NULL DEFAULT ''",
    ):
        con.execute(stmt)
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_frame_agreement_normal_part (
            part_no     TEXT         PRIMARY KEY,
            notes       TEXT         NOT NULL DEFAULT '',
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_frame_agreement_normal_part_updated
            ON planner_frame_agreement_normal_part (updated_at DESC)
        """
    )
    con.execute(
        """
        ALTER TABLE planner_frame_agreement_normal_part
            ADD COLUMN IF NOT EXISTS deburring_cycle_min_per_piece NUMERIC NOT NULL DEFAULT 0
        """
    )
    _SCHEMA_READY = True


def _erp_query_dict(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]
    finally:
        release_conn(conn)


def _erp_query_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    hits = _erp_query_dict(sql, params)
    return hits[0] if hits else None


def _format_qty_per_fg(row: dict[str, Any]) -> str:
    from_api = row.get("qty_per_fg")
    if from_api is not None:
        try:
            val = float(from_api)
            if val > 0:
                return str(int(val)) if val == int(val) else f"{val:.4f}".rstrip("0").rstrip(".")
        except (TypeError, ValueError):
            pass
    try:
        parent = float(row.get("qty_parent") or 0)
        fg = float(row.get("qty_fg") or 0)
    except (TypeError, ValueError):
        return ""
    if parent <= 0:
        return ""
    if fg <= 0 or abs(parent - fg) < 1e-9:
        return str(int(parent)) if parent == int(parent) else f"{parent:.4f}".rstrip("0").rstrip(".")
    val = parent / fg
    return str(int(val)) if val == int(val) else f"{val:.4f}".rstrip("0").rstrip(".")


def _summarize_bom_materials(bom_rows: list[dict[str, Any]]) -> dict[str, str]:
    if not bom_rows:
        return {
            "primary_material": "",
            "primary_material_desc": "",
            "qty_per_fg": "",
            "material_count": "0",
        }
    primary = bom_rows[0]
    return {
        "primary_material": compact_text(primary.get("material_inventory_code")),
        "primary_material_desc": compact_text(primary.get("description")),
        "qty_per_fg": _format_qty_per_fg(primary),
        "material_count": str(len(bom_rows)),
    }


def search_frame_agreement_parts(db_query: Callable, search: str, *, limit: int = 25) -> list[dict[str, Any]]:
    """Search ERP inventory codes that have CNC BOM routes."""
    needle = compact_text(search)
    if not needle:
        return []
    like = f"%{needle}%"
    sql = f"""
        SELECT
            s.inventory_code AS part_no,
            COUNT(DISTINCT s.bom_code) AS bom_count,
            MAX(COALESCE(NULLIF(BTRIM(i.main_desc), ''), NULLIF(BTRIM(i.short_desc), ''), '')) AS description
        FROM public.mt_inventory_bom_stage s
        LEFT JOIN public.ic_inventory_enquiry_summary_view i
            ON i.inventory_code = s.inventory_code
        WHERE s.bom_code IS NOT NULL
        {_BOM_STAGE_FILTER}
          AND s.inventory_code ILIKE %s
        GROUP BY s.inventory_code
        ORDER BY s.inventory_code
        LIMIT %s
    """
    raw = db_query(sql, (like, limit), fetchall=True) or []
    out: list[dict[str, Any]] = []
    for row in raw:
        part_no = compact_text(row[0])
        if not part_no:
            continue
        out.append(
            {
                "part_no": part_no,
                "bom_count": int(row[1] or 0),
                "description": compact_text(row[2]),
            }
        )
    return out


def _build_bom_variants(
    db_query: Callable, part_no: str, bom_codes: list[str]
) -> list[dict[str, Any]]:
    op_counts = machining_op_counts_by_bom(db_query, part_no)
    variants: list[dict[str, Any]] = []
    for code in bom_codes:
        result = resolve_bom_materials(db_query, part_no, code)
        bom_rows = list(result.get("rows") or [])
        if code:
            filtered = [row for row in bom_rows if compact_text(row.get("bom_code")) == code]
            if filtered:
                bom_rows = filtered
        summary = _summarize_bom_materials(bom_rows)
        variants.append(
            {
                "bom_code": code,
                "primary_material": summary["primary_material"],
                "primary_material_desc": summary["primary_material_desc"],
                "qty_per_fg": summary["qty_per_fg"],
                "material_count": int(summary["material_count"] or 0),
                "machining_op_count": int(op_counts.get(code, 0)),
            }
        )
    return variants


def fetch_frame_agreement_part_preview(
    db_query: Callable, part_no: str, bom_code: str | None = None
) -> dict[str, Any]:
    """ERP snapshot for confirm modal — description, BOM, materials."""
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")

    inv = _erp_query_one(
        """
        SELECT
            inventory_code,
            main_desc,
            short_desc,
            inventory_class_code,
            total_qty_on_hand,
            total_qty_on_order,
            total_free_balance_qty
        FROM public.ic_inventory_enquiry_summary_view
        WHERE inventory_code = %s
        LIMIT 1
        """,
        (part_no,),
    )

    bom_codes_raw = db_query(
        f"""
        SELECT DISTINCT bom_code
        FROM public.mt_inventory_bom_stage s
        WHERE inventory_code = %s
          AND bom_code IS NOT NULL
          {_BOM_STAGE_FILTER}
        ORDER BY bom_code
        """,
        (part_no,),
        fetchall=True,
    ) or []
    stage_codes = [compact_text(row[0]) for row in bom_codes_raw if compact_text(row[0])]
    listing_codes = [code for code, _count in _list_bom_codes_with_counts(db_query, part_no)]
    bom_codes = sorted(set(stage_codes + listing_codes))
    selected_bom = compact_text(bom_code) or (bom_codes[0] if bom_codes else "")

    bom_result = resolve_bom_materials(db_query, part_no, selected_bom or None)
    bom_rows = list(bom_result.get("rows") or [])
    if selected_bom:
        filtered = [row for row in bom_rows if compact_text(row.get("bom_code")) == selected_bom]
        if filtered:
            bom_rows = filtered
    summary = _summarize_bom_materials(bom_rows)
    bom_variants = _build_bom_variants(db_query, part_no, bom_codes) if bom_codes else []

    description = compact_text(inv.get("main_desc") if inv else "")
    if not description and inv:
        description = compact_text(inv.get("short_desc"))

    active_bom = (
        selected_bom
        or compact_text(bom_result.get("resolved_bom_code"))
        or (bom_codes[0] if bom_codes else "")
    )

    return {
        "part_no": part_no,
        "description": description,
        "inventory_class": compact_text(inv.get("inventory_class_code") if inv else ""),
        "stock_on_hand": float(inv.get("total_qty_on_hand") or 0) if inv else None,
        "stock_on_order": float(inv.get("total_qty_on_order") or 0) if inv else None,
        "stock_free_balance": float(inv.get("total_free_balance_qty") or 0) if inv else None,
        "bom_codes": bom_codes,
        "bom_variants": bom_variants,
        "bom_code": active_bom,
        "materials": bom_rows,
        "material_count": len(bom_rows),
        "primary_material": summary["primary_material"],
        "primary_material_desc": summary["primary_material_desc"],
        "qty_per_fg": summary["qty_per_fg"],
        "match_mode": compact_text(bom_result.get("match_mode")),
        "notice": compact_text(bom_result.get("notice")),
    }


def enrich_frame_agreement_part(db_query: Callable, row: dict[str, Any]) -> dict[str, Any]:
    """Attach ERP summary fields to a stored frame-agreement row."""
    part_no = compact_text(row.get("part_no"))
    if not part_no:
        return row
    try:
        preview = fetch_frame_agreement_part_preview(db_query, part_no)
    except Exception as exc:
        logger.warning("frame agreement enrich failed for %s: %s", part_no, exc)
        return {
            **row,
            "description": "",
            "bom_code": "",
            "primary_material": "",
            "qty_per_fg": "",
            "material_count": 0,
            "enrich_error": str(exc),
        }
    return {
        **row,
        "description": preview.get("description") or "",
        "bom_codes": preview.get("bom_codes") or [],
        "bom_variants": preview.get("bom_variants") or [],
        "bom_code": preview.get("bom_code") or "",
        "primary_material": preview.get("primary_material") or "",
        "primary_material_desc": preview.get("primary_material_desc") or "",
        "qty_per_fg": preview.get("qty_per_fg") or "",
        "material_count": preview.get("material_count") or 0,
        "inventory_class": preview.get("inventory_class") or "",
    }


def serialize_part_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    part_no = compact_text(row.get("part_no"))
    if not part_no:
        return None
    out = {
        "part_no": part_no,
        "notes": compact_text(row.get("notes")),
        "mpp_machine_no": normalize_mpp_machine_no(row.get("mpp_machine_no"))
        or infer_fa_mpp_machine(compact_text(row.get("description")), compact_text(row.get("notes"))),
        "mpp_run_min_per_pallet": max(0.0, float(row.get("mpp_run_min_per_pallet") or 0)),
        "mpp_setup_minutes": max(0.0, float(row.get("mpp_setup_minutes") or 0)),
        "mpp_pcs_per_pallet": max(0.0, float(row.get("mpp_pcs_per_pallet") or 0)),
        "mpp_pallets_per_cycle": max(0.0, float(row.get("mpp_pallets_per_cycle") or 0)),
        "deburring_cycle_min_per_piece": max(
            0.0, float(row.get("deburring_cycle_min_per_piece") or 0)
        ),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    op_configs = row.get("op_configs")
    if isinstance(op_configs, dict):
        out["op_configs"] = op_configs
    for key in (
        "description",
        "bom_code",
        "bom_codes",
        "bom_variants",
        "primary_material",
        "primary_material_desc",
        "qty_per_fg",
        "material_count",
        "inventory_class",
    ):
        if key in row:
            out[key] = row.get(key)
    return out


def list_frame_agreement_parts(con, *, search: str = "") -> list[dict[str, Any]]:
    ensure_frame_agreement_schema(con)
    q = compact_text(search).lower()
    if q:
        like = f"%{q}%"
        raw = rows(
            con.execute(
                """
                SELECT part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                       deburring_cycle_min_per_piece, created_at, updated_at
                FROM planner_frame_agreement_part
                WHERE LOWER(part_no) LIKE %s OR LOWER(notes) LIKE %s
                ORDER BY part_no
                """,
                (like, like),
            )
        )
    else:
        raw = rows(
            con.execute(
                """
                SELECT part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                       deburring_cycle_min_per_piece, created_at, updated_at
                FROM planner_frame_agreement_part
                ORDER BY part_no
                """
            )
        )
    part_nos = [compact_text(row.get("part_no")) for row in raw if compact_text(row.get("part_no"))]
    op_configs_by_part = load_frame_agreement_op_configs_batch(con, part_nos)
    out = []
    for row in raw:
        part_no = compact_text(row.get("part_no"))
        serialized = serialize_part_row({**dict(row), "op_configs": op_configs_by_part.get(part_no, {})})
        if serialized:
            out.append(serialized)
    return out


def load_frame_agreement_mpp_part_keys(con) -> set[str]:
    """Keys for MPP FA master list only (MPP planner intake)."""
    ensure_frame_agreement_schema(con)
    keys: set[str] = set()
    for row in rows(con.execute("SELECT part_no FROM planner_frame_agreement_part")):
        key = normalize_part_key(row.get("part_no"))
        if key:
            keys.add(key)
    return keys


def load_frame_agreement_normal_part_keys(con) -> set[str]:
    """Keys for Normal (non-MPP) FA master list only."""
    ensure_frame_agreement_schema(con)
    keys: set[str] = set()
    for row in rows(con.execute("SELECT part_no FROM planner_frame_agreement_normal_part")):
        key = normalize_part_key(row.get("part_no"))
        if key:
            keys.add(key)
    return keys


def load_frame_agreement_part_keys(con) -> set[str]:
    """Union of MPP + Normal FA part keys — used for S/O and pending-PP FA badges."""
    return load_frame_agreement_mpp_part_keys(con) | load_frame_agreement_normal_part_keys(con)


def is_frame_agreement_part(part_no: str, keys: set[str] | None = None) -> bool:
    key = normalize_part_key(part_no)
    if not key or not keys:
        return False
    return key in keys


def serialize_normal_part_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    part_no = compact_text(row.get("part_no"))
    if not part_no:
        return None
    out = {
        "part_no": part_no,
        "notes": compact_text(row.get("notes")),
        "deburring_cycle_min_per_piece": max(
            0.0, float(row.get("deburring_cycle_min_per_piece") or 0)
        ),
        "lane": "normal",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    for key in (
        "description",
        "bom_code",
        "bom_codes",
        "bom_variants",
        "primary_material",
        "primary_material_desc",
        "qty_per_fg",
        "material_count",
        "inventory_class",
        "master_ops_by_bom",
        "master_ops",
        "total_cycle",
        "total_setup",
        "fg_per_day",
        "master_hit_count",
        "fg_totals_by_bom",
        "enrich_error",
    ):
        if key in row:
            out[key] = row.get(key)
    return out


def list_frame_agreement_normal_parts(con, *, search: str = "") -> list[dict[str, Any]]:
    ensure_frame_agreement_schema(con)
    q = compact_text(search).lower()
    if q:
        like = f"%{q}%"
        raw = rows(
            con.execute(
                """
                SELECT part_no, notes, deburring_cycle_min_per_piece, created_at, updated_at
                FROM planner_frame_agreement_normal_part
                WHERE LOWER(part_no) LIKE %s OR LOWER(notes) LIKE %s
                ORDER BY part_no
                """,
                (like, like),
            )
        )
    else:
        raw = rows(
            con.execute(
                """
                SELECT part_no, notes, deburring_cycle_min_per_piece, created_at, updated_at
                FROM planner_frame_agreement_normal_part
                ORDER BY part_no
                """
            )
        )
    out = []
    for row in raw:
        serialized = serialize_normal_part_row(dict(row))
        if serialized:
            out.append(serialized)
    return out


def _lookup_frame_agreement_normal_part_row(con, part_no: str) -> dict[str, Any] | None:
    part_no = compact_text(part_no)
    if not part_no:
        return None
    row = one(
        con.execute(
            """
            SELECT part_no, notes, deburring_cycle_min_per_piece, created_at, updated_at
            FROM planner_frame_agreement_normal_part
            WHERE part_no = %s
            """,
            (part_no,),
        )
    )
    if row:
        return dict(row)
    return one(
        con.execute(
            """
            SELECT part_no, notes, deburring_cycle_min_per_piece, created_at, updated_at
            FROM planner_frame_agreement_normal_part
            WHERE UPPER(TRIM(part_no)) = UPPER(TRIM(%s))
            """,
            (part_no,),
        )
    )


def add_frame_agreement_normal_part(
    con,
    part_no: str,
    *,
    notes: str = "",
    deburring_cycle_min_per_piece: float = 0,
) -> dict[str, Any]:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")
    notes = compact_text(notes)
    deburr = max(0.0, float(deburring_cycle_min_per_piece or 0))
    row = one(
        con.execute(
            """
            INSERT INTO planner_frame_agreement_normal_part (
                part_no, notes, deburring_cycle_min_per_piece, updated_at
            )
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (part_no) DO UPDATE SET
                notes = EXCLUDED.notes,
                deburring_cycle_min_per_piece = EXCLUDED.deburring_cycle_min_per_piece,
                updated_at = NOW()
            RETURNING part_no, notes, deburring_cycle_min_per_piece, created_at, updated_at
            """,
            (part_no, notes, deburr),
        )
    )
    return serialize_normal_part_row(row) or {
        "part_no": part_no,
        "notes": notes,
        "deburring_cycle_min_per_piece": deburr,
        "lane": "normal",
    }


def update_frame_agreement_normal_part(
    con,
    part_no: str,
    *,
    notes: str | None = None,
    deburring_cycle_min_per_piece: float | None = None,
) -> dict[str, Any] | None:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")
    existing = _lookup_frame_agreement_normal_part_row(con, part_no)
    if not existing:
        raise ValueError("Part not found")
    part_no = compact_text(existing.get("part_no")) or part_no
    updates: list[str] = []
    params: list[Any] = []
    if notes is not None:
        updates.append("notes = %s")
        params.append(compact_text(notes))
    if deburring_cycle_min_per_piece is not None:
        updates.append("deburring_cycle_min_per_piece = %s")
        params.append(max(0.0, float(deburring_cycle_min_per_piece)))
    if not updates:
        return serialize_normal_part_row(existing)
    updates.append("updated_at = NOW()")
    params.append(part_no)
    row = one(
        con.execute(
            f"""
            UPDATE planner_frame_agreement_normal_part
            SET {", ".join(updates)}
            WHERE part_no = %s
            RETURNING part_no, notes, deburring_cycle_min_per_piece, created_at, updated_at
            """,
            tuple(params),
        )
    )
    return serialize_normal_part_row(row)


def delete_frame_agreement_normal_part(con, part_no: str) -> bool:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        return False
    cur = con.execute(
        "DELETE FROM planner_frame_agreement_normal_part WHERE part_no = %s",
        (part_no,),
    )
    return bool(getattr(cur, "rowcount", 0))


def enrich_frame_agreement_normal_part(
    db_query: Callable,
    con,
    row: dict[str, Any],
    *,
    master_cache: MasterTimeCache | None = None,
) -> dict[str, Any]:
    """ERP enrich + master cycle resolve for Normal FA rows."""
    base = enrich_frame_agreement_part(db_query, row)
    part_no = compact_text(base.get("part_no"))
    if not part_no:
        return serialize_normal_part_row(base) or base

    bom_codes = [compact_text(c) for c in (base.get("bom_codes") or []) if compact_text(c)]
    if not bom_codes:
        primary = compact_text(base.get("bom_code"))
        if primary:
            bom_codes = [primary]

    cache = master_cache or MasterTimeCache.load(con)
    master_ops_by_bom: dict[str, list[dict[str, Any]]] = {}
    totals_by_bom: dict[str, dict[str, Any]] = {}
    for bom in bom_codes:
        resolved = build_normal_master_ops_for_bom(
            db_query, con, part_no, bom, master_cache=cache
        )
        master_ops_by_bom[bom] = resolved["ops"]
        totals_by_bom[bom] = {
            "total_cycle": resolved["total_cycle"],
            "total_setup": resolved["total_setup"],
            "fg_per_day": resolved["fg_per_day"],
            "master_hit_count": resolved["master_hit_count"],
        }

    selected_bom = compact_text(base.get("bom_code")) or (bom_codes[0] if bom_codes else "")
    selected = totals_by_bom.get(selected_bom) or {
        "total_cycle": 0.0,
        "total_setup": 0.0,
        "fg_per_day": None,
        "master_hit_count": 0,
    }
    enriched = {
        **base,
        "lane": "normal",
        "master_ops_by_bom": master_ops_by_bom,
        "master_ops": master_ops_by_bom.get(selected_bom) or [],
        "total_cycle": selected["total_cycle"],
        "total_setup": selected["total_setup"],
        "fg_per_day": selected["fg_per_day"],
        "master_hit_count": selected["master_hit_count"],
        "fg_totals_by_bom": totals_by_bom,
    }
    return serialize_normal_part_row(enriched) or enriched


def add_frame_agreement_part(
    con,
    part_no: str,
    *,
    notes: str = "",
    mpp_machine_no: str = "",
    mpp_run_min_per_pallet: float = 0,
    mpp_setup_minutes: float = 0,
    deburring_cycle_min_per_piece: float = 0,
    description: str = "",
) -> dict[str, Any]:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")
    notes = compact_text(notes)
    machine = normalize_mpp_machine_no(mpp_machine_no) or infer_fa_mpp_machine(description, notes)
    run_min = max(0.0, float(mpp_run_min_per_pallet or 0))
    setup_min = max(0.0, float(mpp_setup_minutes or 0))
    deburr = max(0.0, float(deburring_cycle_min_per_piece or 0))
    row = one(
        con.execute(
            """
            INSERT INTO planner_frame_agreement_part (
                part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                deburring_cycle_min_per_piece, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (part_no) DO UPDATE SET
                notes = EXCLUDED.notes,
                mpp_machine_no = EXCLUDED.mpp_machine_no,
                mpp_run_min_per_pallet = EXCLUDED.mpp_run_min_per_pallet,
                mpp_setup_minutes = EXCLUDED.mpp_setup_minutes,
                deburring_cycle_min_per_piece = EXCLUDED.deburring_cycle_min_per_piece,
                updated_at = NOW()
            RETURNING part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                      deburring_cycle_min_per_piece, created_at, updated_at
            """,
            (part_no, notes, machine, run_min, setup_min, deburr),
        )
    )
    return serialize_part_row(row) or {
        "part_no": part_no,
        "notes": notes,
        "mpp_machine_no": machine,
        "mpp_run_min_per_pallet": run_min,
        "mpp_setup_minutes": setup_min,
        "deburring_cycle_min_per_piece": deburr,
    }


def _lookup_frame_agreement_part_row(con, part_no: str) -> dict[str, Any] | None:
    part_no = compact_text(part_no)
    if not part_no:
        return None
    row = one(
        con.execute(
            """
            SELECT part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                   deburring_cycle_min_per_piece, created_at, updated_at
            FROM planner_frame_agreement_part
            WHERE part_no = %s
            """,
            (part_no,),
        )
    )
    if row:
        return dict(row)
    return one(
        con.execute(
            """
            SELECT part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                   deburring_cycle_min_per_piece, created_at, updated_at
            FROM planner_frame_agreement_part
            WHERE UPPER(TRIM(part_no)) = UPPER(TRIM(%s))
            """,
            (part_no,),
        )
    )


def update_frame_agreement_part(
    con,
    part_no: str,
    *,
    notes: str | None = None,
    bom_code: str | None = None,
    op_no: Any = None,
    stage_no: int | None = None,
    stage_desc: str | None = None,
    cycle_min_per_piece: float | None = None,
    pcs_per_pallet: float | None = None,
    run_min_per_pallet: float | None = None,
    pallets_count: float | None = None,
    setup_minutes: float | None = None,
    mpp_machine_no: str | None = None,
    mpp_run_min_per_pallet: float | None = None,
    mpp_setup_minutes: float | None = None,
    mpp_pcs_per_pallet: float | None = None,
    mpp_pallets_per_cycle: float | None = None,
    deburring_cycle_min_per_piece: float | None = None,
) -> dict[str, Any] | None:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")

    existing_part = _lookup_frame_agreement_part_row(con, part_no)
    if not existing_part:
        raise ValueError("Part not found")
    part_no = compact_text(existing_part.get("part_no")) or part_no

    op_config_saved: dict[str, Any] | None = None
    if compact_text(bom_code) and normalize_op_no(op_no):
        op_config_saved = upsert_frame_agreement_op_config(
            con,
            part_no,
            compact_text(bom_code),
            op_no,
            stage_no=stage_no,
            stage_desc=stage_desc,
            cycle_min_per_piece=cycle_min_per_piece,
            pcs_per_pallet=pcs_per_pallet if pcs_per_pallet is not None else mpp_pcs_per_pallet,
            run_min_per_pallet=run_min_per_pallet
            if run_min_per_pallet is not None
            else mpp_run_min_per_pallet,
            pallets_count=pallets_count if pallets_count is not None else mpp_pallets_per_cycle,
            setup_minutes=setup_minutes if setup_minutes is not None else mpp_setup_minutes,
            mpp_machine_no=mpp_machine_no,
        )

    updates: list[str] = []
    params: list[Any] = []
    if notes is not None:
        updates.append("notes = %s")
        params.append(compact_text(notes))
    if mpp_machine_no is not None:
        updates.append("mpp_machine_no = %s")
        params.append(normalize_mpp_machine_no(mpp_machine_no))
    if mpp_run_min_per_pallet is not None:
        updates.append("mpp_run_min_per_pallet = %s")
        params.append(max(0.0, float(mpp_run_min_per_pallet)))
    if mpp_setup_minutes is not None:
        updates.append("mpp_setup_minutes = %s")
        params.append(max(0.0, float(mpp_setup_minutes)))
    if deburring_cycle_min_per_piece is not None:
        updates.append("deburring_cycle_min_per_piece = %s")
        params.append(max(0.0, float(deburring_cycle_min_per_piece)))
    if not updates and op_config_saved is None:
        raise ValueError("No fields to update")
    row = None
    if updates:
        updates.append("updated_at = NOW()")
        params.append(part_no)
        row = one(
            con.execute(
                f"""
                UPDATE planner_frame_agreement_part
                SET {", ".join(updates)}
                WHERE part_no = %s
                RETURNING part_no, notes, mpp_machine_no, mpp_run_min_per_pallet, mpp_setup_minutes,
                          deburring_cycle_min_per_piece, created_at, updated_at
                """,
                tuple(params),
            )
        )
    else:
        row = dict(existing_part)
    if not row:
        return None
    serialized = serialize_part_row(
        {**dict(row), "op_configs": load_frame_agreement_op_configs_batch(con, [part_no]).get(part_no, {})}
    )
    if op_config_saved and serialized:
        serialized["saved_op_config"] = op_config_saved
        serialized["saved_bom_code"] = compact_text(bom_code)
        serialized["saved_op_no"] = normalize_op_no(op_no)
    return serialized


def delete_frame_agreement_part(con, part_no: str) -> bool:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        return False
    con.execute(
        "DELETE FROM planner_frame_agreement_op_config WHERE part_no = %s",
        (part_no,),
    )
    con.execute(
        "DELETE FROM planner_frame_agreement_bom_config WHERE part_no = %s",
        (part_no,),
    )
    cur = con.execute(
        "DELETE FROM planner_frame_agreement_part WHERE part_no = %s",
        (part_no,),
    )
    return bool(getattr(cur, "rowcount", 0))


def apply_frame_agreement_flags(orders: list[dict[str, Any]], keys: set[str]) -> None:
    if not keys:
        return
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            pp_code = compact_text(pp.get("inventory_code"))
            pp["is_frame_agreement"] = is_frame_agreement_part(pp_code, keys)
            for partial in pp.get("partials") or []:
                partial_code = compact_text(partial.get("inventory_code")) or pp_code
                partial["is_frame_agreement"] = is_frame_agreement_part(partial_code, keys)


_MPP_JOBS_SQL = """
WITH fa AS (
    SELECT
        TRIM(part_no) AS part_no,
        notes,
        TRIM(COALESCE(mpp_machine_no, '')) AS mpp_machine_no,
        COALESCE(mpp_run_min_per_pallet, 0) AS mpp_run_min_per_pallet,
        COALESCE(mpp_setup_minutes, 0) AS mpp_setup_minutes
    FROM planner_frame_agreement_part
),
fa_op AS (
    SELECT
        TRIM(part_no) AS part_no,
        TRIM(COALESCE(bom_code, '')) AS bom_code,
        TRIM(COALESCE(op_no, '')) AS op_no,
        TRIM(COALESCE(mpp_machine_no, '')) AS mpp_machine_no,
        COALESCE(cycle_min_per_piece, 0) AS cycle_min_per_piece,
        COALESCE(pcs_per_pallet, 0) AS pcs_per_pallet,
        COALESCE(run_min_per_pallet, 0) AS run_min_per_pallet,
        COALESCE(setup_minutes, 0) AS setup_minutes,
        COALESCE(pallets_count, 0) AS pallets_count
    FROM planner_frame_agreement_op_config
),
partials AS (
    SELECT
        c.ps_id,
        c.pp_partial_no,
        MAX(TRIM(c.part_no)) AS part_no,
        MAX(TRIM(COALESCE(c.description, ''))) AS part_desc,
        MAX(NULLIF(TRIM(c.bom_code), '')) AS bom_code,
        MIN(c.due_date) AS due_date,
        MAX(COALESCE(c.partial_qty, c.total_qty, 0)) AS qty,
        MAX(COALESCE(c.status, '')) AS status,
        MAX(COALESCE(c.qty_shipped, 0)) AS qty_shipped
    FROM pp_vouchers_cache c
    INNER JOIN fa ON UPPER(TRIM(c.part_no)) = UPPER(fa.part_no)
    WHERE COALESCE(NULLIF(TRIM(c.ps_id), ''), '') <> ''
      AND COALESCE(NULLIF(TRIM(c.part_no), ''), '') <> ''
      AND (
            UPPER(TRIM(COALESCE(c.status, ''))) IN ('O', 'OUTSTANDING')
         OR (
                UPPER(TRIM(COALESCE(c.status, ''))) NOT IN ('HISTORY', 'H', 'COMPLETE', 'COMPLETED', 'CLOSED')
            AND COALESCE(c.partial_qty, c.total_qty, 0) > COALESCE(c.qty_shipped, 0)
         )
      )
    GROUP BY c.ps_id, c.pp_partial_no
    HAVING MAX(COALESCE(c.partial_qty, c.total_qty, 0)) > 0
),
mpp_steps AS (
    SELECT
        bv.inventory_code AS part_no,
        TRIM(COALESCE(bv.bom_code, '')) AS bom_code,
        os.op_seq_id,
        os.seq_no,
        os.op_no,
        os.op_type,
        os.machine_category,
        os.preferred_machine
    FROM planner_operation_seq os
    JOIN planner_bom_variation bv ON bv.bom_id = os.bom_id
    WHERE UPPER(COALESCE(os.machine_category, '')) = 'MPP'
       OR UPPER(TRIM(COALESCE(os.preferred_machine, ''))) IN (
            SELECT UPPER(TRIM(machine_no))
            FROM planner_machines
            WHERE COALESCE(active, TRUE) = TRUE
              AND UPPER(COALESCE(machine_category, '')) = 'MPP'
            UNION
            SELECT 'CNC 41'
       )
),
ctm AS (
    SELECT
        TRIM(part_no) AS part_no,
        TRIM(COALESCE(bom_code, '')) AS bom_code,
        op_no,
        stage_name,
        op_type,
        MAX(COALESCE(cycle_time, ideal_cycle_time, 0)) AS cycle_time
    FROM planner_cycle_time_master
    GROUP BY TRIM(part_no), TRIM(COALESCE(bom_code, '')), op_no, stage_name, op_type
)
SELECT
    p.ps_id,
    p.pp_partial_no,
    p.part_no,
    p.part_desc,
    p.bom_code,
    p.due_date,
    p.qty,
    p.status,
    m.op_seq_id,
    m.seq_no,
    m.op_no,
    m.op_type,
    m.machine_category,
    COALESCE(NULLIF(TRIM(fa_op.mpp_machine_no), ''), NULLIF(TRIM(fa.mpp_machine_no), ''), m.preferred_machine) AS preferred_machine,
    COALESCE(
        NULLIF(fa_op.run_min_per_pallet, 0),
        CASE
            WHEN COALESCE(fa_op.cycle_min_per_piece, 0) > 0 AND COALESCE(fa_op.pcs_per_pallet, 0) > 0
            THEN fa_op.cycle_min_per_piece * fa_op.pcs_per_pallet
            ELSE 0
        END,
        NULLIF(fa.mpp_run_min_per_pallet, 0),
        ct.cycle_time,
        0
    ) AS cycle_time,
    COALESCE(NULLIF(fa_op.setup_minutes, 0), NULLIF(fa.mpp_setup_minutes, 0), 0) AS setup_minutes,
    COALESCE(NULLIF(fa_op.pcs_per_pallet, 0), 0) AS mpp_pcs_per_pallet,
    COALESCE(NULLIF(fa_op.pallets_count, 0), 0) AS mpp_pallets_per_cycle,
    COALESCE(ct.stage_name, '') AS stage_name,
    COALESCE(erp.erp_acc_qty, 0) AS erp_acc_qty,
    COALESCE(erp.erp_req_qty, 0) AS erp_req_qty
FROM partials p
JOIN fa ON UPPER(TRIM(fa.part_no)) = UPPER(TRIM(p.part_no))
JOIN mpp_steps m
  ON UPPER(TRIM(m.part_no)) = UPPER(TRIM(p.part_no))
 AND (
        TRIM(COALESCE(m.bom_code, '')) = ''
     OR TRIM(COALESCE(p.bom_code, '')) = ''
     OR TRIM(m.bom_code) = TRIM(p.bom_code)
 )
LEFT JOIN fa_op
  ON UPPER(TRIM(fa_op.part_no)) = UPPER(TRIM(p.part_no))
 AND TRIM(fa_op.bom_code) = TRIM(COALESCE(p.bom_code, ''))
 AND TRIM(fa_op.op_no) = TRIM(COALESCE(m.op_no::text, ''))
LEFT JOIN ctm ct
  ON UPPER(TRIM(ct.part_no)) = UPPER(TRIM(p.part_no))
 AND (
        TRIM(COALESCE(ct.bom_code, '')) = ''
     OR TRIM(COALESCE(p.bom_code, '')) = ''
     OR TRIM(ct.bom_code) = TRIM(p.bom_code)
 )
 AND (
        ct.op_no IS NULL
     OR m.op_no IS NULL
     OR ct.op_no::TEXT = m.op_no::TEXT
 )
LEFT JOIN LATERAL (
    SELECT
        MAX(COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced, 0)) AS erp_acc_qty,
        MAX(COALESCE(ws.wo_qty_required, c.wo_qty_required, 0)) AS erp_req_qty
    FROM pp_vouchers_cache c
    LEFT JOIN mfg_wo_status ws
           ON ws.source_mps_no = c.ps_id
          AND ws.pp_partial_no = c.pp_partial_no
          AND ws.stage_no = c.stage_no
          AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
    WHERE c.ps_id = p.ps_id
      AND c.pp_partial_no = p.pp_partial_no
      AND (
            TRIM(COALESCE(c.op_no::text, '')) = TRIM(COALESCE(m.op_no::text, ''))
         OR (
                TRIM(COALESCE(c.op_no::text, '')) <> ''
            AND TRIM(COALESCE(m.op_no::text, '')) <> ''
            AND LTRIM(UPPER(TRIM(COALESCE(c.op_no::text, ''))), 'OP')
                = LTRIM(UPPER(TRIM(COALESCE(m.op_no::text, ''))), 'OP')
         )
         OR c.stage_no::text = TRIM(COALESCE(m.op_no::text, ''))
      )
) erp ON TRUE
ORDER BY p.due_date NULLS LAST, p.ps_id, m.seq_no
"""


def _op_label(op_no: Any, op_type: str, stage_name: str) -> str:
    op_no_text = compact_text(op_no)
    op_type_text = compact_text(op_type)
    stage_text = compact_text(stage_name)
    if op_no_text and op_type_text:
        return f"OP{op_no_text} {op_type_text} {op_no_text}".strip()
    if stage_text:
        return stage_text
    if op_type_text:
        return op_type_text
    return "MPP op"


def fetch_mpp_job_candidates(con, *, mpp_machine_codes: set[str] | None = None) -> list[dict[str, Any]]:
    """Open frame-agreement jobs with MPP routing — ERP fallback for MPP planner."""
    ensure_frame_agreement_schema(con)
    keys = load_frame_agreement_part_keys(con)
    if not keys:
        return []

    raw_rows = rows(con.execute(_MPP_JOBS_SQL))
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in raw_rows:
        ps_id = compact_text(row.get("ps_id"))
        op_seq_id = int(row.get("op_seq_id") or 0)
        if not ps_id or op_seq_id <= 0:
            continue
        job_id = f"{ps_id.lower()}::p{int(row.get('pp_partial_no') or 1)}::op{compact_text(row.get('op_no')) or op_seq_id}"
        if job_id in seen:
            continue
        seen.add(job_id)

        part_no = compact_text(row.get("part_no"))
        op_label = _op_label(row.get("op_no"), row.get("op_type"), row.get("stage_name"))
        cycle_time = float(row.get("cycle_time") or 0)
        min_per_pallet = max(1, int(round(cycle_time))) if cycle_time > 0 else 90
        setup_minutes = max(0.0, float(row.get("setup_minutes") or 0))
        pcs_per_pallet = max(1, int(round(float(row.get("mpp_pcs_per_pallet") or 0)))) if float(row.get("mpp_pcs_per_pallet") or 0) > 0 else 1
        pallets_per_cycle = max(1, int(round(float(row.get("mpp_pallets_per_cycle") or 0)))) if float(row.get("mpp_pallets_per_cycle") or 0) > 0 else 1
        wo_qty = float(row.get("erp_req_qty") or row.get("qty") or 0)
        erp_acc = max(0.0, float(row.get("erp_acc_qty") or 0))
        remaining = max(0.0, wo_qty - erp_acc) if wo_qty > 0 else 0.0

        jobs.append(
            {
                "jobId": job_id,
                "sourcePsId": ps_id,
                "psId": ps_id,
                "ppPartialNo": int(row.get("pp_partial_no") or 1),
                "opSeqId": op_seq_id,
                "partNo": part_no,
                "partDesc": compact_text(row.get("part_desc")),
                "opLabel": op_label,
                "opNo": normalize_op_no(row.get("op_no")),
                "minPerPallet": min_per_pallet,
                "setupMinutes": setup_minutes,
                "pcsPerPallet": pcs_per_pallet,
                "defaultPalletsPerCycle": pallets_per_cycle,
                "qty": wo_qty or remaining,
                "out": erp_acc,
                "remainingQty": remaining,
                "requiredQty": wo_qty,
                "erpFinished": erp_acc,
                "plannedQty": 0,
                "schedulable": remaining > 0,
                "blockedReason": "" if remaining > 0 else ("ERP complete" if erp_acc > 0 else ""),
                "due": compact_text(row.get("due_date")),
                "bomCode": compact_text(row.get("bom_code")),
                "preferredMachine": compact_text(row.get("preferred_machine")),
                "machineCategory": compact_text(row.get("machine_category")) or "MPP",
                "status": compact_text(row.get("status")),
                "isFrameAgreement": True,
                "faMppMaster": bool(cycle_time > 0 or setup_minutes > 0 or compact_text(row.get("preferred_machine"))),
            }
        )
    return jobs
