"""MPP planner live queue — persist cycles and sync planner_run_block lanes."""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

from .helpers import one, rows
from .mpp_planner_service import (
    MPP_DEFAULT_LOAD_MIN_PER_PALLET,
    MPP_DEFAULT_UNLOAD_MIN_PER_PALLET,
    fetch_mpp_planner_machines,
    mpp_machine_slug,
)
from .process_sheets import (
    ensure_planner_process_sheet,
    format_planner_ps_id,
    normalize_standard_ps_id,
    parse_planner_ps_id,
)
from .utils import compact_text, parse_number

logger = logging.getLogger(__name__)

_SCHEMA_READY = False
_VALID_SHIFTS = frozenset({"day", "night"})


def ensure_mpp_queue_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_mpp_lane (
            machine_id        BIGINT       PRIMARY KEY REFERENCES planner_machines(machine_id) ON DELETE CASCADE,
            lane_anchor       TIMESTAMPTZ,
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_mpp_cycle (
            cycle_id          BIGSERIAL    PRIMARY KEY,
            client_cycle_id   TEXT         NOT NULL UNIQUE,
            machine_id        BIGINT       NOT NULL REFERENCES planner_machines(machine_id) ON DELETE CASCADE,
            queue_index       INTEGER      NOT NULL DEFAULT 0,
            shift             TEXT         NOT NULL DEFAULT 'night',
            anchor_datetime   TIMESTAMPTZ,
            cycle_label       TEXT         NOT NULL DEFAULT '',
            group_id          BIGINT       REFERENCES planner_run_block_group(group_id) ON DELETE SET NULL,
            created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_mpp_cycle_machine
            ON planner_mpp_cycle (machine_id, queue_index)
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_mpp_cycle_op (
            cycle_op_id       BIGSERIAL    PRIMARY KEY,
            client_op_id      TEXT         NOT NULL UNIQUE,
            cycle_id          BIGINT       NOT NULL REFERENCES planner_mpp_cycle(cycle_id) ON DELETE CASCADE,
            block_id          BIGINT       REFERENCES planner_run_block(block_id) ON DELETE SET NULL,
            job_id            TEXT         NOT NULL,
            source_ps_id      TEXT         NOT NULL DEFAULT '',
            source_op_seq_id  BIGINT       NOT NULL DEFAULT 0,
            source_op_no      TEXT         NOT NULL DEFAULT '',
            pp_partial_no     INTEGER      NOT NULL DEFAULT 1,
            pallet_count      INTEGER      NOT NULL DEFAULT 1,
            min_per_pallet    NUMERIC      NOT NULL DEFAULT 90,
            pcs_per_pallet    NUMERIC      NOT NULL DEFAULT 1,
            created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_mpp_cycle_op_cycle
            ON planner_mpp_cycle_op (cycle_id)
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_mpp_job_override (
            job_id            TEXT         PRIMARY KEY,
            min_per_pallet    NUMERIC      NOT NULL DEFAULT 90,
            pcs_per_pallet    NUMERIC      NOT NULL DEFAULT 1,
            qty               NUMERIC      NOT NULL DEFAULT 0,
            out_qty           NUMERIC      NOT NULL DEFAULT 0,
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_mpp_probation_op (
            probation_op_id   BIGSERIAL    PRIMARY KEY,
            client_entry_id   TEXT         NOT NULL UNIQUE,
            machine_id        BIGINT       NOT NULL REFERENCES planner_machines(machine_id) ON DELETE CASCADE,
            queue_index       INTEGER      NOT NULL DEFAULT 0,
            job_id            TEXT         NOT NULL,
            source_ps_id      TEXT         NOT NULL DEFAULT '',
            source_op_seq_id  BIGINT       NOT NULL DEFAULT 0,
            source_op_no      TEXT         NOT NULL DEFAULT '',
            pp_partial_no     INTEGER      NOT NULL DEFAULT 1,
            pallet_count      INTEGER      NOT NULL DEFAULT 1,
            shift             TEXT         NOT NULL DEFAULT 'night',
            note              TEXT         NOT NULL DEFAULT '',
            created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_mpp_probation_machine
            ON planner_mpp_probation_op (machine_id, queue_index)
        """
    )
    # Column adds live in migrations/ (add_mpp_job_timing_overrides.sql, add_mpp_cycle_timing.sql).
    # Avoid runtime ALTER here — it can block on Supabase and stall concurrent queue saves.
    _SCHEMA_READY = True


def _configure_mpp_save_session(con) -> None:
    """Longer timeouts for queue sync; lock_timeout fails fast instead of waiting the full statement budget."""
    import os

    ms = int(os.getenv("MPP_QUEUE_SAVE_TIMEOUT_MS", os.getenv("PLANNER_STATEMENT_TIMEOUT_MS", "120000")))
    lock_ms = int(os.getenv("MPP_QUEUE_LOCK_TIMEOUT_MS", "15000"))
    con.execute(f"SET LOCAL statement_timeout = '{ms}'")
    con.execute(f"SET LOCAL lock_timeout = '{lock_ms}'")


def _recover_db_transaction(con) -> None:
    """Clear a failed PostgreSQL transaction so follow-up queries can run."""
    try:
        con.rollback()
    except Exception:
        pass


def _machine_id_by_slug(con, slug: str) -> int:
    slug_key = compact_text(slug).lower()
    for machine in fetch_mpp_planner_machines(con):
        if machine["id"] == slug_key:
            return int(machine.get("machineId") or 0)
    return 0


def _slug_by_machine_id(con, machine_id: int) -> str:
    for machine in fetch_mpp_planner_machines(con):
        if int(machine.get("machineId") or 0) == int(machine_id):
            return machine["id"]
    return ""


def _parse_anchor_text(value: Any) -> datetime | None:
    raw = compact_text(value)
    if not raw:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw.replace("T", " "))
    except ValueError:
        return None


def _anchor_to_api(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    return compact_text(value)


def _normalize_shift(shift: Any) -> str:
    raw = compact_text(shift).lower()
    return raw if raw in _VALID_SHIFTS else "night"


def _cycle_fingerprint(cycle: dict[str, Any]) -> str:
    shift = _normalize_shift(cycle.get("shift"))
    parts = sorted(
        f"{compact_text(op.get('jobId'))}:{max(1, int(op.get('palletCount') or 1))}"
        for op in (cycle.get("ops") or [])
        if compact_text(op.get("jobId"))
    )
    return f"{shift}::{'|'.join(parts)}"


def _job_load_min_per_cycle(job_row: dict[str, Any]) -> float:
    raw = job_row.get("loadMinPerCycle")
    if raw is None:
        raw = job_row.get("loadMinPerPallet")
    if raw is None:
        raw = job_row.get("load_min_per_pallet")
    return max(0.0, parse_number(raw, MPP_DEFAULT_LOAD_MIN_PER_PALLET))


def _job_unload_min_per_cycle(job_row: dict[str, Any]) -> float:
    raw = job_row.get("unloadMinPerCycle")
    if raw is None:
        raw = job_row.get("unloadMinPerPallet")
    if raw is None:
        raw = job_row.get("unload_min_per_pallet")
    return max(0.0, parse_number(raw, MPP_DEFAULT_UNLOAD_MIN_PER_PALLET))


def _cycle_timing_from_payload(cycle: dict[str, Any]) -> dict[str, Any]:
    load_raw = cycle.get("loadMinPerCycle")
    if load_raw is None:
        load_raw = cycle.get("loadMinPerPallet")
    unload_raw = cycle.get("unloadMinPerCycle")
    if unload_raw is None:
        unload_raw = cycle.get("unloadMinPerPallet")
    return {
        "setup_minutes": max(0.0, parse_number(cycle.get("setupMinutes"), 0)),
        "load_min": max(0.0, parse_number(load_raw, MPP_DEFAULT_LOAD_MIN_PER_PALLET)),
        "unload_min": max(0.0, parse_number(unload_raw, MPP_DEFAULT_UNLOAD_MIN_PER_PALLET)),
        "sequential": cycle.get("sequential") is True,
        "setup_per_op": cycle.get("setupPerOp") is True,
    }


def _sprint_setup_minutes(
    cycle_timing: dict[str, Any],
    cycle_ops: list[dict[str, Any]],
    job_overrides: dict[str, dict[str, Any]],
    step_cache: dict[tuple[str, int, str], dict[str, Any]] | None = None,
) -> float:
    if cycle_timing.get("setup_per_op") and len(cycle_ops) > 1:
        total = 0.0
        for op in cycle_ops:
            job_id = compact_text(op.get("jobId"))
            job_row = job_overrides.get(job_id) or {}
            total += max(0.0, parse_number(job_row.get("setupMinutes"), 0))
        return total
    return float(cycle_timing.get("setup_minutes") or 0)


def _load_job_overrides(con) -> dict[str, dict[str, Any]]:
    ensure_mpp_queue_schema(con)
    out: dict[str, dict[str, Any]] = {}
    for row in rows(con.execute("SELECT * FROM planner_mpp_job_override")):
        job_id = compact_text(row.get("job_id"))
        if not job_id:
            continue
        out[job_id] = {
            "minPerPallet": float(row.get("min_per_pallet") or 90),
            "pcsPerPallet": float(row.get("pcs_per_pallet") or 1),
            "qty": float(row.get("qty") or 0),
            "out": float(row.get("out_qty") or 0),
            "setupMinutes": max(0.0, float(row.get("setup_minutes") or 0)),
            "loadMinPerPallet": _job_load_min_per_cycle(row),
            "unloadMinPerPallet": _job_unload_min_per_cycle(row),
            "loadMinPerCycle": _job_load_min_per_cycle(row),
            "unloadMinPerCycle": _job_unload_min_per_cycle(row),
        }
    return out


def _load_probation(con, mpp_machines: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Probation / holding entries per machine slug — capacity reserve, not scheduled cycles."""
    ensure_mpp_queue_schema(con)
    slug_by_machine_id = {
        int(m.get("machineId") or 0): m["id"]
        for m in mpp_machines
        if int(m.get("machineId") or 0) > 0
    }
    probation: dict[str, list[dict[str, Any]]] = {m["id"]: [] for m in mpp_machines}
    machine_ids = list(slug_by_machine_id.keys())
    if not machine_ids:
        return probation
    for row in rows(
        con.execute(
            """
            SELECT *
            FROM planner_mpp_probation_op
            WHERE machine_id = ANY(%s)
            ORDER BY machine_id, queue_index, probation_op_id
            """,
            (machine_ids,),
        )
    ):
        slug = slug_by_machine_id.get(int(row.get("machine_id") or 0))
        if not slug:
            continue
        probation.setdefault(slug, []).append(
            {
                "entryId": compact_text(row.get("client_entry_id")),
                "jobId": compact_text(row.get("job_id")),
                "palletCount": max(1, int(row.get("pallet_count") or 1)),
                "shift": _normalize_shift(row.get("shift")),
                "note": compact_text(row.get("note")),
            }
        )
    return probation


def _mpp_cycle_ops_need_scheduler_blocks(con) -> bool:
    """True when planner_mpp_cycle_op rows lack an active planner_run_block mirror."""
    from .machines import fetch_mpp_planner_machine_ids

    machine_ids = fetch_mpp_planner_machine_ids(con)
    if not machine_ids:
        return False
    stale = one(
        con.execute(
            """
            SELECT 1
            FROM planner_mpp_cycle c
            JOIN planner_mpp_cycle_op co ON co.cycle_id = c.cycle_id
            WHERE c.machine_id = ANY(%s)
              AND (
                COALESCE(co.block_id, 0) = 0
                OR NOT EXISTS (
                    SELECT 1
                    FROM planner_run_block b
                    WHERE b.block_id = co.block_id
                      AND COALESCE(b.active, TRUE) = TRUE
                )
              )
            LIMIT 1
            """,
            (machine_ids,),
        )
    )
    return bool(stale)


def rehydrate_mpp_scheduler_blocks_if_needed(con) -> dict[str, Any]:
    """Recreate scheduler-lane blocks for MPP cycles when cycle_op.block_id links are broken."""
    ensure_mpp_queue_schema(con)
    if not _mpp_cycle_ops_need_scheduler_blocks(con):
        return {"rehydrated": False}
    queue = _hydrate_mpp_queue_from_db(con)
    machines = queue.get("machines") or {}
    if not any((lane.get("cycles") or []) for lane in machines.values()):
        return {"rehydrated": False}
    save_mpp_planner_queue(
        con,
        {
            "machines": machines,
            "jobs": queue.get("jobOverrides") or {},
        },
    )
    return {"rehydrated": True}


def load_mpp_planner_queue(con) -> dict[str, Any]:
    """Hydrate frontend queue state from planner_mpp_* tables."""
    ensure_mpp_queue_schema(con)
    rehydrate_mpp_scheduler_blocks_if_needed(con)
    _recover_db_transaction(con)
    purge_orphan_mpp_scheduler_blocks(con)
    return _hydrate_mpp_queue_from_db(con)


def _hydrate_mpp_queue_from_db(con) -> dict[str, Any]:
    """Read planner_mpp_* tables into the frontend queue payload shape."""
    machines_state: dict[str, dict[str, Any]] = {}
    mpp_machines = fetch_mpp_planner_machines(con)
    machine_ids = [int(m.get("machineId") or 0) for m in mpp_machines if int(m.get("machineId") or 0) > 0]

    lane_by_machine: dict[int, str] = {}
    for row in rows(
        con.execute(
            "SELECT machine_id, lane_anchor FROM planner_mpp_lane WHERE machine_id = ANY(%s)",
            (machine_ids,),
        )
    ) if machine_ids else []:
        lane_by_machine[int(row["machine_id"])] = _anchor_to_api(row.get("lane_anchor"))

    for machine in mpp_machines:
        slug = machine["id"]
        machines_state[slug] = {"laneAnchor": lane_by_machine.get(int(machine.get("machineId") or 0), ""), "cycles": []}

    cycle_rows = rows(
        con.execute(
            """
            SELECT c.*, m.machine_no
            FROM planner_mpp_cycle c
            JOIN planner_machines m ON m.machine_id = c.machine_id
            WHERE c.machine_id = ANY(%s)
            ORDER BY c.machine_id, c.queue_index, c.cycle_id
            """,
            (machine_ids,),
        )
    ) if machine_ids else []

    cycle_ids = [int(row["cycle_id"]) for row in cycle_rows]
    ops_by_cycle: dict[int, list[dict[str, Any]]] = {cid: [] for cid in cycle_ids}
    if cycle_ids:
        for op in rows(
            con.execute(
                """
                SELECT *
                FROM planner_mpp_cycle_op
                WHERE cycle_id = ANY(%s)
                ORDER BY cycle_op_id
                """,
                (cycle_ids,),
            )
        ):
            ops_by_cycle[int(op["cycle_id"])].append(dict(op))

    for cycle in cycle_rows:
        slug = mpp_machine_slug(cycle.get("machine_no") or "")
        if slug not in machines_state:
            continue
        ops = []
        for op in ops_by_cycle.get(int(cycle["cycle_id"]), []):
            ops.append(
                {
                    "opId": compact_text(op.get("client_op_id")),
                    "jobId": compact_text(op.get("job_id")),
                    "palletCount": int(op.get("pallet_count") or 1),
                    "blockId": int(op.get("block_id") or 0),
                }
            )
        machines_state[slug]["cycles"].append(
            {
                "cycleId": compact_text(cycle.get("client_cycle_id")),
                "shift": _normalize_shift(cycle.get("shift")),
                "anchor": _anchor_to_api(cycle.get("anchor_datetime")),
                "label": compact_text(cycle.get("cycle_label")) or None,
                "groupId": int(cycle.get("group_id") or 0),
                "setupMinutes": max(0.0, float(cycle.get("setup_minutes") or 0)),
                "loadMinPerCycle": max(
                    0.0,
                    float(
                        cycle.get("load_min_per_cycle")
                        if cycle.get("load_min_per_cycle") is not None
                        else MPP_DEFAULT_LOAD_MIN_PER_PALLET
                    ),
                ),
                "unloadMinPerCycle": max(
                    0.0,
                    float(
                        cycle.get("unload_min_per_cycle")
                        if cycle.get("unload_min_per_cycle") is not None
                        else MPP_DEFAULT_UNLOAD_MIN_PER_PALLET
                    ),
                ),
                "sequential": bool(cycle.get("sequential_ops")),
                "setupPerOp": bool(cycle.get("setup_per_op")),
                "ops": ops,
            }
        )

    return {
        "machines": machines_state,
        "probation": _load_probation(con, mpp_machines),
        "jobOverrides": _load_job_overrides(con),
        "savedAt": datetime.now().isoformat(sep=" ", timespec="seconds"),
    }


def _resolve_bom_step(con, planner_ps_id: str, source_op_seq_id: int, source_op_no: str) -> dict[str, Any] | None:
    if not planner_ps_id:
        return None
    base, partial = parse_planner_ps_id(planner_ps_id)
    canonical_ps_id = _canonical_planner_ps_id(con, base or planner_ps_id, partial)
    try:
        ps = ensure_planner_process_sheet(con, canonical_ps_id)
    except ValueError as exc:
        logger.warning("MPP queue: %s", exc)
        return None
    if not ps:
        return None
    bom_id = int(ps.get("selected_bom_id") or 0)
    if bom_id <= 0:
        return None
    if int(source_op_seq_id or 0) > 0:
        step = one(
            con.execute(
                "SELECT * FROM planner_operation_seq WHERE op_seq_id = %s AND bom_id = %s",
                (int(source_op_seq_id), bom_id),
            )
        )
        if step:
            return dict(step)
    op_no = compact_text(source_op_no)
    if op_no.upper().startswith("OP"):
        op_no = op_no[2:].strip()
    if op_no:
        step = one(
            con.execute(
                """
                SELECT * FROM planner_operation_seq
                WHERE bom_id = %s AND op_no = %s
                ORDER BY seq_no, op_seq_id
                LIMIT 1
                """,
                (bom_id, op_no),
            )
        )
        if step:
            return dict(step)
    return None


def _mpp_job_timing(
    job_row: dict[str, Any],
    step: dict[str, Any],
    *,
    min_per_pallet: float,
    pcs_per_pallet: float,
    pallet_count: int = 1,
    cycle_timing: dict[str, Any] | None = None,
    op_index: int = 0,
    op_count: int = 1,
) -> tuple[float, float, float, float]:
    """Return setup, load/cycle, unload/cycle, cycle_minutes_per_qty for planner_operation."""
    cycle_timing = cycle_timing or {}
    setup_minutes = max(
        0.0,
        parse_number(job_row.get("setupMinutes"), parse_number(step.get("setup_time"), 0)),
    )
    if not cycle_timing.get("setup_per_op"):
        setup_minutes = float(cycle_timing.get("setup_minutes") or 0) if op_index == 0 else 0.0
    else:
        setup_minutes = max(
            0.0,
            parse_number(job_row.get("setupMinutes"), parse_number(step.get("setup_time"), 0)),
        ) if op_index == 0 else 0.0
    load_min = float(cycle_timing.get("load_min") or MPP_DEFAULT_LOAD_MIN_PER_PALLET)
    unload_min = float(cycle_timing.get("unload_min") or MPP_DEFAULT_UNLOAD_MIN_PER_PALLET)
    run_per_pallet = max(0.1, float(min_per_pallet or 0))
    pallets = max(1, int(pallet_count or 1))
    pcs = max(1.0, float(pcs_per_pallet or 1))
    scheduled_qty = pallets * pcs
    load_unload = (load_min + unload_min) if op_index == 0 else 0.0
    cycle_per_pc = (run_per_pallet * pallets + load_unload) / scheduled_qty
    return setup_minutes, load_min, unload_min, cycle_per_pc


def _ensure_operation_for_op(
    con,
    *,
    planner_ps_id: str,
    step: dict[str, Any],
    scheduled_qty: float,
    min_per_pallet: float,
    pcs_per_pallet: float,
    machine_category: str,
    job_row: dict[str, Any] | None = None,
    pallet_count: int = 1,
    cycle_timing: dict[str, Any] | None = None,
    op_index: int = 0,
    op_count: int = 1,
    sprint_setup_total: float = 0.0,
) -> int:
    op_seq_id = int(step.get("op_seq_id") or 0)
    op_no = compact_text(step.get("op_no"))
    existing = one(
        con.execute(
            """
            SELECT operation_id
            FROM planner_operation
            WHERE source_ps_id = %s
              AND source_op_seq_id = %s
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            ORDER BY operation_id DESC
            LIMIT 1
            """,
            (planner_ps_id, op_seq_id),
        )
    )
    setup_minutes, _, _, cycle_per_pc = _mpp_job_timing(
        job_row or {},
        step,
        min_per_pallet=min_per_pallet,
        pcs_per_pallet=pcs_per_pallet,
        pallet_count=pallet_count,
        cycle_timing=cycle_timing,
        op_index=op_index,
        op_count=op_count,
    )
    cycle_timing = cycle_timing or {}
    if op_index == 0 and sprint_setup_total > 0:
        setup_minutes = sprint_setup_total
    elif op_index == 0 and not cycle_timing.get("setup_per_op"):
        setup_minutes = float(cycle_timing.get("setup_minutes") or 0)
    elif op_index > 0:
        setup_minutes = 0.0
    if not cycle_per_pc:
        cycle_per_pc = parse_number(step.get("cycle_time"), 0)
    op_name = f"{op_no} {compact_text(step.get('op_type'))}".strip() or "MPP op"
    if existing:
        operation_id = int(existing["operation_id"])
        con.execute(
            """
            UPDATE planner_operation
            SET total_qty = %s,
                setup_minutes = %s,
                cycle_minutes_per_qty = %s,
                operation_name = %s,
                compatible_machine_group = %s,
                updated_at = NOW()
            WHERE operation_id = %s
            """,
            (
                scheduled_qty,
                setup_minutes,
                cycle_per_pc,
                op_name,
                compact_text(step.get("machine_category")) or machine_category or "MPP",
                operation_id,
            ),
        )
        return operation_id

    op_cur = con.execute(
        """
        INSERT INTO planner_operation (
          job_no, operation_name, total_qty, setup_minutes, cycle_minutes_per_qty,
          compatible_machine_group, source_ps_id, source_op_seq_id, source_op_no,
          status, remarks, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'ACTIVE', 'MPP planner', NOW())
        RETURNING operation_id
        """,
        (
            planner_ps_id,
            op_name,
            scheduled_qty,
            setup_minutes,
            cycle_per_pc,
            compact_text(step.get("machine_category")) or machine_category or "MPP",
            planner_ps_id,
            op_seq_id,
            op_no,
        ),
    )
    return int(one(op_cur)["operation_id"])


def _upsert_block_for_op(
    con,
    *,
    operation_id: int,
    machine_id: int,
    group_id: int,
    queue_position: float,
    scheduled_qty: float,
    anchor_dt: datetime | None,
    block_id: int = 0,
    include_setup: bool = True,
) -> int:
    if block_id > 0:
        existing = one(
            con.execute(
                "SELECT block_id, active FROM planner_run_block WHERE block_id = %s",
                (block_id,),
            )
        )
        if existing:
            con.execute(
                """
                UPDATE planner_run_block
                SET operation_id = %s,
                    machine_id = %s,
                    queue_position = %s,
                    scheduled_qty = %s,
                    group_id = %s,
                    include_setup = %s,
                    anchor_datetime = COALESCE(%s, anchor_datetime),
                    planning_status = 'PLANNED',
                    execution_status = COALESCE(NULLIF(execution_status, ''), 'NOT_STARTED'),
                    active = TRUE,
                    updated_at = NOW()
                WHERE block_id = %s
                """,
                (
                    operation_id,
                    machine_id,
                    queue_position,
                    scheduled_qty,
                    group_id,
                    include_setup,
                    anchor_dt,
                    block_id,
                ),
            )
            return block_id

    block_cur = con.execute(
        """
        INSERT INTO planner_run_block (
          operation_id, machine_id, queue_position, scheduled_qty, include_setup,
          status, planning_status, execution_status,
          anchor_datetime, group_id, active, updated_at
        ) VALUES (%s, %s, %s, %s, %s, 'NOT_STARTED', 'PLANNED', 'NOT_STARTED',
                  %s, %s, TRUE, NOW())
        RETURNING block_id
        """,
        (operation_id, machine_id, queue_position, scheduled_qty, include_setup, anchor_dt, group_id),
    )
    return int(one(block_cur)["block_id"])


def _delete_orphan_mpp_blocks(con, machine_id: int, keep_block_ids: set[int]) -> None:
    """Remove every active block on an MPP machine that is not owned by the current MPP queue save."""
    keep = [int(bid) for bid in keep_block_ids if int(bid or 0) > 0] or [0]
    stale = rows(
        con.execute(
            """
            SELECT b.block_id
            FROM planner_run_block b
            WHERE b.machine_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
              AND NOT (b.block_id = ANY(%s))
            """,
            (machine_id, keep),
        )
    )
    for row in stale:
        block_id = int(row["block_id"])
        con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (block_id,))


def detach_mpp_planner_scheduler_blocks(con, *, machine_ids: list[int] | None = None) -> list[int]:
    """Remove legacy planner_run_block rows linked from the MPP planner tab."""
    ensure_mpp_queue_schema(con)
    params: list = []
    machine_clause = ""
    mids = sorted({int(mid) for mid in (machine_ids or []) if int(mid or 0) > 0})
    if mids:
        machine_clause = " AND c.machine_id = ANY(%s)"
        params.append(mids)
    linked = rows(
        con.execute(
            f"""
            SELECT DISTINCT co.block_id
            FROM planner_mpp_cycle_op co
            JOIN planner_mpp_cycle c ON c.cycle_id = co.cycle_id
            WHERE COALESCE(co.block_id, 0) > 0
              {machine_clause}
            """,
            tuple(params),
        )
    )
    removed: list[int] = []
    for row in linked:
        block_id = int(row.get("block_id") or 0)
        if block_id <= 0:
            continue
        con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (block_id,))
        removed.append(block_id)
    if linked:
        con.execute(
            f"""
            UPDATE planner_mpp_cycle_op co
            SET block_id = NULL, updated_at = NOW()
            FROM planner_mpp_cycle c
            WHERE c.cycle_id = co.cycle_id
              AND COALESCE(co.block_id, 0) > 0
              {machine_clause}
            """,
            tuple(params),
        )
    return removed


def purge_orphan_mpp_scheduler_blocks(con) -> list[int]:
    """Drop scheduler-lane blocks on MPP machines that are not linked to planner_mpp_cycle_op."""
    from .machines import fetch_mpp_planner_machine_ids

    ensure_mpp_queue_schema(con)
    machine_ids = fetch_mpp_planner_machine_ids(con)
    if not machine_ids:
        return []
    owned = {
        int(row["block_id"])
        for row in rows(
            con.execute(
                """
                SELECT DISTINCT co.block_id
                FROM planner_mpp_cycle_op co
                JOIN planner_mpp_cycle c ON c.cycle_id = co.cycle_id
                WHERE c.machine_id = ANY(%s)
                  AND COALESCE(co.block_id, 0) > 0
                """,
                (machine_ids,),
            )
        )
        if int(row.get("block_id") or 0) > 0
    }
    removed: list[int] = []
    for row in rows(
        con.execute(
            """
            SELECT b.block_id
            FROM planner_run_block b
            WHERE b.machine_id = ANY(%s)
              AND COALESCE(b.active, TRUE) = TRUE
              AND NOT (b.block_id = ANY(%s))
            """,
            (machine_ids, list(owned) if owned else [0]),
        )
    ):
        block_id = int(row["block_id"])
        con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (block_id,))
        removed.append(block_id)
    return removed


def purge_legacy_mpp_scheduler_blocks(con) -> list[int]:
    """Deprecated alias — removes orphan blocks only (keeps MPP-tab mirror blocks)."""
    return purge_orphan_mpp_scheduler_blocks(con)


def prune_mpp_tab_scheduler_blocks(con) -> list[int]:
    """Remove legacy planner_run_block rows that belong to the MPP planner tab."""
    ensure_mpp_queue_schema(con)
    stale = rows(
        con.execute(
            """
            SELECT b.block_id
            FROM planner_run_block b
            LEFT JOIN planner_run_block_group g ON g.group_id = b.group_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND (
                EXISTS (
                    SELECT 1
                    FROM planner_mpp_cycle_op co
                    WHERE co.block_id = b.block_id
                      AND COALESCE(co.block_id, 0) > 0
                )
                OR UPPER(COALESCE(g.group_type, '')) = 'MPP_CYCLE'
                OR COALESCE(g.group_label, '') ILIKE 'MPP cycle%%'
                OR EXISTS (
                    SELECT 1
                    FROM planner_mpp_cycle c
                    WHERE c.group_id = b.group_id
                      AND COALESCE(b.group_id, 0) > 0
                )
              )
            ORDER BY b.block_id
            """
        )
    )
    removed: list[int] = []
    for row in stale:
        block_id = int(row["block_id"])
        con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (block_id,))
        removed.append(block_id)
    if removed:
        con.execute(
            """
            UPDATE planner_mpp_cycle_op
            SET block_id = NULL, updated_at = NOW()
            WHERE block_id = ANY(%s)
            """,
            (removed,),
        )
    return removed


def _sync_machine_queue(con, machine_id: int, cycle_primary_block_ids: list[int]) -> None:
    from .operation_sequence import apply_machine_queue_order

    if not cycle_primary_block_ids:
        compact_ids = [
            int(row["block_id"])
            for row in rows(
                con.execute(
                    """
                    SELECT b.block_id
                    FROM planner_run_block b
                    JOIN planner_run_block_group g ON g.group_id = b.group_id
                    WHERE b.machine_id = %s
                      AND COALESCE(b.active, TRUE) = TRUE
                      AND g.group_type = 'MPP_CYCLE'
                    ORDER BY b.queue_position, b.block_id
                    """,
                    (machine_id,),
                )
            )
        ]
        if compact_ids:
            apply_machine_queue_order(con, machine_id, compact_ids, recalculate=False, allow_mpp_planner=True)
        return

    all_blocks = rows(
        con.execute(
            """
            SELECT block_id, group_id, queue_position
            FROM planner_run_block
            WHERE machine_id = %s
              AND COALESCE(active, TRUE) = TRUE
            ORDER BY queue_position, block_id
            """,
            (machine_id,),
        )
    )
    mpp_group_ids = {
        int(row["group_id"])
        for row in rows(
            con.execute(
                """
                SELECT DISTINCT b.group_id
                FROM planner_run_block b
                JOIN planner_run_block_group g ON g.group_id = b.group_id
                WHERE b.machine_id = %s
                  AND g.group_type = 'MPP_CYCLE'
                  AND COALESCE(b.active, TRUE) = TRUE
                """,
                (machine_id,),
            )
        )
        if int(row.get("group_id") or 0) > 0
    }

    ordered: list[int] = []
    seen: set[int] = set()
    primary_set = {int(bid) for bid in cycle_primary_block_ids}

    for primary_id in cycle_primary_block_ids:
        primary_id = int(primary_id)
        if primary_id <= 0 or primary_id in seen:
            continue
        block = next((b for b in all_blocks if int(b["block_id"]) == primary_id), None)
        if not block:
            continue
        group_id = int(block.get("group_id") or 0)
        if group_id > 0 and group_id in mpp_group_ids:
            group_members = sorted(
                [int(b["block_id"]) for b in all_blocks if int(b.get("group_id") or 0) == group_id],
                key=lambda bid: next((float(x["queue_position"]) for x in all_blocks if int(x["block_id"]) == bid), 0),
            )
            for bid in group_members:
                if bid not in seen:
                    ordered.append(bid)
                    seen.add(bid)
        elif primary_id not in seen:
            ordered.append(primary_id)
            seen.add(primary_id)

    if ordered:
        apply_machine_queue_order(con, machine_id, ordered, recalculate=False, allow_mpp_planner=True)


def ensure_mpp_planner_scheduler_lanes(con) -> dict[str, Any]:
    """Mirror planner_mpp_* queue onto CNC 35/36/41 scheduler lanes for the main board."""
    ensure_mpp_queue_schema(con)
    result = rehydrate_mpp_scheduler_blocks_if_needed(con)
    purge_orphan_mpp_scheduler_blocks(con)
    return result


def save_mpp_planner_queue(con, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist queue state and sync planner_run_block groups for MPP machines."""
    _configure_mpp_save_session(con)
    ensure_mpp_queue_schema(con)
    machines_payload = payload.get("machines") or {}
    job_overrides = payload.get("jobs") or payload.get("jobOverrides") or {}

    touched_machine_ids: list[int] = []
    keep_block_ids: set[int] = set()
    primary_blocks_by_machine: dict[int, list[int]] = {}
    save_warnings: list[str] = []

    for slug, lane in machines_payload.items():
        machine_id = _machine_id_by_slug(con, slug)
        if machine_id <= 0:
            continue
        touched_machine_ids.append(machine_id)
        lane_anchor = _parse_anchor_text(lane.get("laneAnchor"))
        con.execute(
            """
            INSERT INTO planner_mpp_lane (machine_id, lane_anchor, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (machine_id) DO UPDATE SET
              lane_anchor = EXCLUDED.lane_anchor,
              updated_at = NOW()
            """,
            (machine_id, lane_anchor),
        )

        existing_cycles = {
            compact_text(row["client_cycle_id"]): int(row["cycle_id"])
            for row in rows(
                con.execute(
                    "SELECT cycle_id, client_cycle_id FROM planner_mpp_cycle WHERE machine_id = %s",
                    (machine_id,),
                )
            )
        }
        seen_cycle_ids: set[int] = set()
        primary_blocks: list[int] = []

        machine = one(
            con.execute(
                "SELECT machine_category FROM planner_machines WHERE machine_id = %s",
                (machine_id,),
            )
        ) or {}
        machine_category = compact_text(machine.get("machine_category")) or "MPP"
        prev_cycle_fingerprint: str | None = None

        for queue_index, cycle in enumerate(lane.get("cycles") or []):
            client_cycle_id = compact_text(cycle.get("cycleId"))
            if not client_cycle_id:
                continue
            shift = _normalize_shift(cycle.get("shift"))
            anchor_dt = _parse_anchor_text(cycle.get("anchor"))
            cycle_label = compact_text(cycle.get("label"))
            cycle_fp = _cycle_fingerprint(cycle)
            is_sprint_start = cycle_fp != prev_cycle_fingerprint
            prev_cycle_fingerprint = cycle_fp

            cycle_timing = _cycle_timing_from_payload(cycle)
            cycle_ops = [op for op in (cycle.get("ops") or []) if compact_text(op.get("jobId"))]
            op_count = len(cycle_ops)
            sprint_setup_total = _sprint_setup_minutes(cycle_timing, cycle_ops, job_overrides)

            cycle_id = existing_cycles.get(client_cycle_id)
            if cycle_id:
                con.execute(
                    """
                    UPDATE planner_mpp_cycle
                    SET queue_index = %s, shift = %s, anchor_datetime = %s,
                        cycle_label = %s, setup_minutes = %s,
                        load_min_per_cycle = %s, unload_min_per_cycle = %s,
                        sequential_ops = %s, setup_per_op = %s,
                        updated_at = NOW()
                    WHERE cycle_id = %s
                    """,
                    (
                        queue_index,
                        shift,
                        anchor_dt,
                        cycle_label,
                        cycle_timing["setup_minutes"],
                        cycle_timing["load_min"],
                        cycle_timing["unload_min"],
                        cycle_timing["sequential"],
                        cycle_timing["setup_per_op"],
                        cycle_id,
                    ),
                )
            else:
                row = one(
                    con.execute(
                        """
                        INSERT INTO planner_mpp_cycle (
                          client_cycle_id, machine_id, queue_index, shift,
                          anchor_datetime, cycle_label,
                          setup_minutes, load_min_per_cycle, unload_min_per_cycle,
                          sequential_ops, setup_per_op, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                        RETURNING cycle_id
                        """,
                        (
                            client_cycle_id,
                            machine_id,
                            queue_index,
                            shift,
                            anchor_dt,
                            cycle_label,
                            cycle_timing["setup_minutes"],
                            cycle_timing["load_min"],
                            cycle_timing["unload_min"],
                            cycle_timing["sequential"],
                            cycle_timing["setup_per_op"],
                        ),
                    )
                )
                cycle_id = int(row["cycle_id"])

            seen_cycle_ids.add(cycle_id)
            cycle_row = one(
                con.execute("SELECT group_id FROM planner_mpp_cycle WHERE cycle_id = %s", (cycle_id,))
            ) or {}
            group_id = int(cycle_row.get("group_id") or 0)
            if group_id <= 0:
                group_label = cycle_label or f"MPP cycle {queue_index + 1}"
                group_row = one(
                    con.execute(
                        """
                        INSERT INTO planner_run_block_group (group_label, group_type)
                        VALUES (%s, 'MPP_CYCLE')
                        RETURNING group_id
                        """,
                        (group_label,),
                    )
                )
                group_id = int(group_row["group_id"])
                con.execute(
                    "UPDATE planner_mpp_cycle SET group_id = %s WHERE cycle_id = %s",
                    (group_id, cycle_id),
                )
            elif cycle_label:
                con.execute(
                    "UPDATE planner_run_block_group SET group_label = %s WHERE group_id = %s",
                    (cycle_label, group_id),
                )

            existing_ops = {
                compact_text(row["client_op_id"]): dict(row)
                for row in rows(
                    con.execute(
                        "SELECT * FROM planner_mpp_cycle_op WHERE cycle_id = %s",
                        (cycle_id,),
                    )
                )
            }
            seen_op_ids: set[int] = set()
            queue_position = float(queue_index + 1)
            first_block_id = 0

            for op_index, op in enumerate(cycle.get("ops") or []):
                client_op_id = compact_text(op.get("opId"))
                job_id = compact_text(op.get("jobId"))
                if not client_op_id or not job_id:
                    continue
                pallet_count = max(1, int(op.get("palletCount") or 1))
                job_row = job_overrides.get(job_id) or {}
                ctx = _mpp_job_context(job_id, job_row)
                source_ps_id = ctx["source_ps_id"]
                pp_partial_no = ctx["pp_partial_no"]
                source_op_no = ctx["source_op_no"]
                source_op_seq_id = ctx["source_op_seq_id"]
                planner_ps_id = _canonical_planner_ps_id(con, source_ps_id, pp_partial_no)
                min_per_pallet = max(0.1, float(job_row.get("minPerPallet") or op.get("minPerPallet") or 90))
                pcs_per_pallet = max(1.0, float(job_row.get("pcsPerPallet") or op.get("pcsPerPallet") or 1))
                scheduled_qty = float(pallet_count) * pcs_per_pallet

                step = _resolve_bom_step(con, planner_ps_id, source_op_seq_id, source_op_no)
                if not step:
                    msg = f"Could not resolve BOM step for {job_id} ({planner_ps_id})"
                    logger.warning("MPP queue: %s", msg)
                    save_warnings.append(msg)
                    continue
                source_op_seq_id = int(step.get("op_seq_id") or 0)
                source_op_no = compact_text(step.get("op_no"))

                operation_id = _ensure_operation_for_op(
                    con,
                    planner_ps_id=planner_ps_id,
                    step=step,
                    scheduled_qty=scheduled_qty,
                    min_per_pallet=min_per_pallet,
                    pcs_per_pallet=pcs_per_pallet,
                    machine_category=machine_category,
                    job_row=job_row,
                    pallet_count=pallet_count,
                    cycle_timing=cycle_timing,
                    op_index=op_index,
                    op_count=op_count,
                    sprint_setup_total=sprint_setup_total if is_sprint_start else 0.0,
                )

                prior = existing_ops.get(client_op_id) or {}
                block_id = int(prior.get("block_id") or op.get("blockId") or 0)
                anchor_for_block = anchor_dt if op_index == 0 else None
                include_setup = is_sprint_start and op_index == 0
                block_id = _upsert_block_for_op(
                    con,
                    operation_id=operation_id,
                    machine_id=machine_id,
                    group_id=group_id,
                    queue_position=queue_position,
                    scheduled_qty=scheduled_qty,
                    anchor_dt=anchor_for_block,
                    block_id=block_id,
                    include_setup=include_setup,
                )
                keep_block_ids.add(block_id)
                if op_index == 0:
                    first_block_id = block_id

                prior_cycle_op_id = int(prior.get("cycle_op_id") or 0)
                if prior_cycle_op_id > 0:
                    con.execute(
                        """
                        UPDATE planner_mpp_cycle_op
                        SET block_id = %s, job_id = %s, source_ps_id = %s,
                            source_op_seq_id = %s, source_op_no = %s, pp_partial_no = %s,
                            pallet_count = %s, min_per_pallet = %s, pcs_per_pallet = %s,
                            updated_at = NOW()
                        WHERE cycle_op_id = %s
                        """,
                        (
                            block_id,
                            job_id,
                            source_ps_id,
                            source_op_seq_id,
                            source_op_no,
                            pp_partial_no,
                            pallet_count,
                            min_per_pallet,
                            pcs_per_pallet,
                            prior_cycle_op_id,
                        ),
                    )
                    seen_op_ids.add(prior_cycle_op_id)
                else:
                    row = one(
                        con.execute(
                            """
                            INSERT INTO planner_mpp_cycle_op (
                              client_op_id, cycle_id, block_id, job_id, source_ps_id,
                              source_op_seq_id, source_op_no, pp_partial_no,
                              pallet_count, min_per_pallet, pcs_per_pallet, updated_at
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                            RETURNING cycle_op_id
                            """,
                            (
                                client_op_id,
                                cycle_id,
                                block_id,
                                job_id,
                                source_ps_id,
                                source_op_seq_id,
                                source_op_no,
                                pp_partial_no,
                                pallet_count,
                                min_per_pallet,
                                pcs_per_pallet,
                            ),
                        )
                    )
                    seen_op_ids.add(int(row["cycle_op_id"]))

            if first_block_id > 0:
                primary_blocks.append(first_block_id)

            stale_ops = [
                int(row["cycle_op_id"])
                for row in rows(
                    con.execute("SELECT cycle_op_id FROM planner_mpp_cycle_op WHERE cycle_id = %s", (cycle_id,))
                )
                if int(row["cycle_op_id"]) not in seen_op_ids
            ]
            for cycle_op_id in stale_ops:
                op_row = one(
                    con.execute(
                        "SELECT block_id FROM planner_mpp_cycle_op WHERE cycle_op_id = %s",
                        (cycle_op_id,),
                    )
                )
                if op_row and int(op_row.get("block_id") or 0) > 0:
                    con.execute(
                        "DELETE FROM planner_run_block WHERE block_id = %s",
                        (int(op_row["block_id"]),),
                    )
                con.execute("DELETE FROM planner_mpp_cycle_op WHERE cycle_op_id = %s", (cycle_op_id,))

        stale_cycle_ids = [cid for cid in existing_cycles.values() if cid not in seen_cycle_ids]
        for cycle_id in stale_cycle_ids:
            for op_row in rows(
                con.execute(
                    "SELECT block_id FROM planner_mpp_cycle_op WHERE cycle_id = %s",
                    (cycle_id,),
                )
            ):
                if int(op_row.get("block_id") or 0) > 0:
                    con.execute(
                        "DELETE FROM planner_run_block WHERE block_id = %s",
                        (int(op_row["block_id"]),),
                    )
            cycle_row = one(
                con.execute("SELECT group_id FROM planner_mpp_cycle WHERE cycle_id = %s", (cycle_id,))
            )
            if cycle_row and int(cycle_row.get("group_id") or 0) > 0:
                con.execute(
                    "DELETE FROM planner_run_block_group WHERE group_id = %s",
                    (int(cycle_row["group_id"]),),
                )
            con.execute("DELETE FROM planner_mpp_cycle_op WHERE cycle_id = %s", (cycle_id,))
            con.execute("DELETE FROM planner_mpp_cycle WHERE cycle_id = %s", (cycle_id,))

        _delete_orphan_mpp_blocks(con, machine_id, keep_block_ids)
        primary_blocks_by_machine[machine_id] = primary_blocks

    probation_payload = payload.get("probation")
    if probation_payload is not None:
        for slug, entries in probation_payload.items():
            machine_id = _machine_id_by_slug(con, slug)
            if machine_id <= 0:
                continue
            existing = {
                compact_text(row["client_entry_id"]): int(row["probation_op_id"])
                for row in rows(
                    con.execute(
                        "SELECT probation_op_id, client_entry_id FROM planner_mpp_probation_op WHERE machine_id = %s",
                        (machine_id,),
                    )
                )
            }
            seen_probation: set[int] = set()
            for queue_index, entry in enumerate(entries or []):
                client_entry_id = compact_text(entry.get("entryId"))
                job_id = compact_text(entry.get("jobId"))
                if not client_entry_id or not job_id:
                    continue
                parsed = parse_mpp_job_id(job_id)
                pallet_count = max(1, int(entry.get("palletCount") or 1))
                shift = _normalize_shift(entry.get("shift"))
                note = compact_text(entry.get("note"))
                probation_op_id = existing.get(client_entry_id)
                if probation_op_id:
                    con.execute(
                        """
                        UPDATE planner_mpp_probation_op
                        SET queue_index = %s, job_id = %s, pallet_count = %s, shift = %s, note = %s,
                            source_ps_id = %s, source_op_seq_id = %s, source_op_no = %s,
                            pp_partial_no = %s, updated_at = NOW()
                        WHERE probation_op_id = %s
                        """,
                        (
                            queue_index,
                            job_id,
                            pallet_count,
                            shift,
                            note,
                            compact_text(parsed.get("source_ps_id")),
                            int(parsed.get("source_op_seq_id") or 0),
                            compact_text(parsed.get("op_no")),
                            int(parsed.get("pp_partial_no") or 1),
                            probation_op_id,
                        ),
                    )
                else:
                    row = one(
                        con.execute(
                            """
                            INSERT INTO planner_mpp_probation_op (
                              client_entry_id, machine_id, queue_index, job_id,
                              source_ps_id, source_op_seq_id, source_op_no, pp_partial_no,
                              pallet_count, shift, note, updated_at
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                            RETURNING probation_op_id
                            """,
                            (
                                client_entry_id,
                                machine_id,
                                queue_index,
                                job_id,
                                compact_text(parsed.get("source_ps_id")),
                                int(parsed.get("source_op_seq_id") or 0),
                                compact_text(parsed.get("op_no")),
                                int(parsed.get("pp_partial_no") or 1),
                                pallet_count,
                                shift,
                                note,
                            ),
                        )
                    )
                    probation_op_id = int(row["probation_op_id"])
                seen_probation.add(probation_op_id)

            stale_probation = [pid for pid in existing.values() if pid not in seen_probation]
            if stale_probation:
                con.execute(
                    "DELETE FROM planner_mpp_probation_op WHERE probation_op_id = ANY(%s)",
                    (stale_probation,),
                )

    for job_id, override in job_overrides.items():
        jid = compact_text(job_id)
        if not jid:
            continue
        con.execute(
            """
            INSERT INTO planner_mpp_job_override (
              job_id, min_per_pallet, pcs_per_pallet, qty, out_qty,
              setup_minutes, load_min_per_pallet, unload_min_per_pallet, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (job_id) DO UPDATE SET
              min_per_pallet = EXCLUDED.min_per_pallet,
              pcs_per_pallet = EXCLUDED.pcs_per_pallet,
              qty = EXCLUDED.qty,
              out_qty = EXCLUDED.out_qty,
              setup_minutes = EXCLUDED.setup_minutes,
              load_min_per_pallet = EXCLUDED.load_min_per_pallet,
              unload_min_per_pallet = EXCLUDED.unload_min_per_pallet,
              updated_at = NOW()
            """,
            (
                jid,
                max(0.1, float(override.get("minPerPallet") or 90)),
                max(1.0, float(override.get("pcsPerPallet") or 1)),
                max(0.0, float(override.get("qty") or 0)),
                max(0.0, float(override.get("out") or override.get("outQty") or 0)),
                max(0.0, float(override.get("setupMinutes") or 0)),
                _job_load_min_per_cycle(override),
                _job_unload_min_per_cycle(override),
            ),
        )

    for machine_id in touched_machine_ids:
        _sync_machine_queue(con, machine_id, primary_blocks_by_machine.get(machine_id, []))

    # Commit queue + block rows before segment rebuild so autosaves don't pile up waiting
    # on planner_mpp_lane row locks held through recalculate_machine.
    con.commit()

    # Capacity sheet / monthly overview sum planner_run_block_segment ΓÇö rebuild after MPP lane sync.
    from .blocks import recalculate_machine

    for machine_id in sorted(set(touched_machine_ids)):
        try:
            recalculate_machine(con, machine_id, reason="MPP_PLANNER_SAVE")
            con.commit()
        except Exception as exc:
            logger.warning("MPP queue recalculate machine %s: %s", machine_id, exc)
            save_warnings.append(f"Schedule segments not updated for machine {machine_id}: {exc}")
            _recover_db_transaction(con)

    return {
        "savedAt": datetime.now().isoformat(sep=" ", timespec="seconds"),
        "machinesTouched": len(touched_machine_ids),
        "blocksSynced": len(keep_block_ids),
        "warnings": save_warnings,
    }


def parse_mpp_job_id(job_id: str) -> dict[str, Any]:
    """Parse nps26-0293::p1::op10 style MPP job ids."""
    raw = compact_text(job_id)
    match = re.match(r"^(.+?)::p(\d+)::op(.+)$", raw, re.IGNORECASE)
    if not match:
        return {}
    op_token = match.group(3)
    op_no = op_token[2:] if op_token.lower().startswith("op") else op_token
    source_ps_id = normalize_standard_ps_id(compact_text(match.group(1)))
    return {
        "source_ps_id": source_ps_id,
        "pp_partial_no": max(1, int(match.group(2))),
        "op_no": op_no,
        "op_token": op_token,
        "source_op_seq_id": 0,
    }


def _canonical_planner_ps_id(con, source_ps_id: str, pp_partial_no: int) -> str:
    """Resolve planner_ps_id using existing rows regardless of PS id casing."""
    source_ps_id = normalize_standard_ps_id(source_ps_id)
    planner_ps_id = format_planner_ps_id(source_ps_id, pp_partial_no)
    if not planner_ps_id:
        return ""
    existing = one(
        con.execute(
            """
            SELECT planner_ps_id
            FROM planner_process_sheet
            WHERE UPPER(planner_ps_id) = UPPER(%s)
            LIMIT 1
            """,
            (planner_ps_id,),
        )
    )
    if existing:
        return compact_text(existing.get("planner_ps_id"))
    base, partial = parse_planner_ps_id(planner_ps_id)
    if base and partial > 1:
        existing = one(
            con.execute(
                """
                SELECT planner_ps_id
                FROM planner_process_sheet
                WHERE UPPER(source_ps_id) = UPPER(%s)
                  AND COALESCE(pp_partial_no, 1) = %s
                LIMIT 1
                """,
                (base, partial),
            )
        )
        if existing:
            return compact_text(existing.get("planner_ps_id"))
    return planner_ps_id


def _mpp_job_context(job_id: str, job_row: dict[str, Any]) -> dict[str, Any]:
    parsed = parse_mpp_job_id(job_id)
    source_ps_id = normalize_standard_ps_id(
        compact_text(
            job_row.get("sourcePsId")
            or job_row.get("source_ps_id")
            or parsed.get("source_ps_id")
        )
    )
    pp_partial_no = int(
        job_row.get("ppPartialNo")
        or job_row.get("pp_partial_no")
        or parsed.get("pp_partial_no")
        or 1
    )
    source_op_no = compact_text(
        job_row.get("sourceOpNo")
        or job_row.get("source_op_no")
        or parsed.get("op_no")
    )
    source_op_seq_id = int(
        job_row.get("opSeqId")
        or job_row.get("op_seq_id")
        or parsed.get("source_op_seq_id")
        or 0
    )
    return {
        "source_ps_id": source_ps_id,
        "pp_partial_no": pp_partial_no,
        "source_op_no": source_op_no,
        "source_op_seq_id": source_op_seq_id,
    }


_MPP_AUTO_DEQUEUE_LOCK_KEY = 915_042_002


def mpp_auto_dequeue_enabled() -> bool:
    from .auto_unschedule import auto_unschedule_enabled

    return auto_unschedule_enabled()


def _mpp_block_done_for_dequeue(block) -> bool:
    """MPP cycle ops leave the queue only after this block is actually finished on the lane."""
    if not block or not block.get("active", True):
        return False
    if compact_text(block.get("execution_status")).upper() in {"DONE", "COMPLETED"}:
        return True
    scheduled = float(block.get("scheduled_qty") or 0)
    if scheduled <= 0.0001:
        return False
    actual_good = float(block.get("actual_good_qty") or 0)
    return actual_good >= scheduled - 0.0001


def block_ready_for_mpp_auto_dequeue(con, block_id: int) -> bool:
    """True when a single MPP cycle-op block is done and should leave the queue."""
    from .machines import is_mpp_planner_machine_id

    block = one(
        con.execute(
            """
            SELECT b.block_id, b.machine_id, b.group_id, b.execution_status, b.active,
                   b.scheduled_qty, b.actual_good_qty,
                   o.source_ps_id, o.job_no, o.source_op_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not block or not block.get("active", True):
        return False
    if not is_mpp_planner_machine_id(con, int(block.get("machine_id") or 0)):
        return False
    linked = one(
        con.execute(
            "SELECT cycle_op_id FROM planner_mpp_cycle_op WHERE block_id = %s LIMIT 1",
            (int(block_id),),
        )
    )
    if not linked:
        return False
    return _mpp_block_done_for_dequeue(block)


def dequeue_done_mpp_block(
    con,
    block_id: int,
    *,
    reason: str = "AUTO_DONE",
    recalculate: bool = True,
) -> dict:
    """Remove a completed MPP cycle op (and its block) from the live queue."""
    ensure_mpp_queue_schema(con)
    op_row = one(
        con.execute(
            """
            SELECT co.cycle_op_id, co.cycle_id, c.machine_id, c.group_id
            FROM planner_mpp_cycle_op co
            JOIN planner_mpp_cycle c ON c.cycle_id = co.cycle_id
            WHERE co.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not op_row:
        return {"ok": False, "reason": "not_mpp_cycle_op", "block_id": int(block_id)}

    machine_id = int(op_row.get("machine_id") or 0)
    cycle_id = int(op_row.get("cycle_id") or 0)
    cycle_op_id = int(op_row.get("cycle_op_id") or 0)
    group_id = int(op_row.get("group_id") or 0)

    from .queue_exit_history_service import record_queue_exit_for_block

    try:
        record_queue_exit_for_block(
            con,
            int(block_id),
            reason=reason,
            exit_kind="MPP",
        )
    except Exception:
        pass

    con.execute("DELETE FROM planner_run_block WHERE block_id = %s", (int(block_id),))
    con.execute("DELETE FROM planner_mpp_cycle_op WHERE cycle_op_id = %s", (cycle_op_id,))

    remaining = rows(
        con.execute(
            "SELECT cycle_op_id FROM planner_mpp_cycle_op WHERE cycle_id = %s",
            (cycle_id,),
        )
    )
    if not remaining:
        con.execute("DELETE FROM planner_mpp_cycle WHERE cycle_id = %s", (cycle_id,))
        if group_id > 0:
            leftover = one(
                con.execute(
                    """
                    SELECT COUNT(*) AS cnt
                    FROM planner_run_block
                    WHERE group_id = %s
                    """,
                    (group_id,),
                )
            )
            if int((leftover or {}).get("cnt") or 0) == 0:
                con.execute(
                    "DELETE FROM planner_run_block_group WHERE group_id = %s",
                    (group_id,),
                )

    if recalculate and machine_id > 0:
        from .blocks import recalculate_machine
        from .operation_sequence import compact_machine_lane_queue

        try:
            compact_machine_lane_queue(con, machine_id, recalculate=False)
            recalculate_machine(con, machine_id, reason=f"MPP_AUTO_DEQUEUE_{reason}")
            con.commit()
        except Exception as exc:
            logger.warning("MPP dequeue recalculate machine %s: %s", machine_id, exc)
            _recover_db_transaction(con)

    return {
        "ok": True,
        "reason": reason,
        "block_id": int(block_id),
        "cycle_id": cycle_id,
        "machine_id": machine_id,
    }


def maybe_auto_dequeue_mpp_block(con, block_id: int) -> dict | None:
    if not mpp_auto_dequeue_enabled():
        return None
    if not block_ready_for_mpp_auto_dequeue(con, block_id):
        return None
    return dequeue_done_mpp_block(con, block_id, reason="AUTO_DONE_ACTUAL")


def find_done_mpp_queue_block_ids(con) -> list[int]:
    """Block ids for completed MPP cycle ops still present on machine lanes."""
    from .machines import fetch_mpp_planner_machine_ids

    mpp_ids = fetch_mpp_planner_machine_ids(con)
    if not mpp_ids:
        return []
    done: list[int] = []
    for row in rows(
        con.execute(
            """
            SELECT co.block_id
            FROM planner_mpp_cycle_op co
            JOIN planner_run_block b ON b.block_id = co.block_id
            WHERE co.block_id IS NOT NULL
              AND COALESCE(b.active, TRUE) = TRUE
              AND b.machine_id = ANY(%s)
            GROUP BY co.block_id, b.machine_id, b.queue_position
            ORDER BY b.machine_id, b.queue_position, co.block_id
            """,
            (mpp_ids,),
        )
    ):
        block_id = int(row.get("block_id") or 0)
        if block_id > 0 and block_ready_for_mpp_auto_dequeue(con, block_id):
            done.append(block_id)
    return done


def _try_mpp_dequeue_lock(con) -> bool:
    row = one(con.execute("SELECT pg_try_advisory_lock(%s) AS ok", (_MPP_AUTO_DEQUEUE_LOCK_KEY,)))
    return bool((row or {}).get("ok"))


def _release_mpp_dequeue_lock(con) -> None:
    con.execute("SELECT pg_advisory_unlock(%s)", (_MPP_AUTO_DEQUEUE_LOCK_KEY,))


def run_mpp_auto_dequeue_sweep(
    con,
    *,
    dry_run: bool = False,
    reason: str = "AUTO_DONE_SWEEP",
    recalculate: bool = True,
) -> dict:
    if not dry_run and not _try_mpp_dequeue_lock(con):
        return {"dry_run": False, "skipped": "locked", "candidates": 0, "dequeued": 0, "results": []}
    try:
        block_ids = find_done_mpp_queue_block_ids(con)
        if dry_run:
            return {"dry_run": True, "candidates": block_ids, "results": []}
        results = []
        touched_machines: set[int] = set()
        for block_id in block_ids:
            result = dequeue_done_mpp_block(con, block_id, reason=reason, recalculate=False)
            results.append(result)
            if result.get("ok") and int(result.get("machine_id") or 0) > 0:
                touched_machines.add(int(result["machine_id"]))
        if recalculate and touched_machines:
            from .blocks import recalculate_machine
            from .operation_sequence import compact_machine_lane_queue

            for machine_id in sorted(touched_machines):
                try:
                    compact_machine_lane_queue(con, machine_id, recalculate=False)
                    recalculate_machine(con, machine_id, reason=f"MPP_AUTO_DEQUEUE_{reason}")
                    con.commit()
                except Exception as exc:
                    logger.warning("MPP auto-dequeue recalculate machine %s: %s", machine_id, exc)
                    _recover_db_transaction(con)
        ok_count = sum(1 for item in results if item.get("ok"))
        return {
            "dry_run": False,
            "candidates": len(block_ids),
            "dequeued": ok_count,
            "results": results,
        }
    finally:
        if not dry_run:
            _release_mpp_dequeue_lock(con)


def mpp_auto_dequeue_on_page_load(con) -> dict | None:
    """Sweep completed MPP cycle ops when the MPP planner queue is loaded."""
    if not mpp_auto_dequeue_enabled():
        return None
    try:
        return run_mpp_auto_dequeue_sweep(con, reason="AUTO_DONE_PAGE_LOAD")
    except Exception as exc:
        logger.warning("MPP auto-dequeue sweep failed: %s", exc)
        _recover_db_transaction(con)
        return None
