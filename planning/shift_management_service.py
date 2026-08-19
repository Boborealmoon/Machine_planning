"""Shift Management - Day/Night handover CRUD, ops queue, tickets, KPIs."""
from __future__ import annotations

import logging
import re
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from .helpers import one, rows
from .utils import compact_text

log = logging.getLogger(__name__)

MACHINE_STATUSES = ("Running", "Idle", "Breakdown", "Under Maintenance", "Setup")
FIRST_PIECE_STATUSES = ("OK", "Not OK", "Pending Approval", "N/A")
PRIORITIES = ("Normal", "High", "Urgent")
NCR_STATUSES = ("Open", "Closed", "N/A")
MATERIAL_UNITS = ("kg", "pcs", "m", "bar")
SHIFTS = ("Day", "Night")
TICKET_CATEGORIES = (
    "Quality",
    "Alarm",
    "Maintenance",
    "Material",
    "Tooling",
    "Urgent",
    "Other",
)
TICKET_STATUSES = ("open", "in_progress", "closed")

# Day 07:00-19:00, Night 19:00-07:00
DAY_START_HOUR = 7
NIGHT_START_HOUR = 19

EDITABLE_FIELDS = frozenset(
    {
        "job_no",
        "machine_status",
        "remaining_qty",
        "first_piece_status",
        "tool_life_pct",
        "material_qty",
        "material_unit",
        "quality_issue_flag",
        "quality_issue_text",
        "alarm_flag",
        "alarm_text",
        "maintenance_flag",
        "maintenance_text",
        "priority",
        "priority_note",
        "ncr_status",
        "ncr_ref",
        "remarks",
        "shift_in",
    }
)

_schema_ready = False
_MIGRATION_PATH = Path(__file__).resolve().parent.parent / "migrations" / "add_shift_management.sql"


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bool):
        return value
    return value


def serialize_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {k: _jsonable(v) for k, v in row.items()}


serialize_handover = serialize_row


def display_ps_id(source_ps_id: Any = None, job_no: Any = None) -> str:
    raw = compact_text(source_ps_id) or compact_text(job_no) or ""
    if "::" in raw:
        return raw.split("::", 1)[0]
    return raw


def normalize_shift(value: Any, fallback: str | None = None) -> str:
    text = compact_text(value)
    legacy = {"A": "Day", "B": "Night", "C": "Night"}
    if text in legacy:
        text = legacy[text]
    if text in SHIFTS:
        return text
    if fallback and fallback in SHIFTS:
        return fallback
    return _guess_shift()


def opposite_shift(shift: str) -> str:
    return "Night" if normalize_shift(shift) == "Day" else "Day"


def _try_migration_step(con, name: str, fn, *, warn: bool = False) -> bool:
    """Run an optional schema step inside a SAVEPOINT so failures do not abort the tx."""
    sp = f"sm_{re.sub(r'[^a-zA-Z0-9_]', '_', name)[:50]}"
    con.execute(f"SAVEPOINT {sp}")
    try:
        fn()
        con.execute(f"RELEASE SAVEPOINT {sp}")
        return True
    except Exception:
        try:
            con.execute(f"ROLLBACK TO SAVEPOINT {sp}")
        except Exception:
            pass
        (log.warning if warn else log.debug)(
            "shift_mgmt schema step failed (%s); continuing", name, exc_info=True
        )
        return False


def _apply_migration_sql(con) -> None:
    if not _MIGRATION_PATH.is_file():
        _ensure_tables_piecemeal(con)
        return
    sql = _MIGRATION_PATH.read_text(encoding="utf-8")
    statement: list[str] = []
    idx = 0
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        statement.append(line)
        if stripped.endswith(";"):
            chunk = "\n".join(statement).strip()
            if chunk:
                idx += 1
                # Existing DBs may already have older CHECKs / indexes; isolate each stmt.
                _try_migration_step(
                    con,
                    f"sm_mig_{idx}",
                    lambda sql=chunk: con.execute(sql),
                )
            statement = []


def ensure_shift_mgmt_schema(con) -> None:
    global _schema_ready
    if _schema_ready:
        return
    from .shift_management_auth import ensure_shift_mgmt_auth_tables, seed_demo_users_if_empty

    ensure_shift_mgmt_auth_tables(con)
    try:
        _apply_migration_sql(con)
    except Exception:
        log.warning("shift_mgmt migration apply failed; ensuring tables piecemeal", exc_info=True)
        _try_migration_step(
            con, "sm_piecemeal", lambda: _ensure_tables_piecemeal(con), warn=True
        )
    _try_migration_step(con, "sm_extra_tables", lambda: _ensure_extra_tables(con), warn=True)
    _migrate_abc_to_day_night(con)
    _try_migration_step(con, "sm_seed_demo", lambda: seed_demo_users_if_empty(con))
    _try_migration_step(con, "sm_cnc41", lambda: _ensure_cnc41_machine(con), warn=True)
    _schema_ready = True


def _ensure_cnc41_machine(con) -> None:
    """CNC 41 (I-800 MPP) must appear in My Machines alongside the rest of the fleet."""
    con.execute(
        """
        INSERT INTO public.planner_machines (machine_no, machine_category, shift_profile, active)
        VALUES ('CNC 41', 'MPP', 'STANDARD', TRUE)
        ON CONFLICT (machine_no) DO UPDATE
        SET active = TRUE,
            machine_category = EXCLUDED.machine_category
        """
    )


def floor_layout_payload() -> dict[str, Any]:
    """Factory floor geometry for the Shift Management machine picker."""
    from .floor_plan_service import (
        FLOOR_LAYOUT_COLORS,
        FLOOR_LAYOUT_HEIGHT,
        FLOOR_LAYOUT_MACHINES,
        FLOOR_LAYOUT_WIDTH,
        compute_layout_bounds,
    )

    return {
        "machines": [dict(m) for m in FLOOR_LAYOUT_MACHINES],
        "colors": dict(FLOOR_LAYOUT_COLORS),
        "bounds": compute_layout_bounds(FLOOR_LAYOUT_MACHINES),
        "width": FLOOR_LAYOUT_WIDTH,
        "height": FLOOR_LAYOUT_HEIGHT,
    }


def _drop_checks_on_columns(con, table: str, columns: tuple[str, ...]) -> None:
    for col in columns:
        constraints = rows(
            con.execute(
                """
                SELECT c.conname
                FROM pg_constraint c
                JOIN pg_class t ON t.oid = c.conrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = 'public'
                  AND t.relname = %s
                  AND c.contype = 'c'
                  AND pg_get_constraintdef(c.oid) ILIKE %s
                """,
                (table, f"%{col}%"),
            )
        )
        for row in constraints:
            name = compact_text(row.get("conname"))
            if name:
                con.execute(f'ALTER TABLE public.{table} DROP CONSTRAINT IF EXISTS "{name}"')


