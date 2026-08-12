"""ERP scanned-output jumps: accepted-qty increases detected on WO sync."""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .helpers import one, planner_try_savepoint, rows
from .process_sheets import format_planner_ps_id, parse_planner_ps_id
from .utils import PLANNER_TZ, compact_text, planner_wall_datetime_to_api

logger = logging.getLogger(__name__)

UNASSIGNED_MACHINE = "Unassigned"
_QTY_EPS = 1e-9
_MACHINE_NO_RE = re.compile(r"(\d+)")
_SCHEMA_READY = False
_MIGRATION_PATH = Path(__file__).resolve().parents[1] / "migrations" / "add_erp_qty_jump.sql"


def _float(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _int(value, default=0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def wo_stage_key(source_mps_no, pp_partial_no, stage_no) -> tuple[str, int, int]:
    return (compact_text(source_mps_no), max(1, _int(pp_partial_no, 1)), _int(stage_no, 0))


def machine_sort_key(machine_no: str) -> tuple:
    text = compact_text(machine_no) or UNASSIGNED_MACHINE
    if text == UNASSIGNED_MACHINE:
        return (1, 9999, text.lower())
    nums = _MACHINE_NO_RE.findall(text)
    return (0, int(nums[0]) if nums else 9999, text.lower())


def scanned_wall_date(when: datetime | None = None) -> date:
    stamp = when or datetime.now(timezone.utc)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(PLANNER_TZ).date()


def compute_qty_jumps(
    current_rows: list[dict],
    previous_by_key: dict[tuple[str, int, int], dict],
    *,
    scanned_at: datetime,
    scanned_date: date,
) -> list[dict]:
    """Return accepted-qty increases vs last known ERP cumulative for each WO stage.

    First observation of a key (no previous snapshot) is treated as baseline, not a jump.
    """
    jumps: list[dict] = []
    seen: set[tuple[str, int, int]] = set()
    if scanned_at.tzinfo is None:
        scanned_at = scanned_at.replace(tzinfo=timezone.utc)

    for raw in current_rows or []:
        if not isinstance(raw, dict):
            continue
        source_mps_no = compact_text(raw.get("source_mps_no"))
        stage_no = raw.get("stage_no")
        if not source_mps_no or stage_no is None:
            continue
        try:
            pp_partial_no = max(1, int(raw.get("pp_partial_no") or 1))
            stage_no = int(stage_no)
        except (TypeError, ValueError):
            continue
        key = wo_stage_key(source_mps_no, pp_partial_no, stage_no)
        if key in seen:
            continue
        seen.add(key)
        prev = previous_by_key.get(key)
        if not prev:
            continue
        new_acc = _float(raw.get("total_acc_qty_produced") or raw.get("acc_qty_produced"))
        new_rej = _float(raw.get("total_rej_qty_produced") or raw.get("acc_rej_qty_produced"))
        prev_acc = _float(prev.get("acc_qty_produced") or prev.get("new_acc_qty"))
        prev_rej = _float(prev.get("acc_rej_qty_produced") or prev.get("new_rej_qty"))
        qty_jump = new_acc - prev_acc
        if qty_jump <= _QTY_EPS:
            continue
        jumps.append(
            {
                "source_mps_no": source_mps_no,
                "pp_partial_no": pp_partial_no,
                "stage_no": stage_no,
                "stage_desc": compact_text(raw.get("stage_desc")),
                "op_no": compact_text(raw.get("op_no")),
                "part_no": compact_text(raw.get("part_no")),
                "part_desc": compact_text(raw.get("part_desc") or raw.get("description")),
                "job_no": compact_text(raw.get("job_no")),
                "so_no": compact_text(raw.get("so_no")),
                "prev_acc_qty": prev_acc,
                "new_acc_qty": new_acc,
                "qty_jump": qty_jump,
                "prev_rej_qty": prev_rej,
                "new_rej_qty": new_rej,
                "rej_jump": max(0.0, new_rej - prev_rej),
                "scanned_at": scanned_at,
                "scanned_date": scanned_date,
            }
        )
    return jumps


def jumps_from_snapshot_series(snapshots: list[dict]) -> list[dict]:
    """Walk chronological snapshots for one WO stage and emit accepted-qty jumps."""
    ordered = sorted(
        snapshots or [],
        key=lambda row: (
            compact_text(row.get("snapshot_date") or row.get("scanned_date")),
            compact_text(row.get("snapshot_at") or row.get("scanned_at")),
        ),
    )
    out: list[dict] = []
    prev = None
    for row in ordered:
        acc = _float(row.get("acc_qty_produced"))
        rej = _float(row.get("acc_rej_qty_produced"))
        scanned_date = compact_text(row.get("snapshot_date") or row.get("scanned_date"))
        scanned_at = row.get("snapshot_at") or row.get("scanned_at")
        if prev is None:
            prev = {"acc": acc, "rej": rej}
            continue
        qty_jump = acc - prev["acc"]
        if qty_jump > _QTY_EPS and scanned_date:
            out.append(
                {
                    "source_mps_no": compact_text(row.get("source_mps_no")),
                    "pp_partial_no": max(1, _int(row.get("pp_partial_no"), 1)),
                    "stage_no": _int(row.get("stage_no"), 0),
                    "stage_desc": compact_text(row.get("stage_desc")),
                    "prev_acc_qty": prev["acc"],
                    "new_acc_qty": acc,
                    "qty_jump": qty_jump,
                    "prev_rej_qty": prev["rej"],
                    "new_rej_qty": rej,
                    "rej_jump": max(0.0, rej - prev["rej"]),
                    "scanned_at": scanned_at,
                    "scanned_date": scanned_date,
                }
            )
        prev = {"acc": acc, "rej": rej}
    return out


def group_jumps_by_machine(jumps: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for jump in jumps or []:
        machine_no = compact_text(jump.get("machine_no")) or UNASSIGNED_MACHINE
        bucket = grouped.get(machine_no)
        if bucket is None:
            bucket = {
                "machine_id": jump.get("machine_id"),
                "machine_no": machine_no,
                "machine_category": compact_text(jump.get("machine_category")),
                "jump_count": 0,
                "qty_jump": 0.0,
                "rej_jump": 0.0,
                "jumps": [],
            }
            grouped[machine_no] = bucket
        bucket["jump_count"] += 1
        bucket["qty_jump"] += _float(jump.get("qty_jump"))
        bucket["rej_jump"] += _float(jump.get("rej_jump"))
        bucket["jumps"].append(jump)
        if not bucket.get("machine_id") and jump.get("machine_id"):
            bucket["machine_id"] = jump.get("machine_id")
        if not bucket.get("machine_category") and jump.get("machine_category"):
            bucket["machine_category"] = compact_text(jump.get("machine_category"))

    machines = list(grouped.values())
    for bucket in machines:
        bucket["jumps"].sort(
            key=lambda item: (
                compact_text(item.get("scanned_at")),
                compact_text(item.get("source_mps_no")),
                int(item.get("stage_no") or 0),
            ),
            reverse=True,
        )
        bucket["qty_jump"] = round(bucket["qty_jump"], 4)
        bucket["rej_jump"] = round(bucket["rej_jump"], 4)
    machines.sort(key=lambda item: machine_sort_key(item.get("machine_no") or ""))
    return machines


def apply_migration(con) -> None:
    if not _MIGRATION_PATH.is_file():
        return
    sql = _MIGRATION_PATH.read_text(encoding="utf-8")
    statement: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        statement.append(line)
        if stripped.endswith(";"):
            chunk = "\n".join(statement).strip()
            if chunk:
                con.execute(chunk)
            statement = []


def ensure_erp_qty_jump_table(con) -> None:
    """Hot-path check only; DDL runs from post-sync bootstrap."""
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    existing = one(con.execute("SELECT to_regclass('public.planner_erp_qty_jump') AS reg"))
    _SCHEMA_READY = bool(existing and existing.get("reg"))


def bootstrap_erp_qty_jump_schema(con) -> bool:
    """Create jump table if missing (call from ERP sync, not page load)."""
    global _SCHEMA_READY
    existing = one(con.execute("SELECT to_regclass('public.planner_erp_qty_jump') AS reg"))
    if existing and existing.get("reg"):
        _SCHEMA_READY = True
        return True
    apply_migration(con)
    existing = one(con.execute("SELECT to_regclass('public.planner_erp_qty_jump') AS reg"))
    _SCHEMA_READY = bool(existing and existing.get("reg"))
    return _SCHEMA_READY


def _apply_jump_filters(
    jumps: list[dict],
    *,
    machine_no: str = "",
    search: str = "",
    limit: int = 2000,
) -> list[dict]:
    machine_filter = compact_text(machine_no)
    search_text = compact_text(search).lower()
    filtered = jumps
    if machine_filter:
        if machine_filter == UNASSIGNED_MACHINE:
            filtered = [row for row in filtered if not compact_text(row.get("machine_no"))]
        else:
            filtered = [
                row for row in filtered
                if compact_text(row.get("machine_no")) == machine_filter
            ]
    if search_text:
        def _haystack(row):
            return " ".join(
                compact_text(row.get(key))
                for key in (
                    "source_mps_no", "part_no", "part_desc", "job_no", "so_no",
                    "stage_desc", "op_no", "machine_no",
                )
            ).lower()

        filtered = [row for row in filtered if search_text in _haystack(row)]
    cap = max(1, min(_int(limit, 2000), 5000))
    return filtered[:cap]


def _fetch_snapshot_jump_rows(
    con,
    start: date,
    end: date,
    *,
    limit: int = 5000,
) -> list[dict]:
    """Read-only day-over-day deltas from WO snapshots (no jump-table backfill)."""
    cap = max(1, min(_int(limit, 5000), 10000))
    return rows(
        con.execute(
            """
            WITH ordered AS (
                SELECT
                    source_mps_no,
                    pp_partial_no,
                    stage_no,
                    snapshot_date::date AS scanned_date,
                    snapshot_at AS scanned_at,
                    acc_qty_produced,
                    acc_rej_qty_produced,
                    LAG(acc_qty_produced) OVER w AS prev_acc_qty,
                    LAG(acc_rej_qty_produced) OVER w AS prev_rej_qty
                FROM planner_erp_wo_qty_snapshot
                WINDOW w AS (
                    PARTITION BY source_mps_no, pp_partial_no, stage_no
                    ORDER BY snapshot_date, snapshot_at
                )
            )
            SELECT
                source_mps_no,
                pp_partial_no,
                stage_no,
                scanned_date,
                scanned_at,
                prev_acc_qty,
                acc_qty_produced AS new_acc_qty,
                GREATEST(0, acc_qty_produced - prev_acc_qty) AS qty_jump,
                prev_rej_qty,
                acc_rej_qty_produced AS new_rej_qty,
                GREATEST(0, acc_rej_qty_produced - COALESCE(prev_rej_qty, 0)) AS rej_jump
            FROM ordered
            WHERE prev_acc_qty IS NOT NULL
              AND acc_qty_produced > prev_acc_qty + 0.000001
              AND scanned_date >= %s
              AND scanned_date <= %s
            ORDER BY scanned_at DESC
            LIMIT %s
            """,
            (start, end, cap),
        )
    )


def _load_jump_rows_from_table(
    con,
    start: date,
    end: date,
    *,
    machine_no: str = "",
    search: str = "",
    limit: int = 2000,
) -> list[dict]:
    machine_filter = compact_text(machine_no)
    search_text = compact_text(search)
    cap = max(1, min(_int(limit, 2000), 5000))
    params: list[Any] = [start, end]
    where = ["scanned_date >= %s", "scanned_date <= %s"]
    if machine_filter and machine_filter != UNASSIGNED_MACHINE:
        where.append("machine_no = %s")
        params.append(machine_filter)
    elif machine_filter == UNASSIGNED_MACHINE:
        where.append("COALESCE(machine_no, '') = ''")
    if search_text:
        where.append(
            """
            (
                source_mps_no ILIKE %s
                OR part_no ILIKE %s
                OR part_desc ILIKE %s
                OR job_no ILIKE %s
                OR so_no ILIKE %s
                OR stage_desc ILIKE %s
                OR op_no ILIKE %s
                OR machine_no ILIKE %s
            )
            """
        )
        like = f"%{search_text}%"
        params.extend([like] * 8)
    params.append(cap)
    return rows(
        con.execute(
            f"""
            SELECT jump_id, source_mps_no, pp_partial_no, stage_no, stage_desc, op_no,
                   part_no, part_desc, job_no, so_no,
                   prev_acc_qty, new_acc_qty, qty_jump,
                   prev_rej_qty, new_rej_qty, rej_jump,
                   scanned_at, scanned_date, machine_id, machine_no, machine_category
            FROM planner_erp_qty_jump
            WHERE {' AND '.join(where)}
            ORDER BY scanned_at DESC, jump_id DESC
            LIMIT %s
            """,
            tuple(params),
        )
    )


def _previous_qty_by_key(con, keys: list[tuple[str, int, int]]) -> dict[tuple[str, int, int], dict]:
    if not keys:
        return {}
    mps_nos = sorted({key[0] for key in keys})
    snapshot_rows = rows(
        con.execute(
            """
            SELECT DISTINCT ON (source_mps_no, pp_partial_no, stage_no)
                   source_mps_no, pp_partial_no, stage_no,
                   acc_qty_produced, acc_rej_qty_produced, snapshot_at
            FROM planner_erp_wo_qty_snapshot
            WHERE source_mps_no = ANY(%s)
            ORDER BY source_mps_no, pp_partial_no, stage_no, snapshot_at DESC
            """,
            (mps_nos,),
        )
    )
    jump_rows = planner_try_savepoint(
        con,
        "erp_jump_prev",
        lambda: rows(
            con.execute(
                """
                SELECT DISTINCT ON (source_mps_no, pp_partial_no, stage_no)
                       source_mps_no, pp_partial_no, stage_no,
                       new_acc_qty AS acc_qty_produced,
                       new_rej_qty AS acc_rej_qty_produced,
                       scanned_at AS snapshot_at
                FROM planner_erp_qty_jump
                WHERE source_mps_no = ANY(%s)
                ORDER BY source_mps_no, pp_partial_no, stage_no, scanned_at DESC
                """,
                (mps_nos,),
            )
        ),
        default=[],
    ) or []
    wanted = set(keys)
    previous: dict[tuple[str, int, int], dict] = {}
    for row in snapshot_rows + jump_rows:
        key = wo_stage_key(row.get("source_mps_no"), row.get("pp_partial_no"), row.get("stage_no"))
        if key not in wanted:
            continue
        existing = previous.get(key)
        stamp = compact_text(row.get("snapshot_at"))
        if existing is None or stamp >= compact_text(existing.get("snapshot_at")):
            previous[key] = {
                "acc_qty_produced": _float(row.get("acc_qty_produced")),
                "acc_rej_qty_produced": _float(row.get("acc_rej_qty_produced")),
                "snapshot_at": stamp,
            }
    return previous


def _pick_machine_row(candidates: list[dict]) -> dict | None:
    if not candidates:
        return None

    def _rank(row):
        status = compact_text(row.get("execution_status")).upper()
        in_progress = 0 if status in {"IN_PROCESS", "IN_PROGRESS", "RUNNING", "I"} else 1
        return (
            in_progress,
            _int(row.get("queue_position"), 9999),
            -_float(row.get("scheduled_qty")),
        )

    return sorted(candidates, key=_rank)[0]


def _load_machine_assignments(con) -> dict[tuple[str, int, int], dict]:
    live_rows = rows(
        con.execute(
            """
            SELECT
                ps.source_ps_id AS source_mps_no,
                ps.pp_partial_no,
                COALESCE(seq.source_stage_no, 0) AS stage_no,
                m.machine_id,
                m.machine_no,
                m.machine_category,
                ps.inventory_code AS part_no,
                o.source_op_no AS op_no,
                o.job_no,
                b.execution_status,
                b.queue_position,
                b.scheduled_qty
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            JOIN planner_process_sheet ps ON ps.planner_ps_id = o.source_ps_id
            LEFT JOIN planner_operation_seq seq ON seq.op_seq_id = o.source_op_seq_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(b.machine_id, 0) > 0
            """
        )
    )
    grouped: dict[tuple[str, int, int], list[dict]] = {}
    for row in live_rows:
        key = wo_stage_key(row.get("source_mps_no"), row.get("pp_partial_no"), row.get("stage_no"))
        if not key[0] or key[2] <= 0:
            continue
        grouped.setdefault(key, []).append(row)
    assigned = {key: _pick_machine_row(items) for key, items in grouped.items()}

    exit_exists = one(
        con.execute("SELECT to_regclass('public.planner_queue_exit_history') AS reg")
    )
    if exit_exists and exit_exists.get("reg"):
        exit_rows = rows(
            con.execute(
                """
                SELECT DISTINCT ON (source_ps_id, pp_partial_no, stage_no)
                       source_ps_id, pp_partial_no, stage_no,
                       machine_id, machine_no, part_no, source_op_no AS op_no
                FROM planner_queue_exit_history
                WHERE COALESCE(machine_no, '') <> ''
                ORDER BY source_ps_id, pp_partial_no, stage_no, exited_at DESC
                """
            )
        )
        for row in exit_rows:
            raw_ps = compact_text(row.get("source_ps_id"))
            source_mps_no, parsed_partial = parse_planner_ps_id(raw_ps)
            pp_partial_no = _int(row.get("pp_partial_no"), parsed_partial)
            key = wo_stage_key(source_mps_no or raw_ps, pp_partial_no, row.get("stage_no"))
            if key[2] <= 0 or key in assigned:
                continue
            assigned[key] = {
                "machine_id": row.get("machine_id"),
                "machine_no": compact_text(row.get("machine_no")),
                "machine_category": "",
                "part_no": compact_text(row.get("part_no")),
                "op_no": compact_text(row.get("op_no")),
                "job_no": "",
            }

    preferred_rows = planner_try_savepoint(
        con,
        "erp_jump_preferred",
        lambda: rows(
            con.execute(
                """
                SELECT
                    ps.source_ps_id AS source_mps_no,
                    ps.pp_partial_no,
                    COALESCE(seq.source_stage_no, 0) AS stage_no,
                    m.machine_id,
                    m.machine_no,
                    m.machine_category,
                    ps.inventory_code AS part_no,
                    seq.op_no
                FROM planner_process_sheet ps
                JOIN planner_operation_seq seq ON seq.bom_id = ps.selected_bom_id
                JOIN planner_machines m ON m.machine_no = seq.preferred_machine
                WHERE COALESCE(seq.preferred_machine, '') <> ''
                  AND COALESCE(seq.source_stage_no, 0) > 0
                """
            )
        ),
        default=[],
    ) or []
    for row in preferred_rows:
        key = wo_stage_key(row.get("source_mps_no"), row.get("pp_partial_no"), row.get("stage_no"))
        if not key[0] or key[2] <= 0 or key in assigned:
            continue
        assigned[key] = {
            "machine_id": row.get("machine_id"),
            "machine_no": compact_text(row.get("machine_no")),
            "machine_category": compact_text(row.get("machine_category")),
            "part_no": compact_text(row.get("part_no")),
            "op_no": compact_text(row.get("op_no")),
            "job_no": "",
        }
    return assigned


def _load_voucher_meta(con, keys: list[tuple[str, int, int]]) -> dict[tuple[str, int, int], dict]:
    if not keys:
        return {}
    ps_ids = sorted({key[0] for key in keys} | {format_planner_ps_id(key[0], key[1]) for key in keys})
    voucher_rows = rows(
        con.execute(
            """
            SELECT DISTINCT ON (ps_id, pp_partial_no, stage_no)
                   ps_id, pp_partial_no, stage_no, part_no, description,
                   stage_desc, op_no::text AS op_no
            FROM pp_vouchers_cache
            WHERE ps_id = ANY(%s)
            ORDER BY ps_id, pp_partial_no, stage_no, _synced_at DESC NULLS LAST
            """,
            (ps_ids,),
        )
    )
    wanted = set(keys)
    meta: dict[tuple[str, int, int], dict] = {}
    for row in voucher_rows:
        raw_ps = compact_text(row.get("ps_id"))
        source_mps_no, parsed_partial = parse_planner_ps_id(raw_ps)
        pp_partial_no = _int(row.get("pp_partial_no"), parsed_partial)
        key = wo_stage_key(source_mps_no or raw_ps, pp_partial_no, row.get("stage_no"))
        if key not in wanted:
            continue
        meta[key] = {
            "part_no": compact_text(row.get("part_no")),
            "part_desc": compact_text(row.get("description")),
            "stage_desc": compact_text(row.get("stage_desc")),
            "op_no": compact_text(row.get("op_no")),
        }
    return meta


def _enrich_jumps(con, jumps: list[dict]) -> list[dict]:
    if not jumps:
        return []
    keys = [
        wo_stage_key(item.get("source_mps_no"), item.get("pp_partial_no"), item.get("stage_no"))
        for item in jumps
    ]
    assigned = planner_try_savepoint(
        con, "erp_jump_machines", lambda: _load_machine_assignments(con), default={}
    ) or {}
    voucher_meta = planner_try_savepoint(
        con, "erp_jump_vouchers", lambda: _load_voucher_meta(con, keys), default={}
    ) or {}
    enriched = []
    for item in jumps:
        row = dict(item)
        key = wo_stage_key(row.get("source_mps_no"), row.get("pp_partial_no"), row.get("stage_no"))
        machine = assigned.get(key) or {}
        meta = voucher_meta.get(key) or {}
        row["machine_id"] = machine.get("machine_id")
        row["machine_no"] = compact_text(machine.get("machine_no"))
        row["machine_category"] = compact_text(machine.get("machine_category"))
        row["part_no"] = compact_text(row.get("part_no")) or compact_text(machine.get("part_no")) or compact_text(meta.get("part_no"))
        row["part_desc"] = compact_text(row.get("part_desc")) or compact_text(meta.get("part_desc"))
        row["stage_desc"] = compact_text(row.get("stage_desc")) or compact_text(meta.get("stage_desc"))
        row["op_no"] = compact_text(row.get("op_no")) or compact_text(machine.get("op_no")) or compact_text(meta.get("op_no"))
        row["job_no"] = compact_text(row.get("job_no")) or compact_text(machine.get("job_no"))
        enriched.append(row)
    return enriched


def _insert_jumps(con, jumps: list[dict]) -> int:
    if not jumps:
        return 0
    payload = [
        (
            item["source_mps_no"],
            int(item["pp_partial_no"]),
            int(item["stage_no"]),
            compact_text(item.get("stage_desc")),
            compact_text(item.get("op_no")),
            compact_text(item.get("part_no")),
            compact_text(item.get("part_desc")),
            compact_text(item.get("job_no")),
            compact_text(item.get("so_no")),
            _float(item.get("prev_acc_qty")),
            _float(item.get("new_acc_qty")),
            _float(item.get("qty_jump")),
            _float(item.get("prev_rej_qty")),
            _float(item.get("new_rej_qty")),
            _float(item.get("rej_jump")),
            item.get("scanned_at"),
            item.get("scanned_date"),
            item.get("machine_id"),
            compact_text(item.get("machine_no")),
            compact_text(item.get("machine_category")),
        )
        for item in jumps
    ]
    con.executemany(
        """
        INSERT INTO planner_erp_qty_jump (
            source_mps_no, pp_partial_no, stage_no, stage_desc, op_no,
            part_no, part_desc, job_no, so_no,
            prev_acc_qty, new_acc_qty, qty_jump,
            prev_rej_qty, new_rej_qty, rej_jump,
            scanned_at, scanned_date, machine_id, machine_no, machine_category
        ) VALUES (
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s, %s, %s
        )
        ON CONFLICT (source_mps_no, pp_partial_no, stage_no, prev_acc_qty, new_acc_qty, scanned_date)
        DO NOTHING
        """,
        payload,
    )
    return len(payload)


def record_erp_qty_jumps(con, mfg_rows, synced_at=None, columns=None) -> int:
    """Insert jump rows for accepted-qty increases vs the last known snapshot/jump."""
    if not mfg_rows:
        return 0
    ensure_erp_qty_jump_table(con)
    if not _SCHEMA_READY:
        return 0
    current: list[dict] = []
    for raw in mfg_rows:
        if isinstance(raw, dict):
            current.append(raw)
        elif columns and isinstance(raw, (list, tuple)):
            current.append(dict(zip(columns, raw)))
    keys = []
    for row in current:
        source_mps_no = compact_text(row.get("source_mps_no"))
        if not source_mps_no or row.get("stage_no") is None:
            continue
        try:
            keys.append(wo_stage_key(source_mps_no, row.get("pp_partial_no"), row.get("stage_no")))
        except (TypeError, ValueError):
            continue
    when = synced_at or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    previous = _previous_qty_by_key(con, keys)
    jumps = compute_qty_jumps(
        current,
        previous,
        scanned_at=when,
        scanned_date=scanned_wall_date(when),
    )
    if not jumps:
        return 0
    enriched = _enrich_jumps(con, jumps)
    return _insert_jumps(con, enriched)


def backfill_jumps_from_snapshots(con) -> int:
    """Seed jump history from existing daily snapshots when the jump table is empty."""
    ensure_erp_qty_jump_table(con)
    existing = one(con.execute("SELECT COUNT(*) AS n FROM planner_erp_qty_jump")) or {}
    if _int(existing.get("n"), 0) > 0:
        return 0
    snapshot_rows = rows(
        con.execute(
            """
            SELECT source_mps_no, pp_partial_no, stage_no,
                   snapshot_date::text AS snapshot_date,
                   snapshot_at, acc_qty_produced, acc_rej_qty_produced
            FROM planner_erp_wo_qty_snapshot
            ORDER BY source_mps_no, pp_partial_no, stage_no, snapshot_date, snapshot_at
            """
        )
    )
    if not snapshot_rows:
        return 0
    by_key: dict[tuple[str, int, int], list[dict]] = {}
    for row in snapshot_rows:
        key = wo_stage_key(row.get("source_mps_no"), row.get("pp_partial_no"), row.get("stage_no"))
        by_key.setdefault(key, []).append(row)
    jumps: list[dict] = []
    for series in by_key.values():
        jumps.extend(jumps_from_snapshot_series(series))
    if not jumps:
        return 0
    enriched = _enrich_jumps(con, jumps)
    return _insert_jumps(con, enriched)


def _serialize_jump(row: dict) -> dict:
    scanned_at = planner_wall_datetime_to_api(row.get("scanned_at"))
    scanned_date = row.get("scanned_date")
    if hasattr(scanned_date, "isoformat"):
        scanned_date = scanned_date.isoformat()
    return {
        "jump_id": _int(row.get("jump_id"), 0),
        "source_mps_no": compact_text(row.get("source_mps_no")),
        "pp_partial_no": max(1, _int(row.get("pp_partial_no"), 1)),
        "stage_no": _int(row.get("stage_no"), 0),
        "stage_desc": compact_text(row.get("stage_desc")),
        "op_no": compact_text(row.get("op_no")),
        "part_no": compact_text(row.get("part_no")),
        "part_desc": compact_text(row.get("part_desc")),
        "job_no": compact_text(row.get("job_no")),
        "so_no": compact_text(row.get("so_no")),
        "prev_acc_qty": _float(row.get("prev_acc_qty")),
        "new_acc_qty": _float(row.get("new_acc_qty")),
        "qty_jump": _float(row.get("qty_jump")),
        "prev_rej_qty": _float(row.get("prev_rej_qty")),
        "new_rej_qty": _float(row.get("new_rej_qty")),
        "rej_jump": _float(row.get("rej_jump")),
        "scanned_at": scanned_at,
        "scanned_date": compact_text(scanned_date),
        "machine_id": row.get("machine_id"),
        "machine_no": compact_text(row.get("machine_no")) or UNASSIGNED_MACHINE,
        "machine_category": compact_text(row.get("machine_category")),
    }


def _parse_iso_date(raw: str | None, fallback: date) -> date:
    text = compact_text(raw)
    if not text:
        return fallback
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return fallback


def fetch_scanned_output(
    con,
    *,
    from_date: str = "",
    to_date: str = "",
    machine_no: str = "",
    search: str = "",
    limit: int = 2000,
) -> dict[str, Any]:
    con.execute("SET LOCAL statement_timeout = '30s'")
    ensure_erp_qty_jump_table(con)

    today = scanned_wall_date()
    end = _parse_iso_date(to_date, today)
    start = _parse_iso_date(from_date, end - timedelta(days=13))
    if start > end:
        start, end = end, start

    data_source = "none"
    jump_rows: list[dict] = []

    if _SCHEMA_READY:
        jump_rows = _load_jump_rows_from_table(
            con,
            start,
            end,
            machine_no=machine_no,
            search=search,
            limit=limit,
        )
        if jump_rows:
            data_source = "jumps"

    if not jump_rows:
        snapshot_rows = planner_try_savepoint(
            con,
            "erp_jump_snapshots",
            lambda: _fetch_snapshot_jump_rows(con, start, end, limit=max(limit * 2, 5000)),
            default=[],
        ) or []
        if snapshot_rows:
            # Keep page load fast: skip full machine enrichment here. Sync-time
            # jump rows already store machine_no; snapshot fallback still shows qty/date.
            jump_rows = _apply_jump_filters(
                [dict(row) for row in snapshot_rows],
                machine_no=machine_no,
                search=search,
                limit=limit,
            )
            data_source = "snapshots"

    jumps = [_serialize_jump(row) for row in jump_rows]
    machines = group_jumps_by_machine(jumps)
    today_qty = sum(
        _float(item.get("qty_jump"))
        for item in jumps
        if item.get("scanned_date") == today.isoformat()
    )

    if _SCHEMA_READY:
        machine_options = rows(
            con.execute(
                """
                SELECT machine_no, COUNT(*) AS jump_count, COALESCE(SUM(qty_jump), 0) AS qty_jump
                FROM planner_erp_qty_jump
                WHERE scanned_date >= %s AND scanned_date <= %s
                GROUP BY machine_no
                ORDER BY machine_no
                """,
                (start, end),
            )
        )
    else:
        machine_options = []

    if not machine_options and jumps:
        grouped: dict[str, dict] = {}
        for item in jumps:
            machine_key = compact_text(item.get("machine_no")) or UNASSIGNED_MACHINE
            bucket = grouped.setdefault(
                machine_key,
                {"machine_no": machine_key, "jump_count": 0, "qty_jump": 0.0},
            )
            bucket["jump_count"] += 1
            bucket["qty_jump"] += _float(item.get("qty_jump"))
        machine_options = list(grouped.values())

    options = [
        {
            "machine_no": compact_text(row.get("machine_no")) or UNASSIGNED_MACHINE,
            "jump_count": _int(row.get("jump_count"), 0),
            "qty_jump": _float(row.get("qty_jump")),
        }
        for row in machine_options
    ]
    options.sort(key=lambda item: machine_sort_key(item["machine_no"]))
    return {
        "from_date": start.isoformat(),
        "to_date": end.isoformat(),
        "today": today.isoformat(),
        "data_source": data_source,
        "jumps": jumps,
        "machines": machines,
        "machine_options": options,
        "stats": {
            "jump_count": len(jumps),
            "qty_jump": round(sum(_float(item.get("qty_jump")) for item in jumps), 4),
            "rej_jump": round(sum(_float(item.get("rej_jump")) for item in jumps), 4),
            "machine_count": len(machines),
            "today_qty_jump": round(today_qty, 4),
        },
    }