def _migrate_abc_to_day_night(con) -> None:
    """Map legacy A/B/C shifts to Day/Night and refresh CHECK constraints."""

    def _update_users():
        con.execute(
            """
            UPDATE public.shift_mgmt_users
            SET default_shift = CASE
                WHEN default_shift = 'A' THEN 'Day'
                WHEN default_shift IN ('B', 'C') THEN 'Night'
                ELSE default_shift
            END
            WHERE default_shift IN ('A', 'B', 'C')
            """
        )

    def _update_handovers():
        con.execute(
            """
            UPDATE public.shift_mgmt_handovers
            SET shift_out = CASE
                WHEN shift_out = 'A' THEN 'Day'
                WHEN shift_out IN ('B', 'C') THEN 'Night'
                ELSE shift_out
            END
            WHERE shift_out IN ('A', 'B', 'C')
            """
        )
        con.execute(
            """
            UPDATE public.shift_mgmt_handovers
            SET shift_in = CASE
                WHEN shift_in = 'A' THEN 'Day'
                WHEN shift_in IN ('B', 'C') THEN 'Night'
                ELSE shift_in
            END
            WHERE shift_in IN ('A', 'B', 'C')
            """
        )

    def _update_tickets():
        con.execute(
            """
            UPDATE public.shift_mgmt_tickets
            SET shift_out = CASE
                WHEN shift_out = 'A' THEN 'Day'
                WHEN shift_out IN ('B', 'C') THEN 'Night'
                ELSE shift_out
            END
            WHERE shift_out IN ('A', 'B', 'C')
            """
        )

    def _refresh_users_check():
        con.execute(
            "ALTER TABLE public.shift_mgmt_users "
            "DROP CONSTRAINT IF EXISTS shift_mgmt_users_default_shift_check"
        )
        _drop_checks_on_columns(con, "shift_mgmt_users", ("default_shift",))
        con.execute(
            """
            ALTER TABLE public.shift_mgmt_users
            ADD CONSTRAINT shift_mgmt_users_default_shift_check
            CHECK (default_shift IS NULL OR default_shift IN ('Day', 'Night'))
            """
        )

    def _refresh_handovers_check():
        con.execute(
            "ALTER TABLE public.shift_mgmt_handovers "
            "DROP CONSTRAINT IF EXISTS shift_mgmt_handovers_shift_out_check"
        )
        con.execute(
            "ALTER TABLE public.shift_mgmt_handovers "
            "DROP CONSTRAINT IF EXISTS shift_mgmt_handovers_shift_in_check"
        )
        _drop_checks_on_columns(con, "shift_mgmt_handovers", ("shift_out", "shift_in"))
        con.execute(
            """
            ALTER TABLE public.shift_mgmt_handovers
            ADD CONSTRAINT shift_mgmt_handovers_shift_out_check
            CHECK (shift_out IN ('Day', 'Night'))
            """
        )
        con.execute(
            """
            ALTER TABLE public.shift_mgmt_handovers
            ADD CONSTRAINT shift_mgmt_handovers_shift_in_check
            CHECK (shift_in IS NULL OR shift_in IN ('Day', 'Night'))
            """
        )

    def _refresh_tickets_check():
        con.execute(
            "ALTER TABLE public.shift_mgmt_tickets "
            "DROP CONSTRAINT IF EXISTS shift_mgmt_tickets_shift_out_check"
        )
        _drop_checks_on_columns(con, "shift_mgmt_tickets", ("shift_out",))
        con.execute(
            """
            ALTER TABLE public.shift_mgmt_tickets
            ADD CONSTRAINT shift_mgmt_tickets_shift_out_check
            CHECK (shift_out IS NULL OR shift_out IN ('Day', 'Night'))
            """
        )

    _try_migration_step(con, "sm_mig_users_shift", _update_users)
    _try_migration_step(con, "sm_mig_ho_shift", _update_handovers)
    _try_migration_step(con, "sm_mig_tk_shift", _update_tickets)
    _try_migration_step(con, "sm_chk_users_shift", _refresh_users_check)
    _try_migration_step(con, "sm_chk_ho_shift", _refresh_handovers_check)
    _try_migration_step(con, "sm_chk_tk_shift", _refresh_tickets_check)


def _ensure_extra_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_handover_comments (
            comment_id      BIGSERIAL    PRIMARY KEY,
            handover_id     BIGINT       NOT NULL
                REFERENCES public.shift_mgmt_handovers(handover_id) ON DELETE CASCADE,
            user_id         BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            body            TEXT         NOT NULL,
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shift_mgmt_ho_comments_ho
            ON public.shift_mgmt_handover_comments (handover_id, created_at ASC)
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_tickets (
            ticket_id       BIGSERIAL    PRIMARY KEY,
            machine_id      BIGINT       NOT NULL
                REFERENCES public.planner_machines(machine_id) ON DELETE RESTRICT,
            planner_ps_id   TEXT         NOT NULL DEFAULT '',
            job_no          TEXT         NOT NULL DEFAULT '',
            block_id        BIGINT,
            category        TEXT         NOT NULL DEFAULT 'Other',
            title           TEXT         NOT NULL,
            description     TEXT         NOT NULL DEFAULT '',
            status          TEXT         NOT NULL DEFAULT 'open',
            priority        TEXT         NOT NULL DEFAULT 'Normal',
            created_by      BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            assigned_to     BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            handover_id     BIGINT
                REFERENCES public.shift_mgmt_handovers(handover_id) ON DELETE SET NULL,
            work_date       DATE,
            shift_out       TEXT,
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            closed_at       TIMESTAMPTZ
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shift_mgmt_tickets_machine
            ON public.shift_mgmt_tickets (machine_id, status, created_at DESC)
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_ticket_comments (
            comment_id      BIGSERIAL    PRIMARY KEY,
            ticket_id       BIGINT       NOT NULL
                REFERENCES public.shift_mgmt_tickets(ticket_id) ON DELETE CASCADE,
            user_id         BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            body            TEXT         NOT NULL,
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )


def _ensure_tables_piecemeal(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_user_machines (
            user_id         BIGINT       NOT NULL
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE CASCADE,
            machine_id      BIGINT       NOT NULL
                REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, machine_id)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_handovers (
            handover_id           BIGSERIAL    PRIMARY KEY,
            work_date             DATE         NOT NULL,
            shift_out             TEXT         NOT NULL,
            shift_in              TEXT,
            machine_id            BIGINT       NOT NULL
                REFERENCES public.planner_machines(machine_id) ON DELETE RESTRICT,
            job_no                TEXT         NOT NULL DEFAULT '',
            machine_status        TEXT         NOT NULL DEFAULT 'Running',
            remaining_qty         INTEGER      NOT NULL DEFAULT 0,
            first_piece_status    TEXT         NOT NULL DEFAULT 'N/A',
            tool_life_pct         NUMERIC(6, 2) NOT NULL DEFAULT 100,
            material_qty          NUMERIC(12, 3),
            material_unit         TEXT         NOT NULL DEFAULT 'pcs',
            quality_issue_flag    BOOLEAN      NOT NULL DEFAULT FALSE,
            quality_issue_text    TEXT,
            alarm_flag            BOOLEAN      NOT NULL DEFAULT FALSE,
            alarm_text            TEXT,
            maintenance_flag      BOOLEAN      NOT NULL DEFAULT FALSE,
            maintenance_text      TEXT,
            priority              TEXT         NOT NULL DEFAULT 'Normal',
            priority_note         TEXT,
            ncr_status            TEXT         NOT NULL DEFAULT 'N/A',
            ncr_ref               TEXT,
            remarks               TEXT,
            status                TEXT         NOT NULL DEFAULT 'draft',
            outgoing_user_id      BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            outgoing_signed_at    TIMESTAMPTZ,
            incoming_user_id      BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            incoming_signed_at    TIMESTAMPTZ,
            incoming_disputed     BOOLEAN      NOT NULL DEFAULT FALSE,
            incoming_dispute_note TEXT,
            supervisor_user_id    BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            supervisor_signed_at  TIMESTAMPTZ,
            created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (work_date, shift_out, machine_id)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_handover_audit (
            audit_id        BIGSERIAL    PRIMARY KEY,
            handover_id     BIGINT       NOT NULL
                REFERENCES public.shift_mgmt_handovers(handover_id) ON DELETE CASCADE,
            user_id         BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            field_name      TEXT         NOT NULL,
            old_value       TEXT,
            new_value       TEXT,
            changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    _ensure_extra_tables(con)


def _audit(con, handover_id: int, user_id: int | None, field: str, old: Any, new: Any) -> None:
    if old == new:
        return
    con.execute(
        """
        INSERT INTO public.shift_mgmt_handover_audit
            (handover_id, user_id, field_name, old_value, new_value)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (
            handover_id,
            user_id,
            field,
            None if old is None else str(old),
            None if new is None else str(new),
        ),
    )


def _guess_shift(now: datetime | None = None) -> str:
    now = now or datetime.now()
    hour = now.hour
    if DAY_START_HOUR <= hour < NIGHT_START_HOUR:
        return "Day"
    return "Night"


def machine_ids_for_user(con, user: dict[str, Any]) -> list[int] | None:
    """Return assigned machine ids, or None when user may see the full fleet."""
    user_id = int(user["user_id"])
    assigned = rows(
        con.execute(
            """
            SELECT machine_id FROM public.shift_mgmt_user_machines WHERE user_id = %s
            """,
            (user_id,),
        )
    )
    if not assigned:
        return None
    return [int(r["machine_id"]) for r in assigned]


def list_active_machines(con, machine_ids: list[int] | None = None) -> list[dict]:
    if machine_ids is not None:
        return rows(
            con.execute(
                """
                SELECT machine_id, machine_no, machine_category, active
                FROM public.planner_machines
                WHERE active IS TRUE AND machine_id = ANY(%s)
                ORDER BY machine_no
                """,
                (machine_ids,),
            )
        )
    return rows(
        con.execute(
            """
            SELECT machine_id, machine_no, machine_category, active
            FROM public.planner_machines
            WHERE active IS TRUE
            ORDER BY machine_no
            """
        )
    )


OPS_QUEUE_DEPTH = 6


def queue_blocks_for_machines(
    con,
    machine_ids: list[int] | None = None,
    *,
    per_machine_limit: int | None = None,
) -> list[dict]:
    """Active machining-queue blocks with process sheet / remaining qty."""
    clauses = ["b.active IS TRUE"]
    params: list[Any] = []
    if machine_ids is not None:
        if not machine_ids:
            return []
        clauses.append("b.machine_id = ANY(%s)")
        params.append(machine_ids)
    limit_n = int(per_machine_limit) if per_machine_limit else 0
    inner_sql = f"""
            SELECT
                b.block_id,
                b.machine_id,
                b.queue_position,
                b.scheduled_qty,
                b.status AS block_status,
                b.execution_status AS block_execution_status,
                b.planning_status,
                m.machine_no,
                m.machine_category,
                o.operation_id,
                o.job_no,
                o.operation_name,
                o.total_qty,
                o.source_ps_id,
                o.source_op_no,
                qs.remaining_qty AS qs_remaining_qty,
                qs.good_qty AS qs_good_qty,
                qs.reject_qty AS qs_reject_qty,
                qs.schedule_status AS qs_schedule_status,
                qs.execution_status AS qs_execution_status
                {", ROW_NUMBER() OVER (PARTITION BY b.machine_id ORDER BY b.queue_position, b.block_id) AS rn, COUNT(*) OVER (PARTITION BY b.machine_id) AS queue_total" if limit_n else ""}
            FROM public.planner_run_block b
            JOIN public.planner_machines m ON m.machine_id = b.machine_id
            JOIN public.planner_operation o ON o.operation_id = b.operation_id
            LEFT JOIN public.planner_machine_queue_state qs ON qs.block_id = b.block_id
            WHERE {" AND ".join(clauses)}
    """
    if limit_n > 0:
        params.append(limit_n)
        sql = f"SELECT * FROM ({inner_sql}) q WHERE q.rn <= %s ORDER BY q.machine_no, q.queue_position, q.block_id"
    else:
        sql = inner_sql + " ORDER BY m.machine_no, b.queue_position, b.block_id"
    data = rows(con.execute(sql, tuple(params)))
    out = []
    for r in data:
        ps = display_ps_id(r.get("source_ps_id"), r.get("job_no"))
        rem = r.get("qs_remaining_qty")
        if rem is None:
            rem = r.get("scheduled_qty")
        out.append(
            {
                "block_id": int(r["block_id"]),
                "machine_id": int(r["machine_id"]),
                "machine_no": r.get("machine_no"),
                "machine_category": r.get("machine_category"),
                "queue_position": int(r.get("queue_position") or 0),
                "scheduled_qty": _jsonable(r.get("scheduled_qty")),
                "remaining_qty": _jsonable(rem),
                "good_qty": _jsonable(r.get("qs_good_qty")),
                "reject_qty": _jsonable(r.get("qs_reject_qty")),
                "block_status": compact_text(r.get("block_status")),
                "execution_status": compact_text(
                    r.get("qs_execution_status") or r.get("block_execution_status")
                ),
                "schedule_status": compact_text(r.get("qs_schedule_status")),
                "planning_status": compact_text(r.get("planning_status")),
                "operation_id": int(r["operation_id"]) if r.get("operation_id") else None,
                "operation_name": compact_text(r.get("operation_name")),
                "source_op_no": compact_text(r.get("source_op_no")),
                "job_no": compact_text(r.get("job_no")),
                "source_ps_id": compact_text(r.get("source_ps_id")),
                "process_sheet_no": ps,
                "total_qty": _jsonable(r.get("total_qty")),
                "queue_total": int(r["queue_total"]) if r.get("queue_total") is not None else None,
            }
        )
    return out


def open_ticket_counts(con, machine_ids: list[int] | None = None) -> dict[tuple[int, str], int]:
    clauses = ["status IN ('open', 'in_progress')"]
    params: list[Any] = []
    if machine_ids is not None:
        if not machine_ids:
            return {}
        clauses.append("machine_id = ANY(%s)")
        params.append(machine_ids)
    data = rows(
        con.execute(
            f"""
            SELECT machine_id, COALESCE(NULLIF(TRIM(planner_ps_id), ''), NULLIF(TRIM(job_no), ''), '') AS ps_key,
                   COUNT(*)::int AS n
            FROM public.shift_mgmt_tickets
            WHERE {" AND ".join(clauses)}
            GROUP BY machine_id, ps_key
            """,
            tuple(params),
        )
    )
    result: dict[tuple[int, str], int] = {}
    for r in data:
        key = (int(r["machine_id"]), display_ps_id(r.get("ps_key")))
        result[key] = int(r["n"] or 0)
    return result


def open_ticket_count_by_machine(con, machine_ids: list[int] | None = None) -> dict[int, int]:
    clauses = ["status IN ('open', 'in_progress')"]
    params: list[Any] = []
    if machine_ids is not None:
        if not machine_ids:
            return {}
        clauses.append("machine_id = ANY(%s)")
        params.append(machine_ids)
    data = rows(
        con.execute(
            f"""
            SELECT machine_id, COUNT(*)::int AS n
            FROM public.shift_mgmt_tickets
            WHERE {" AND ".join(clauses)}
            GROUP BY machine_id
            """,
            tuple(params),
        )
    )
    return {int(r["machine_id"]): int(r["n"] or 0) for r in data}


def queue_head_for_machine(con, machine_id: int) -> dict[str, Any] | None:
    blocks = queue_blocks_for_machines(con, [machine_id])
    return blocks[0] if blocks else None


def machine_ticket_totals(ticket_counts: dict[tuple[int, str], int]) -> dict[int, int]:
    totals: dict[int, int] = {}
    for (mid, _ps), n in ticket_counts.items():
        totals[int(mid)] = totals.get(int(mid), 0) + int(n or 0)
    return totals


def group_ops_machines(
    machines: list[dict],
    blocks: list[dict],
    handovers_by_machine: dict[int, dict | None],
    ticket_counts: dict[tuple[int, str], int],
    machine_ticket_counts: dict[int, int],
) -> list[dict]:
    """Group queue jobs under machines and attach handover / ticket counts."""
    jobs_by_machine: dict[int, list[dict]] = {}
    for raw in blocks:
        item = dict(raw)
        mid = int(item["machine_id"])
        ps = compact_text(item.get("process_sheet_no"))
        item["open_ticket_count"] = ticket_counts.get((mid, ps), 0)
        jobs_by_machine.setdefault(mid, []).append(item)

    grouped: list[dict] = []
    for m in machines:
        mid = int(m["machine_id"])
        jobs = jobs_by_machine.get(mid) or []
        head = jobs[0] if jobs else None
        queue_count = int((head or {}).get("queue_total") or len(jobs))
        grouped.append(
            {
                "machine_id": mid,
                "machine_no": m.get("machine_no"),
                "machine_category": m.get("machine_category"),
                "handover": handovers_by_machine.get(mid),
                "open_ticket_count": machine_ticket_counts.get(mid, 0),
                "queue_count": queue_count,
                "jobs": jobs,
                "active_process_sheet": (head or {}).get("process_sheet_no") or "",
                "active_job_no": (head or {}).get("job_no") or "",
                "queue_remaining_qty": (head or {}).get("remaining_qty"),
            }
        )
    grouped.sort(
        key=lambda row: (
            0 if row["open_ticket_count"] else 1,
            0 if row["jobs"] else 1,
            str(row.get("machine_no") or ""),
        )
    )
    return grouped


def _handovers_for_shift(
    con, work_date: date, shift_out: str, machine_ids: list[int]
) -> dict[int, dict]:
    if not machine_ids:
        return {}
    data = rows(
        con.execute(
            """
            SELECT handover_id, machine_id, status, priority, job_no, machine_status,
                   remaining_qty, quality_issue_flag, alarm_flag, maintenance_flag
            FROM public.shift_mgmt_handovers
            WHERE work_date = %s AND shift_out = %s AND machine_id = ANY(%s)
            """,
            (work_date, shift_out, machine_ids),
        )
    )
    return {int(r["machine_id"]): serialize_handover(r) for r in data}


def ops_queue_payload(
    con,
    user: dict[str, Any],
    *,
    work_date: date | None = None,
    shift_out: str | None = None,
) -> dict[str, Any]:
    work_date = work_date or date.today()
    shift_out = normalize_shift(shift_out)
    ids = machine_ids_for_user(con, user)
    machines = list_active_machines(con, ids)
    mids = [int(m["machine_id"]) for m in machines]
    blocks = queue_blocks_for_machines(con, mids, per_machine_limit=OPS_QUEUE_DEPTH)
    counts = open_ticket_counts(con, mids)
    machine_ticket_counts = machine_ticket_totals(counts)
    handovers = _handovers_for_shift(con, work_date, shift_out, mids)
    grouped = group_ops_machines(machines, blocks, handovers, counts, machine_ticket_counts)
    items = []
    for row in grouped:
        for job in row["jobs"]:
            items.append(job)
    return {
        "work_date": work_date.isoformat(),
        "shift_out": shift_out,
        "machines": grouped,
        "items": items,
        "meta": meta_constants(),
    }


def list_machines_for_user(con, user: dict[str, Any], work_date: date, shift_out: str) -> list[dict]:
    shift_out = normalize_shift(shift_out)
    ids = machine_ids_for_user(con, user)
    machines = list_active_machines(con, ids)
    mids = [int(m["machine_id"]) for m in machines]
    counts = open_ticket_counts(con, mids)
    blocks = queue_blocks_for_machines(con, mids, per_machine_limit=OPS_QUEUE_DEPTH)
    handovers = _handovers_for_shift(con, work_date, shift_out, mids)
    return group_ops_machines(machines, blocks, handovers, counts, machine_ticket_totals(counts))


def last_job_for_machine(con, machine_id: int) -> str:
    row = one(
        con.execute(
            """
            SELECT job_no
            FROM public.shift_mgmt_handovers
            WHERE machine_id = %s AND NULLIF(TRIM(job_no), '') IS NOT NULL
            ORDER BY work_date DESC, updated_at DESC
            LIMIT 1
            """,
            (machine_id,),
        )
    )
    return compact_text(row.get("job_no")) if row else ""


def process_sheet_match_keys(*values: Any) -> set[str]:
    """Case-insensitive identity keys for matching PS / job numbers."""
    keys: set[str] = set()
    for raw in values:
        text = compact_text(raw)
        if not text:
            continue
        keys.add(text.lower())
        keys.add(display_ps_id(text).lower())
    return {key for key in keys if key}


def match_queue_job(jobs: list[dict[str, Any]] | None, *values: Any) -> dict[str, Any] | None:
    needles = process_sheet_match_keys(*values)
    if not needles:
        return None
    for job in jobs or []:
        hay = process_sheet_match_keys(
            job.get("process_sheet_no"),
            job.get("job_no"),
            job.get("source_ps_id"),
            job.get("planner_ps_id"),
        )
        if needles & hay:
            return job
    return None


def _qty_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def process_sheet_autofill(
    item: dict[str, Any],
    queue_job: dict[str, Any] | None = None,
    last_handover: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fill remaining qty (queue → last handover → sheet qty) and last-shift fields."""
    remaining = _qty_int((queue_job or {}).get("remaining_qty"))
    if remaining is None:
        remaining = _qty_int((last_handover or {}).get("remaining_qty"))
    if remaining is None:
        remaining = _qty_int(item.get("display_qty") or item.get("remaining_qty"))
    out = dict(item)
    out["remaining_qty"] = remaining
    out["on_queue"] = bool(queue_job)
    if queue_job:
        out["block_id"] = queue_job.get("block_id")
        out["operation_name"] = compact_text(queue_job.get("operation_name"))
    if last_handover:
        out["tool_life_pct"] = _jsonable(last_handover.get("tool_life_pct"))
        out["material_qty"] = _jsonable(last_handover.get("material_qty"))
        out["material_unit"] = compact_text(last_handover.get("material_unit"))
        out["first_piece_status"] = compact_text(last_handover.get("first_piece_status"))
    return out


def _recent_handovers_for_machine(con, machine_id: int) -> list[dict[str, Any]]:
    data = rows(
        con.execute(
            """
            SELECT job_no, remaining_qty, tool_life_pct, material_qty, material_unit,
                   first_piece_status
            FROM public.shift_mgmt_handovers
            WHERE machine_id = %s AND NULLIF(TRIM(job_no), '') IS NOT NULL
            ORDER BY work_date DESC, updated_at DESC
            LIMIT 50
            """,
            (machine_id,),
        )
    )
    return [serialize_row(r) or {} for r in data]


def search_shift_process_sheets(
    con,
    query: str,
    *,
    machine_id: int | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Search ERP process sheets and attach queue / last-handover auto-fill values."""
    needle = compact_text(query)
    if not needle:
        return []
    from .process_sheets import (
        format_planner_ps_id,
        normalize_standard_ps_id,
        search_process_sheet_sources,
    )

    limit_n = max(1, min(int(limit or 20), 30))
    raw_items = search_process_sheet_sources(con, needle, limit=limit_n)
    queue_jobs: list[dict[str, Any]] = []
    last_rows: list[dict[str, Any]] = []
    mid: int | None = None
    if machine_id not in (None, ""):
        try:
            mid = int(machine_id)
        except (TypeError, ValueError):
            mid = None
        if mid:
            queue_jobs = queue_blocks_for_machines(con, [mid])
            last_rows = _recent_handovers_for_machine(con, mid)

    out: list[dict[str, Any]] = []
    for item in raw_items:
        source_ps_id = normalize_standard_ps_id(item.get("ps_id"))
        try:
            partial_no = max(1, int(item.get("pp_partial_no") or 1))
        except (TypeError, ValueError):
            partial_no = 1
        planner_ps_id = format_planner_ps_id(source_ps_id, partial_no)
        display = f"{source_ps_id} · Partial {partial_no}" if partial_no > 1 else source_ps_id
        queue_job = match_queue_job(queue_jobs, planner_ps_id, source_ps_id)
        last_ho = match_queue_job(last_rows, planner_ps_id, source_ps_id)
        filled = process_sheet_autofill(
            {
                "ps_id": source_ps_id,
                "pp_partial_no": partial_no,
                "planner_ps_id": planner_ps_id,
                "display_ps_id": display,
                "process_sheet_no": display_ps_id(planner_ps_id) or source_ps_id,
                "job_no": planner_ps_id or source_ps_id,
                "part_no": compact_text(item.get("part_no")),
                "description": compact_text(item.get("description")),
                "due_date": _jsonable(item.get("due_date")),
                "display_qty": _jsonable(item.get("display_qty")),
                "match_source": compact_text(item.get("match_source")),
            },
            queue_job,
            last_ho,
        )
        out.append(filled)
    return out


def get_or_create_draft(
    con,
    *,
    work_date: date,
    shift_out: str,
    machine_id: int,
    user: dict[str, Any],
    job_no_pref: str | None = None,
) -> dict[str, Any]:
    shift_out = normalize_shift(shift_out)
    existing = one(
        con.execute(
            """
            SELECT h.*, m.machine_no
            FROM public.shift_mgmt_handovers h
            JOIN public.planner_machines m ON m.machine_id = h.machine_id
            WHERE h.work_date = %s AND h.shift_out = %s AND h.machine_id = %s
            """,
            (work_date, shift_out, machine_id),
        )
    )
    if existing:
        out = serialize_handover(existing)
        assert out is not None
        out["queue_jobs"] = queue_blocks_for_machines(con, [machine_id])
        out["comments"] = list_handover_comments(con, int(out["handover_id"]))
        out["tickets"] = list_tickets(
            con, machine_id=machine_id, status="open,in_progress", limit=50
        )
        return out

    head = queue_head_for_machine(con, machine_id)
    job_no = compact_text(job_no_pref)
    remaining = 0
    if head:
        job_no = job_no or compact_text(head.get("process_sheet_no") or head.get("job_no"))
        try:
            remaining = int(float(head.get("remaining_qty") or 0))
        except (TypeError, ValueError):
            remaining = 0
    if not job_no:
        job_no = last_job_for_machine(con, machine_id)

    user_id = int(user["user_id"])
    row = one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_handovers
                (work_date, shift_out, shift_in, machine_id, job_no, remaining_qty,
                 outgoing_user_id, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'draft')
            RETURNING *
            """,
            (
                work_date,
                shift_out,
                opposite_shift(shift_out),
                machine_id,
                job_no,
                remaining,
                user_id,
            ),
        )
    )
    machine = one(
        con.execute(
            "SELECT machine_no FROM public.planner_machines WHERE machine_id = %s",
            (machine_id,),
        )
    )
    if row is None:
        raise RuntimeError("Failed to create handover draft")
    row["machine_no"] = machine.get("machine_no") if machine else None
    _audit(con, int(row["handover_id"]), user_id, "_lifecycle", None, "draft_created")
    out = serialize_handover(row)
    assert out is not None
    out["queue_jobs"] = queue_blocks_for_machines(con, [machine_id])
    out["comments"] = []
    out["tickets"] = list_tickets(
        con, machine_id=machine_id, status="open,in_progress", limit=50
    )
    return out


def get_handover(con, handover_id: int, *, enrich: bool = False) -> dict[str, Any] | None:
    row = one(
        con.execute(
            """
            SELECT h.*, m.machine_no,
                   ou.display_name AS outgoing_display_name,
                   iu.display_name AS incoming_display_name
            FROM public.shift_mgmt_handovers h
            JOIN public.planner_machines m ON m.machine_id = h.machine_id
            LEFT JOIN public.shift_mgmt_users ou ON ou.user_id = h.outgoing_user_id
            LEFT JOIN public.shift_mgmt_users iu ON iu.user_id = h.incoming_user_id
            WHERE h.handover_id = %s
            """,
            (handover_id,),
        )
    )
    out = serialize_handover(row)
    if out and enrich:
        mid = int(out["machine_id"])
        out["queue_jobs"] = queue_blocks_for_machines(con, [mid])
        out["comments"] = list_handover_comments(con, handover_id)
        out["tickets"] = list_tickets(
            con, machine_id=mid, status="open,in_progress", limit=50
        )
    return out


def list_handover_comments(con, handover_id: int) -> list[dict]:
    data = rows(
        con.execute(
            """
            SELECT c.comment_id, c.handover_id, c.user_id, c.body, c.created_at,
                   u.display_name, u.username
            FROM public.shift_mgmt_handover_comments c
            LEFT JOIN public.shift_mgmt_users u ON u.user_id = c.user_id
            WHERE c.handover_id = %s
            ORDER BY c.created_at ASC, c.comment_id ASC
            """,
            (handover_id,),
        )
    )
    return [serialize_row(r) for r in data]  # type: ignore[misc]


def add_handover_comment(
    con, handover_id: int, user: dict[str, Any], body: str
) -> dict[str, Any]:
    ho = get_handover(con, handover_id)
    if not ho:
        raise LookupError("Handover not found")
    text = compact_text(body)
    if not text:
        raise ValueError("Comment is required")
    user_id = int(user["user_id"])
    row = one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_handover_comments
                (handover_id, user_id, body)
            VALUES (%s, %s, %s)
            RETURNING comment_id, handover_id, user_id, body, created_at
            """,
            (handover_id, user_id, text),
        )
    )
    assert row is not None
    row["display_name"] = compact_text(user.get("display_name")) or compact_text(
        user.get("username")
    )
    row["username"] = compact_text(user.get("username"))
    return serialize_row(row)  # type: ignore[return-value]


def _can_edit(ho: dict[str, Any], user: dict[str, Any]) -> bool:
    status = compact_text(ho.get("status")).lower()
    role = compact_text(user.get("role")).lower()
    if status == "acknowledged" and role not in ("supervisor", "admin"):
        return False
    if status in ("pending_ack", "disputed"):
        return role in ("supervisor", "admin")
    return status == "draft"


def _coerce_field(field: str, value: Any) -> Any:
    if field in ("quality_issue_flag", "alarm_flag", "maintenance_flag"):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if field == "remaining_qty":
        return int(value or 0)
    if field in ("tool_life_pct", "material_qty"):
        if value is None or value == "":
            return None if field == "material_qty" else 100
        return float(value)
    if field == "machine_status":
        text = compact_text(value)
        if text not in MACHINE_STATUSES:
            raise ValueError(f"Invalid machine_status: {value}")
        return text
    if field == "first_piece_status":
        text = compact_text(value)
        if text not in FIRST_PIECE_STATUSES:
            raise ValueError(f"Invalid first_piece_status: {value}")
        return text
    if field == "priority":
        text = compact_text(value)
        if text not in PRIORITIES:
            raise ValueError(f"Invalid priority: {value}")
        return text
    if field == "ncr_status":
        text = compact_text(value)
        if text not in NCR_STATUSES:
            raise ValueError(f"Invalid ncr_status: {value}")
        return text
    if field == "material_unit":
        text = compact_text(value) or "pcs"
        if text not in MATERIAL_UNITS:
            raise ValueError(f"Invalid material_unit: {value}")
        return text
    if field == "shift_in":
        if value in (None, ""):
            return None
        return normalize_shift(value)
    if field in (
        "job_no",
        "quality_issue_text",
        "alarm_text",
        "maintenance_text",
        "priority_note",
        "ncr_ref",
        "remarks",
    ):
        return None if value is None else str(value)
    return value


def patch_handover(
    con,
    handover_id: int,
    patch: dict[str, Any],
    user: dict[str, Any],
) -> dict[str, Any]:
    ho = get_handover(con, handover_id)
    if not ho:
        raise LookupError("Handover not found")
    if not _can_edit(ho, user):
        raise PermissionError("Handover is locked after acknowledgement / submit")

    user_id = int(user["user_id"])
    updates: list[str] = []
    params: list[Any] = []
    for field, raw in patch.items():
        if field not in EDITABLE_FIELDS:
            continue
        new_val = _coerce_field(field, raw)
        old_val = ho.get(field)
        if isinstance(new_val, bool):
            old_cmp = bool(old_val)
        else:
            old_cmp = old_val
        if str(old_cmp) == str(new_val) or (old_cmp is None and new_val in (None, "")):
            continue
        updates.append(f"{field} = %s")
        params.append(new_val)
        _audit(con, handover_id, user_id, field, old_val, new_val)

    if updates:
        updates.append("updated_at = NOW()")
        params.append(handover_id)
        con.execute(
            f"""
            UPDATE public.shift_mgmt_handovers
            SET {", ".join(updates)}
            WHERE handover_id = %s
            """,
            tuple(params),
        )
    refreshed = get_handover(con, handover_id, enrich=True)
    if not refreshed:
        raise RuntimeError("Handover disappeared after patch")
    return refreshed


def _validate_for_submit(ho: dict[str, Any]) -> str | None:
    if ho.get("quality_issue_flag") and not compact_text(ho.get("quality_issue_text")):
        return "Quality issue text is required when Quality is flagged."
    if ho.get("alarm_flag") and not compact_text(ho.get("alarm_text")):
        return "Alarm text is required when Alarms are flagged."
    if ho.get("maintenance_flag") and not compact_text(ho.get("maintenance_text")):
        return "Maintenance text is required when Maintenance is flagged."
    if compact_text(ho.get("ncr_status")) == "Open" and not compact_text(ho.get("ncr_ref")):
        return "NCR reference is required when NCR status is Open."
    if compact_text(ho.get("priority")) in ("High", "Urgent") and not compact_text(
        ho.get("priority_note")
    ):
        return "Priority note is required for High/Urgent."
    return None


def submit_handover(con, handover_id: int, user: dict[str, Any]) -> dict[str, Any]:
    ho = get_handover(con, handover_id)
    if not ho:
        raise LookupError("Handover not found")
    if compact_text(ho.get("status")) != "draft":
        raise PermissionError("Only draft handovers can be submitted")
    err = _validate_for_submit(ho)
    if err:
        raise ValueError(err)
    user_id = int(user["user_id"])
    shift_in = compact_text(ho.get("shift_in")) or opposite_shift(
        compact_text(ho.get("shift_out")) or "Day"
    )
    con.execute(
        """
        UPDATE public.shift_mgmt_handovers
        SET status = 'pending_ack',
            shift_in = %s,
            outgoing_user_id = %s,
            outgoing_signed_at = NOW(),
            updated_at = NOW()
        WHERE handover_id = %s
        """,
        (normalize_shift(shift_in), user_id, handover_id),
    )
    _audit(con, handover_id, user_id, "status", "draft", "pending_ack")
    refreshed = get_handover(con, handover_id, enrich=True)
    if not refreshed:
        raise RuntimeError("Handover disappeared after submit")
    return refreshed


def acknowledge_handover(
    con, handover_id: int, user: dict[str, Any], shift_in: str | None = None
) -> dict[str, Any]:
    ho = get_handover(con, handover_id)
    if not ho:
        raise LookupError("Handover not found")
    if compact_text(ho.get("status")) not in ("pending_ack", "disputed"):
        raise PermissionError("Handover is not awaiting acknowledgement")
    user_id = int(user["user_id"])
    so = normalize_shift(ho.get("shift_out"), "Day")
    si = normalize_shift(shift_in or ho.get("shift_in") or opposite_shift(so))
    old_status = compact_text(ho.get("status"))
    con.execute(
        """
        UPDATE public.shift_mgmt_handovers
        SET status = 'acknowledged',
            shift_in = %s,
            incoming_user_id = %s,
            incoming_signed_at = NOW(),
            incoming_disputed = FALSE,
            incoming_dispute_note = NULL,
            updated_at = NOW()
        WHERE handover_id = %s
        """,
        (si, user_id, handover_id),
    )
    _audit(con, handover_id, user_id, "status", old_status, "acknowledged")
    refreshed = get_handover(con, handover_id, enrich=True)
    if not refreshed:
        raise RuntimeError("Handover disappeared after acknowledge")
    return refreshed


def dispute_handover(
    con, handover_id: int, user: dict[str, Any], note: str
) -> dict[str, Any]:
    ho = get_handover(con, handover_id)
    if not ho:
        raise LookupError("Handover not found")
    if compact_text(ho.get("status")) != "pending_ack":
        raise PermissionError("Only pending handovers can be disputed")
    note_text = compact_text(note)
    if not note_text:
        raise ValueError("Dispute note is required")
    user_id = int(user["user_id"])
    con.execute(
        """
        UPDATE public.shift_mgmt_handovers
        SET status = 'disputed',
            incoming_user_id = %s,
            incoming_signed_at = NOW(),
            incoming_disputed = TRUE,
            incoming_dispute_note = %s,
            updated_at = NOW()
        WHERE handover_id = %s
        """,
        (user_id, note_text, handover_id),
    )
    _audit(con, handover_id, user_id, "status", "pending_ack", "disputed")
    refreshed = get_handover(con, handover_id, enrich=True)
    if not refreshed:
        raise RuntimeError("Handover disappeared after dispute")
    return refreshed


def pending_ack_count(con, work_date: date | None = None) -> int:
    if work_date:
        row = one(
            con.execute(
                """
                SELECT COUNT(*)::int AS n
                FROM public.shift_mgmt_handovers
                WHERE status = 'pending_ack' AND work_date = %s
                """,
                (work_date,),
            )
        )
    else:
        row = one(
            con.execute(
                """
                SELECT COUNT(*)::int AS n
                FROM public.shift_mgmt_handovers
                WHERE status = 'pending_ack'
                """
            )
        )
    return int(row["n"]) if row else 0


def list_pending_ack(con, work_date: date | None = None) -> list[dict]:
    if work_date:
        data = rows(
            con.execute(
                """
                SELECT h.handover_id, h.work_date, h.shift_out, h.machine_status, h.priority,
                       h.status, m.machine_no, ou.display_name AS outgoing_display_name
                FROM public.shift_mgmt_handovers h
                JOIN public.planner_machines m ON m.machine_id = h.machine_id
                LEFT JOIN public.shift_mgmt_users ou ON ou.user_id = h.outgoing_user_id
                WHERE h.status = 'pending_ack' AND h.work_date = %s
                ORDER BY h.priority DESC, m.machine_no
                """,
                (work_date,),
            )
        )
    else:
        data = rows(
            con.execute(
                """
                SELECT h.handover_id, h.work_date, h.shift_out, h.machine_status, h.priority,
                       h.status, m.machine_no, ou.display_name AS outgoing_display_name
                FROM public.shift_mgmt_handovers h
                JOIN public.planner_machines m ON m.machine_id = h.machine_id
                LEFT JOIN public.shift_mgmt_users ou ON ou.user_id = h.outgoing_user_id
                WHERE h.status = 'pending_ack'
                ORDER BY h.work_date DESC, h.priority DESC, m.machine_no
                """
            )
        )
    return [serialize_handover(r) for r in data]  # type: ignore[misc]


def list_tickets(
    con,
    *,
    machine_id: int | None = None,
    status: str | None = None,
    planner_ps_id: str | None = None,
    work_date: date | None = None,
    shift_out: str | None = None,
    limit: int = 200,
) -> list[dict]:
    clauses = ["1=1"]
    params: list[Any] = []
    if machine_id:
        clauses.append("t.machine_id = %s")
        params.append(machine_id)
    if planner_ps_id:
        clauses.append("(t.planner_ps_id = %s OR t.job_no = %s)")
        params.extend([planner_ps_id, planner_ps_id])
    if work_date:
        clauses.append("t.work_date = %s")
        params.append(work_date)
    if shift_out:
        clauses.append("t.shift_out = %s")
        params.append(normalize_shift(shift_out))
    if status:
        statuses = [compact_text(s) for s in str(status).split(",") if compact_text(s)]
        if statuses:
            clauses.append("t.status = ANY(%s)")
            params.append(statuses)
    params.append(max(1, min(int(limit), 500)))
    data = rows(
        con.execute(
            f"""
            SELECT t.*, m.machine_no,
                   cb.display_name AS created_by_name,
                   asg.display_name AS assigned_to_name
            FROM public.shift_mgmt_tickets t
            JOIN public.planner_machines m ON m.machine_id = t.machine_id
            LEFT JOIN public.shift_mgmt_users cb ON cb.user_id = t.created_by
            LEFT JOIN public.shift_mgmt_users asg ON asg.user_id = t.assigned_to
            WHERE {" AND ".join(clauses)}
            ORDER BY
                CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                CASE t.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 ELSE 2 END,
                t.created_at DESC
            LIMIT %s
            """,
            tuple(params),
        )
    )
    out = []
    for r in data:
        item = serialize_row(r)
        assert item is not None
        item["process_sheet_no"] = display_ps_id(item.get("planner_ps_id"), item.get("job_no"))
        out.append(item)
    return out


def get_ticket(con, ticket_id: int, *, with_comments: bool = True) -> dict[str, Any] | None:
    row = one(
        con.execute(
            """
            SELECT t.*, m.machine_no,
                   cb.display_name AS created_by_name,
                   asg.display_name AS assigned_to_name
            FROM public.shift_mgmt_tickets t
            JOIN public.planner_machines m ON m.machine_id = t.machine_id
            LEFT JOIN public.shift_mgmt_users cb ON cb.user_id = t.created_by
            LEFT JOIN public.shift_mgmt_users asg ON asg.user_id = t.assigned_to
            WHERE t.ticket_id = %s
            """,
            (ticket_id,),
        )
    )
    out = serialize_row(row)
    if out:
        out["process_sheet_no"] = display_ps_id(out.get("planner_ps_id"), out.get("job_no"))
        if with_comments:
            out["comments"] = list_ticket_comments(con, ticket_id)
    return out


def create_ticket(con, user: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    try:
        machine_id = int(data.get("machine_id"))
    except (TypeError, ValueError) as exc:
        raise ValueError("machine_id required") from exc
    category = compact_text(data.get("category")) or "Other"
    if category not in TICKET_CATEGORIES:
        raise ValueError("Invalid category")
    planner_ps_id = compact_text(data.get("planner_ps_id") or data.get("process_sheet_no")) or ""
    title = compact_text(data.get("title"))
    if not title:
        title = f"{category} · PS {planner_ps_id}" if planner_ps_id else category
    priority = compact_text(data.get("priority")) or "Normal"
    if priority not in PRIORITIES:
        raise ValueError("Invalid priority")
    job_no = compact_text(data.get("job_no")) or planner_ps_id
    block_id = data.get("block_id")
    try:
        block_id_int = int(block_id) if block_id not in (None, "") else None
    except (TypeError, ValueError):
        block_id_int = None
    handover_id = data.get("handover_id")
    try:
        handover_id_int = int(handover_id) if handover_id not in (None, "") else None
    except (TypeError, ValueError):
        handover_id_int = None
    work_date = data.get("work_date")
    if isinstance(work_date, str) and work_date:
        work_date = date.fromisoformat(work_date[:10])
    elif not isinstance(work_date, date):
        work_date = date.today()
    shift_out = normalize_shift(data.get("shift_out") or data.get("shift") or _guess_shift())
    assigned_to = data.get("assigned_to")
    try:
        assigned_to_int = int(assigned_to) if assigned_to not in (None, "") else None
    except (TypeError, ValueError):
        assigned_to_int = None

    role = compact_text(user.get("role")).lower()
    if assigned_to_int and role not in ("supervisor", "admin", "quality"):
        assigned_to_int = None

    user_id = int(user["user_id"])
    row = one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_tickets
                (machine_id, planner_ps_id, job_no, block_id, category, title, description,
                 status, priority, created_by, assigned_to, handover_id, work_date, shift_out)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'open', %s, %s, %s, %s, %s, %s)
            RETURNING ticket_id
            """,
            (
                machine_id,
                planner_ps_id,
                job_no,
                block_id_int,
                category,
                title,
                compact_text(data.get("description")) or "",
                priority,
                user_id,
                assigned_to_int,
                handover_id_int,
                work_date,
                shift_out,
            ),
        )
    )
    assert row is not None
    ticket = get_ticket(con, int(row["ticket_id"]))
    assert ticket is not None
    return ticket


def patch_ticket(
    con, ticket_id: int, user: dict[str, Any], patch: dict[str, Any]
) -> dict[str, Any]:
    ticket = get_ticket(con, ticket_id, with_comments=False)
    if not ticket:
        raise LookupError("Ticket not found")
    role = compact_text(user.get("role")).lower()
    user_id = int(user["user_id"])
    updates: list[str] = []
    params: list[Any] = []

    if "status" in patch:
        status = compact_text(patch.get("status")).lower()
        if status not in TICKET_STATUSES:
            raise ValueError("Invalid status")
        created_by = ticket.get("created_by")
        can_close = role in ("supervisor", "admin", "quality") or (
            created_by is not None and int(created_by) == user_id
        )
        if status == "closed" and not can_close:
            raise PermissionError("Not allowed to close this ticket")
        updates.append("status = %s")
        params.append(status)
        if status == "closed":
            updates.append("closed_at = NOW()")
        else:
            updates.append("closed_at = NULL")

    if "priority" in patch:
        priority = compact_text(patch.get("priority")) or "Normal"
        if priority not in PRIORITIES:
            raise ValueError("Invalid priority")
        updates.append("priority = %s")
        params.append(priority)

    if "assigned_to" in patch:
        if role not in ("supervisor", "admin", "quality"):
            raise PermissionError("Only supervisors can assign tickets")
        assigned = patch.get("assigned_to")
        if assigned in (None, ""):
            updates.append("assigned_to = NULL")
        else:
            updates.append("assigned_to = %s")
            params.append(int(assigned))

    if "title" in patch:
        title = compact_text(patch.get("title"))
        if not title:
            raise ValueError("title required")
        updates.append("title = %s")
        params.append(title)

    if "description" in patch:
        updates.append("description = %s")
        params.append(compact_text(patch.get("description")) or "")

    if "category" in patch:
        category = compact_text(patch.get("category")) or "Other"
        if category not in TICKET_CATEGORIES:
            raise ValueError("Invalid category")
        updates.append("category = %s")
        params.append(category)

    if not updates:
        refreshed = get_ticket(con, ticket_id)
        assert refreshed is not None
        return refreshed

    updates.append("updated_at = NOW()")
    params.append(ticket_id)
    con.execute(
        f"""
        UPDATE public.shift_mgmt_tickets
        SET {", ".join(updates)}
        WHERE ticket_id = %s
        """,
        tuple(params),
    )
    refreshed = get_ticket(con, ticket_id)
    if not refreshed:
        raise RuntimeError("Ticket disappeared after patch")
    return refreshed


def list_ticket_comments(con, ticket_id: int) -> list[dict]:
    data = rows(
        con.execute(
            """
            SELECT c.comment_id, c.ticket_id, c.user_id, c.body, c.created_at,
                   u.display_name, u.username
            FROM public.shift_mgmt_ticket_comments c
            LEFT JOIN public.shift_mgmt_users u ON u.user_id = c.user_id
            WHERE c.ticket_id = %s
            ORDER BY c.created_at ASC, c.comment_id ASC
            """,
            (ticket_id,),
        )
    )
    return [serialize_row(r) for r in data]  # type: ignore[misc]


def add_ticket_comment(
    con, ticket_id: int, user: dict[str, Any], body: str
) -> dict[str, Any]:
    ticket = get_ticket(con, ticket_id, with_comments=False)
    if not ticket:
        raise LookupError("Ticket not found")
    text = compact_text(body)
    if not text:
        raise ValueError("Comment is required")
    user_id = int(user["user_id"])
    row = one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_ticket_comments
                (ticket_id, user_id, body)
            VALUES (%s, %s, %s)
            RETURNING comment_id, ticket_id, user_id, body, created_at
            """,
            (ticket_id, user_id, text),
        )
    )
    assert row is not None
    con.execute(
        "UPDATE public.shift_mgmt_tickets SET updated_at = NOW() WHERE ticket_id = %s",
        (ticket_id,),
    )
    row["display_name"] = compact_text(user.get("display_name")) or compact_text(
        user.get("username")
    )
    row["username"] = compact_text(user.get("username"))
    return serialize_row(row)  # type: ignore[return-value]


def handover_issue_labels(ho: dict[str, Any] | None) -> list[str]:
    """Reasons a handover belongs on the Board attention list (not History)."""
    if not ho:
        return []
    labels: list[str] = []
    if compact_text(ho.get("machine_status")) == "Breakdown":
        labels.append("Breakdown")
    if compact_text(ho.get("first_piece_status")) == "Not OK":
        labels.append("1st piece NOK")
    if compact_text(ho.get("ncr_status")) == "Open":
        labels.append("Open NCR")
    if ho.get("quality_issue_flag"):
        labels.append("Quality")
    if ho.get("alarm_flag"):
        labels.append("Alarm")
    if ho.get("maintenance_flag"):
        labels.append("Maintenance")
    priority = compact_text(ho.get("priority"))
    if priority in ("High", "Urgent"):
        labels.append(priority)
    return labels


def classify_board_attention(
    handovers: list[dict[str, Any]],
    tickets: list[dict[str, Any]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Board shows only items that need action this shift.

    Drafts with no issues stay on Machines/Ops. Clean acknowledged rows stay in History.
    """
    pending: list[dict[str, Any]] = []
    disputed: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for ho in handovers:
        item = dict(ho)
        item["issue_labels"] = handover_issue_labels(item)
        status = compact_text(item.get("status"))
        if status == "pending_ack":
            pending.append(item)
        elif status == "disputed":
            disputed.append(item)
        elif item["issue_labels"]:
            issues.append(item)
    open_tickets = [
        t
        for t in (tickets or [])
        if compact_text(t.get("status")) in ("open", "in_progress")
    ]
    return {
        "pending_ack": pending,
        "disputed": disputed,
        "issues": issues,
        "tickets": open_tickets,
    }


def dashboard_payload(con, work_date: date, shift_out: str | None = None) -> dict[str, Any]:
    clauses = ["work_date = %s"]
    params: list[Any] = [work_date]
    if shift_out:
        clauses.append("shift_out = %s")
        params.append(normalize_shift(shift_out))
    where = " AND ".join(clauses)
    kpis = one(
        con.execute(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE machine_status = 'Breakdown')::int AS breakdowns,
                COUNT(*) FILTER (WHERE ncr_status = 'Open')::int AS open_ncrs,
                COUNT(*) FILTER (WHERE priority = 'Urgent')::int AS urgent_jobs,
                COUNT(*) FILTER (WHERE maintenance_flag IS TRUE)::int AS pending_maintenance,
                COUNT(*) FILTER (WHERE first_piece_status = 'Not OK')::int AS first_piece_not_ok,
                COUNT(*) FILTER (WHERE status = 'pending_ack')::int AS pending_ack
            FROM public.shift_mgmt_handovers
            WHERE {where}
            """,
            tuple(params),
        )
    ) or {}

    tickets = list_tickets(
        con,
        work_date=work_date,
        shift_out=normalize_shift(shift_out) if shift_out else None,
        status="open,in_progress",
        limit=200,
    )
    kpis = {**kpis, "open_tickets": len(tickets)}

    ho_clauses = ["h.work_date = %s"]
    ho_params: list[Any] = [work_date]
    if shift_out:
        ho_clauses.append("h.shift_out = %s")
        ho_params.append(normalize_shift(shift_out))
    machines = rows(
        con.execute(
            f"""
            SELECT h.handover_id, h.shift_out, h.machine_status, h.priority, h.status,
                   h.job_no, h.quality_issue_flag, h.alarm_flag, h.maintenance_flag,
                   h.ncr_status, h.first_piece_status, m.machine_id, m.machine_no
            FROM public.shift_mgmt_handovers h
            JOIN public.planner_machines m ON m.machine_id = h.machine_id
            WHERE {" AND ".join(ho_clauses)}
            ORDER BY m.machine_no, h.shift_out
            """,
            tuple(ho_params),
        )
    )
    handovers = [serialize_handover(r) for r in machines if serialize_handover(r)]
    attention = classify_board_attention(handovers, tickets)
    return {
        "work_date": work_date.isoformat(),
        "shift_out": normalize_shift(shift_out) if shift_out else None,
        "kpis": {k: int(v or 0) for k, v in kpis.items()},
        "attention": attention,
    }


def history_payload(
    con,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    machine_id: int | None = None,
    shift_out: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    ncr_status: str | None = None,
    limit: int = 200,
) -> list[dict]:
    clauses = ["1=1"]
    params: list[Any] = []
    if date_from:
        clauses.append("h.work_date >= %s")
        params.append(date_from)
    if date_to:
        clauses.append("h.work_date <= %s")
        params.append(date_to)
    if machine_id:
        clauses.append("h.machine_id = %s")
        params.append(machine_id)
    if shift_out:
        clauses.append("h.shift_out = %s")
        params.append(normalize_shift(shift_out))
    if status:
        clauses.append("h.status = %s")
        params.append(status)
    if priority:
        clauses.append("h.priority = %s")
        params.append(priority)
    if ncr_status:
        clauses.append("h.ncr_status = %s")
        params.append(ncr_status)
    params.append(max(1, min(int(limit), 500)))
    data = rows(
        con.execute(
            f"""
            SELECT h.handover_id, h.work_date, h.shift_out, h.shift_in, h.machine_status,
                   h.priority, h.status, h.job_no, h.ncr_status, h.ncr_ref,
                   h.quality_issue_flag, h.alarm_flag, h.maintenance_flag,
                   m.machine_no,
                   ou.display_name AS outgoing_display_name,
                   iu.display_name AS incoming_display_name
            FROM public.shift_mgmt_handovers h
            JOIN public.planner_machines m ON m.machine_id = h.machine_id
            LEFT JOIN public.shift_mgmt_users ou ON ou.user_id = h.outgoing_user_id
            LEFT JOIN public.shift_mgmt_users iu ON iu.user_id = h.incoming_user_id
            WHERE {" AND ".join(clauses)}
            ORDER BY h.work_date DESC, m.machine_no, h.shift_out
            LIMIT %s
            """,
            tuple(params),
        )
    )
    return [serialize_handover(r) for r in data]  # type: ignore[misc]


def report_payload(con, work_date: date, shift_out: str) -> dict[str, Any]:
    shift_out = normalize_shift(shift_out)
    handovers = rows(
        con.execute(
            """
            SELECT h.*, m.machine_no,
                   ou.display_name AS outgoing_display_name,
                   iu.display_name AS incoming_display_name
            FROM public.shift_mgmt_handovers h
            JOIN public.planner_machines m ON m.machine_id = h.machine_id
            LEFT JOIN public.shift_mgmt_users ou ON ou.user_id = h.outgoing_user_id
            LEFT JOIN public.shift_mgmt_users iu ON iu.user_id = h.incoming_user_id
            WHERE h.work_date = %s AND h.shift_out = %s
            ORDER BY m.machine_no
            """,
            (work_date, shift_out),
        )
    )
    tickets = list_tickets(con, work_date=work_date, shift_out=shift_out, limit=500)
    enriched = []
    for h in handovers:
        item = serialize_handover(h)
        assert item is not None
        item["comments"] = list_handover_comments(con, int(item["handover_id"]))
        mid = int(item["machine_id"])
        item["machine_tickets"] = [
            t for t in tickets if int(t.get("machine_id") or 0) == mid
        ]
        enriched.append(item)
    return {
        "work_date": work_date.isoformat(),
        "shift_out": shift_out,
        "shift_in": opposite_shift(shift_out),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "handovers": enriched,
        "tickets": tickets,
        "summary": {
            "machines": len(enriched),
            "pending_ack": sum(
                1 for h in enriched if compact_text(h.get("status")) == "pending_ack"
            ),
            "open_tickets": sum(
                1
                for t in tickets
                if compact_text(t.get("status")) in ("open", "in_progress")
            ),
            "urgent_jobs": sum(
                1 for h in enriched if compact_text(h.get("priority")) == "Urgent"
            ),
            "open_ncrs": sum(
                1 for h in enriched if compact_text(h.get("ncr_status")) == "Open"
            ),
        },
    }


def meta_constants() -> dict[str, Any]:
    return {
        "machine_statuses": list(MACHINE_STATUSES),
        "first_piece_statuses": list(FIRST_PIECE_STATUSES),
        "priorities": list(PRIORITIES),
        "ncr_statuses": list(NCR_STATUSES),
        "material_units": list(MATERIAL_UNITS),
        "shifts": list(SHIFTS),
        "ticket_categories": list(TICKET_CATEGORIES),
        "ticket_statuses": list(TICKET_STATUSES),
        "guess_shift": _guess_shift(),
        "day_start_hour": DAY_START_HOUR,
        "night_start_hour": NIGHT_START_HOUR,
    }
