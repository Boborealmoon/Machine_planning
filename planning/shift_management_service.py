"""Shift Management - Day/Night handover CRUD, ops queue, tickets, KPIs."""
from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from .helpers import one, rows
from .utils import PLANNER_TZ, compact_text

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
TICKET_STATUSES = ("open", "in_progress", "on_hold", "resolved", "closed")
OPEN_TICKET_STATUSES = ("open", "in_progress", "on_hold")

# Day 08:01-20:00, Night 20:01-08:00 (shop wall clock, Asia/Singapore).
DAY_START = time(8, 1)
DAY_END = time(20, 1)  # exclusive; 20:00 is still Day
NIGHT_START = time(20, 1)
NIGHT_END = time(8, 1)  # exclusive next morning; 08:00 is still Night

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
_shift_checks_ready = False
_ticket_status_ready = False
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


def _ensure_ticket_status_values(con) -> None:
    """Widen the status check. Retry until a committed request sees the new values."""
    global _ticket_status_ready
    if _ticket_status_ready:
        return
    text = _check_def(con, "shift_mgmt_tickets", "shift_mgmt_tickets_status_check")
    if "on_hold" in text and "resolved" in text:
        _ticket_status_ready = True
        return
    con.execute(
        "ALTER TABLE public.shift_mgmt_tickets "
        "DROP CONSTRAINT IF EXISTS shift_mgmt_tickets_status_check"
    )
    _drop_checks_on_columns(con, "shift_mgmt_tickets", ("status",))
    con.execute(
        """
        ALTER TABLE public.shift_mgmt_tickets
        ADD CONSTRAINT shift_mgmt_tickets_status_check
        CHECK (status IN ('open', 'in_progress', 'on_hold', 'resolved', 'closed'))
        """
    )


def ensure_shift_mgmt_schema(con) -> None:
    global _schema_ready, _shift_checks_ready
    if _schema_ready and _shift_checks_ready and _ticket_status_ready:
        return
    from .shift_management_auth import ensure_shift_mgmt_auth_tables, seed_demo_users_if_empty

    if not _schema_ready:
        ensure_shift_mgmt_auth_tables(con)
        try:
            _apply_migration_sql(con)
        except Exception:
            log.warning("shift_mgmt migration apply failed; ensuring tables piecemeal", exc_info=True)
            _try_migration_step(
                con, "sm_piecemeal", lambda: _ensure_tables_piecemeal(con), warn=True
            )
        _try_migration_step(con, "sm_extra_tables", lambda: _ensure_extra_tables(con), warn=True)
        _try_migration_step(con, "sm_seed_demo", lambda: seed_demo_users_if_empty(con))
        _try_migration_step(con, "sm_cnc41", lambda: _ensure_cnc41_machine(con), warn=True)
        _schema_ready = True
    if not _shift_checks_ready:
        _migrate_abc_to_day_night(con)
        _shift_checks_ready = _day_night_checks_ready(con)
    if not _ticket_status_ready:
        _try_migration_step(con, "sm_tk_status", lambda: _ensure_ticket_status_values(con), warn=True)


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


def _check_def(con, table: str, name: str) -> str:
    row = one(
        con.execute(
            """
            SELECT pg_get_constraintdef(c.oid) AS def
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND t.relname = %s
              AND c.conname = %s
            """,
            (table, name),
        )
    )
    return compact_text((row or {}).get("def"))


def _day_night_checks_ready(con) -> bool:
    """True when live CHECKs accept Day/Night rather than legacy A/B/C."""
    needed = (
        ("shift_mgmt_handovers", "shift_mgmt_handovers_shift_out_check"),
        ("shift_mgmt_handovers", "shift_mgmt_handovers_shift_in_check"),
        ("shift_mgmt_users", "shift_mgmt_users_default_shift_check"),
        ("shift_mgmt_tickets", "shift_mgmt_tickets_shift_out_check"),
    )
    for table, name in needed:
        text = _check_def(con, table, name)
        if "Day" not in text or "Night" not in text or "'A'" in text:
            return False
    return True


def _migrate_abc_to_day_night(con) -> None:
    """Map legacy A/B/C shifts to Day/Night and refresh CHECK constraints.

    The old check must be dropped before values are rewritten. Updating A to
    Day while the check still allows only A/B/C fails, the savepoint rolls
    the drop back, and the next handover insert of 'Day' violates the check.
    """

    def _refresh_users_check():
        con.execute(
            "ALTER TABLE public.shift_mgmt_users "
            "DROP CONSTRAINT IF EXISTS shift_mgmt_users_default_shift_check"
        )
        _drop_checks_on_columns(con, "shift_mgmt_users", ("default_shift",))
        con.execute(
            """
            UPDATE public.shift_mgmt_users
            SET default_shift = CASE
                WHEN default_shift IS NULL OR TRIM(default_shift) = '' THEN NULL
                WHEN default_shift IN ('A', 'Day') THEN 'Day'
                WHEN default_shift IN ('B', 'C', 'Night') THEN 'Night'
                ELSE NULL
            END
            """
        )
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
            UPDATE public.shift_mgmt_handovers
            SET shift_out = CASE
                WHEN shift_out IN ('A', 'Day') THEN 'Day'
                WHEN shift_out IN ('B', 'C', 'Night') THEN 'Night'
                ELSE 'Day'
            END
            """
        )
        con.execute(
            """
            UPDATE public.shift_mgmt_handovers
            SET shift_in = CASE
                WHEN shift_in IS NULL OR TRIM(shift_in) = '' THEN NULL
                WHEN shift_in IN ('A', 'Day') THEN 'Day'
                WHEN shift_in IN ('B', 'C', 'Night') THEN 'Night'
                ELSE NULL
            END
            """
        )
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
            UPDATE public.shift_mgmt_tickets
            SET shift_out = CASE
                WHEN shift_out IS NULL OR TRIM(shift_out) = '' THEN NULL
                WHEN shift_out IN ('A', 'Day') THEN 'Day'
                WHEN shift_out IN ('B', 'C', 'Night') THEN 'Night'
                ELSE NULL
            END
            """
        )
        con.execute(
            """
            ALTER TABLE public.shift_mgmt_tickets
            ADD CONSTRAINT shift_mgmt_tickets_shift_out_check
            CHECK (shift_out IS NULL OR shift_out IN ('Day', 'Night'))
            """
        )

    _try_migration_step(con, "sm_chk_users_shift", _refresh_users_check, warn=True)
    _try_migration_step(con, "sm_chk_ho_shift", _refresh_handovers_check, warn=True)
    _try_migration_step(con, "sm_chk_tk_shift", _refresh_tickets_check, warn=True)


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
        ALTER TABLE public.shift_mgmt_tickets
            ADD COLUMN IF NOT EXISTS submitter_name TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS submitter_username TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS submitter_role TEXT NOT NULL DEFAULT ''
        """
    )
    con.execute(
        """
        UPDATE public.shift_mgmt_tickets t
        SET submitter_name = COALESCE(NULLIF(BTRIM(u.display_name), ''), u.username, ''),
            submitter_username = COALESCE(u.username, ''),
            submitter_role = COALESCE(u.role, '')
        FROM public.shift_mgmt_users u
        WHERE u.user_id = t.created_by
          AND (
            COALESCE(BTRIM(t.submitter_name), '') = ''
            OR COALESCE(BTRIM(t.submitter_username), '') = ''
            OR COALESCE(BTRIM(t.submitter_role), '') = ''
          )
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
    _ensure_hoto_table(con)
    _ensure_production_report_table(con)


def _ensure_hoto_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_hoto_checklists (
            checklist_id            BIGSERIAL    PRIMARY KEY,
            work_date               DATE         NOT NULL,
            shift_out               TEXT         NOT NULL
                CHECK (shift_out IN ('Day', 'Night')),
            handover_at             TIMESTAMPTZ,
            outgoing_supervisor     TEXT         NOT NULL DEFAULT '',
            incoming_supervisor     TEXT         NOT NULL DEFAULT '',
            items                   JSONB        NOT NULL DEFAULT '[]'::jsonb,
            attendance              JSONB        NOT NULL DEFAULT '[]'::jsonb,
            outgoing_sign_name      TEXT         NOT NULL DEFAULT '',
            outgoing_signed_at      TIMESTAMPTZ,
            incoming_sign_name      TEXT         NOT NULL DEFAULT '',
            incoming_signed_at      TIMESTAMPTZ,
            updated_by              BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (work_date, shift_out)
        )
        """
    )
    con.execute(
        """
        ALTER TABLE public.shift_mgmt_hoto_checklists
            ADD COLUMN IF NOT EXISTS doc_status TEXT NOT NULL DEFAULT 'draft'
        """
    )
    con.execute(
        """
        ALTER TABLE public.shift_mgmt_hoto_checklists
            ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ
        """
    )
    con.execute(
        """
        ALTER TABLE public.shift_mgmt_hoto_checklists
            ADD COLUMN IF NOT EXISTS submitted_by BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_hoto_submissions (
            submission_id           BIGSERIAL    PRIMARY KEY,
            checklist_id            BIGINT
                REFERENCES public.shift_mgmt_hoto_checklists(checklist_id) ON DELETE SET NULL,
            work_date               DATE         NOT NULL,
            shift_out               TEXT         NOT NULL,
            handover_at             TIMESTAMPTZ,
            outgoing_supervisor     TEXT         NOT NULL DEFAULT '',
            incoming_supervisor     TEXT         NOT NULL DEFAULT '',
            items                   JSONB        NOT NULL DEFAULT '[]'::jsonb,
            attendance              JSONB        NOT NULL DEFAULT '[]'::jsonb,
            outgoing_sign_name      TEXT         NOT NULL DEFAULT '',
            outgoing_signed_at      TIMESTAMPTZ,
            incoming_sign_name      TEXT         NOT NULL DEFAULT '',
            incoming_signed_at      TIMESTAMPTZ,
            submitted_by            BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            submitted_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shift_mgmt_hoto_date
            ON public.shift_mgmt_hoto_checklists (work_date DESC, shift_out)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shift_mgmt_hoto_submissions_at
            ON public.shift_mgmt_hoto_submissions (submitted_at DESC)
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
    now = now or datetime.now(PLANNER_TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=PLANNER_TZ)
    else:
        now = now.astimezone(PLANNER_TZ)
    clock = time(now.hour, now.minute, now.second)
    if DAY_START <= clock < DAY_END:
        return "Day"
    return "Night"


def shift_scan_bounds(work_date: date, shift_out: str) -> tuple[datetime, datetime]:
    """Inclusive shop-clock window as a half-open [start, end) pair.

    Day on ``work_date`` is 08:01 through 20:00.
    Night on ``work_date`` is 20:01 through 08:00 the next morning.
    """
    shift = normalize_shift(shift_out)
    if shift == "Day":
        start = datetime.combine(work_date, DAY_START, tzinfo=PLANNER_TZ)
        end = datetime.combine(work_date, DAY_END, tzinfo=PLANNER_TZ)
    else:
        start = datetime.combine(work_date, NIGHT_START, tzinfo=PLANNER_TZ)
        end = datetime.combine(work_date + timedelta(days=1), NIGHT_END, tzinfo=PLANNER_TZ)
    return start, end


def shift_window_label(work_date: date, shift_out: str) -> str:
    start, end = shift_scan_bounds(work_date, shift_out)
    shown_end = end - timedelta(minutes=1)

    def _fmt(moment: datetime) -> str:
        return moment.astimezone(PLANNER_TZ).strftime("%Y-%m-%d %H:%M")

    return f"{_fmt(start)} to {_fmt(shown_end)}"


def machine_ids_for_user(con, user: dict[str, Any]) -> list[int] | None:
    """Return assigned machine ids, or None when user may see the full fleet."""
    from .shift_management_roles import capabilities

    caps = capabilities(user)
    if caps.get("fleet_view"):
        return None
    user_id = int(user["user_id"])
    assigned = rows(
        con.execute(
            """
            SELECT machine_id FROM public.shift_mgmt_user_machines WHERE user_id = %s
            """,
            (user_id,),
        )
    )
    ids = [int(r["machine_id"]) for r in assigned] if assigned else []
    return ids or None


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
                {", ROW_NUMBER() OVER (PARTITION BY b.machine_id ORDER BY b.queue_position, b.block_id) AS rn" if limit_n else ""}
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
            }
        )
    return out


def open_ticket_counts(con, machine_ids: list[int] | None = None) -> dict[tuple[int, str], int]:
    clauses = ["status IN ('open', 'in_progress', 'on_hold')"]
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
    clauses = ["status IN ('open', 'in_progress', 'on_hold')"]
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
        grouped.append(
            {
                "machine_id": mid,
                "machine_no": m.get("machine_no"),
                "machine_category": m.get("machine_category"),
                "handover": handovers_by_machine.get(mid),
                "open_ticket_count": machine_ticket_counts.get(mid, 0),
                "queue_count": len(jobs),
                "jobs": jobs,
            }
        )
    grouped.sort(key=lambda row: (0 if row["jobs"] else 1, str(row.get("machine_no") or "")))
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
    machine_ticket_counts = open_ticket_count_by_machine(con, mids)
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
    ticket_counts = open_ticket_count_by_machine(con, ids)
    queue_by_machine: dict[int, list[dict]] = {}
    for b in queue_blocks_for_machines(con, ids):
        queue_by_machine.setdefault(int(b["machine_id"]), []).append(b)

    result = []
    for m in machines:
        mid = int(m["machine_id"])
        ho = one(
            con.execute(
                """
                SELECT handover_id, status, machine_status, priority, job_no,
                       quality_issue_flag, alarm_flag, maintenance_flag, remaining_qty
                FROM public.shift_mgmt_handovers
                WHERE work_date = %s AND shift_out = %s AND machine_id = %s
                """,
                (work_date, shift_out, mid),
            )
        )
        qblocks = queue_by_machine.get(mid) or []
        head = qblocks[0] if qblocks else None
        result.append(
            {
                "machine_id": mid,
                "machine_no": m.get("machine_no"),
                "machine_category": m.get("machine_category"),
                "handover": serialize_handover(ho),
                "active_process_sheet": (head or {}).get("process_sheet_no") or "",
                "active_job_no": (head or {}).get("job_no") or "",
                "queue_remaining_qty": (head or {}).get("remaining_qty"),
                "queue_count": len(qblocks),
                "open_ticket_count": ticket_counts.get(mid, 0),
            }
        )
    return result


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
            con, machine_id=machine_id, status=",".join(OPEN_TICKET_STATUSES), limit=50
        )
        return out

    head = queue_head_for_machine(con, machine_id)
    job_no = compact_text(job_no_pref)
    remaining = 0
    if head:
        job_no = job_no or compact_text(head.get("process_sheet_no") or head.get("job_no"))
        try:
            remaining = int(float(head.get("remaining_qty") or 0))
        except (TypeError, ValueError, OverflowError):
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
            ON CONFLICT (work_date, shift_out, machine_id) DO NOTHING
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
    if row is None:
        return get_or_create_draft(
            con,
            work_date=work_date,
            shift_out=shift_out,
            machine_id=machine_id,
            user=user,
            job_no_pref=job_no_pref,
        )
    machine = one(
        con.execute(
            "SELECT machine_no FROM public.planner_machines WHERE machine_id = %s",
            (machine_id,),
        )
    )
    row["machine_no"] = machine.get("machine_no") if machine else None
    _audit(con, int(row["handover_id"]), user_id, "_lifecycle", None, "draft_created")
    out = serialize_handover(row)
    assert out is not None
    out["queue_jobs"] = queue_blocks_for_machines(con, [machine_id])
    out["comments"] = []
    out["tickets"] = list_tickets(
        con, machine_id=machine_id, status=",".join(OPEN_TICKET_STATUSES), limit=50
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
            con, machine_id=mid, status=",".join(OPEN_TICKET_STATUSES), limit=50
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
    from .shift_management_roles import has_cap

    if not has_cap(user, "can_handover"):
        return False
    status = compact_text(ho.get("status")).lower()
    if status == "acknowledged" and not has_cap(user, "can_resolve_ticket"):
        return False
    if status in ("pending_ack", "disputed"):
        return has_cap(user, "can_resolve_ticket")
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


def stamp_ticket_submitter(item: dict[str, Any]) -> dict[str, Any]:
    """Keep the raiser's name, username, and role on the ticket payload."""
    name = compact_text(item.get("submitter_name")) or compact_text(item.get("created_by_name"))
    username = compact_text(item.get("submitter_username")) or compact_text(
        item.get("created_by_username")
    )
    role = compact_text(item.get("submitter_role")) or compact_text(item.get("created_by_role"))
    item["submitter_name"] = name
    item["submitter_username"] = username
    item["submitter_role"] = role
    if name:
        item["created_by_name"] = name
    return item


def user_may_view_ticket(user: dict[str, Any], ticket: dict[str, Any]) -> bool:
    """Reviewers see the floor queue. Everyone else sees only tickets they raised."""
    from .shift_management_roles import has_cap

    if has_cap(user, "can_review_ticket"):
        return True
    try:
        return int(ticket.get("created_by") or 0) == int(user.get("user_id") or 0)
    except (TypeError, ValueError):
        return False


def list_tickets(
    con,
    *,
    machine_id: int | None = None,
    status: str | None = None,
    planner_ps_id: str | None = None,
    work_date: date | None = None,
    shift_out: str | None = None,
    created_by: int | None = None,
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
    if created_by:
        clauses.append("t.created_by = %s")
        params.append(int(created_by))
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
                   cb.username AS created_by_username,
                   cb.role AS created_by_role,
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
        out.append(stamp_ticket_submitter(item))
    return out


def get_ticket(con, ticket_id: int, *, with_comments: bool = True) -> dict[str, Any] | None:
    row = one(
        con.execute(
            """
            SELECT t.*, m.machine_no,
                   cb.display_name AS created_by_name,
                   cb.username AS created_by_username,
                   cb.role AS created_by_role,
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
        stamp_ticket_submitter(out)
        if with_comments:
            out["comments"] = list_ticket_comments(con, ticket_id)
    return out


def create_ticket(con, user: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    try:
        machine_id = int(data.get("machine_id"))
    except (TypeError, ValueError) as exc:
        raise ValueError("machine_id required") from exc
    title = compact_text(data.get("title"))
    if not title:
        raise ValueError("title required")
    from .shift_management_roles import capabilities

    caps = capabilities(user)
    category = compact_text(data.get("category")) or compact_text(
        caps.get("default_ticket_category")
    ) or "Other"
    if category not in TICKET_CATEGORIES:
        raise ValueError("Invalid category")
    priority = compact_text(data.get("priority")) or "Normal"
    if priority not in PRIORITIES:
        raise ValueError("Invalid priority")
    planner_ps_id = compact_text(data.get("planner_ps_id") or data.get("process_sheet_no")) or ""
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

    if assigned_to_int and not caps.get("can_assign_ticket"):
        assigned_to_int = None

    user_id = int(user["user_id"])
    submitter_name = compact_text(user.get("display_name")) or compact_text(user.get("username"))
    submitter_username = compact_text(user.get("username"))
    submitter_role = compact_text(user.get("role")) or "operator"
    row = one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_tickets
                (machine_id, planner_ps_id, job_no, block_id, category, title, description,
                 status, priority, created_by, assigned_to, handover_id, work_date, shift_out,
                 submitter_name, submitter_username, submitter_role)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'open', %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                submitter_name,
                submitter_username,
                submitter_role,
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
    if not ticket or not user_may_view_ticket(user, ticket):
        raise LookupError("Ticket not found")
    from .shift_management_roles import has_cap

    updates: list[str] = []
    params: list[Any] = []

    if "status" in patch:
        status = compact_text(patch.get("status")).lower()
        if status not in TICKET_STATUSES:
            raise ValueError("Invalid status")
        if not has_cap(user, "can_resolve_ticket"):
            raise PermissionError("Not allowed to update ticket status")
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
        if not has_cap(user, "can_assign_ticket"):
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
    if not ticket or not user_may_view_ticket(user, ticket):
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

    ticket_clauses = ["work_date = %s", "status IN ('open', 'in_progress', 'on_hold')"]
    ticket_params: list[Any] = [work_date]
    if shift_out:
        ticket_clauses.append("shift_out = %s")
        ticket_params.append(normalize_shift(shift_out))
    open_tickets_row = one(
        con.execute(
            f"""
            SELECT COUNT(*)::int AS n
            FROM public.shift_mgmt_tickets
            WHERE {" AND ".join(ticket_clauses)}
            """,
            tuple(ticket_params),
        )
    )
    kpis = {**kpis, "open_tickets": int((open_tickets_row or {}).get("n") or 0)}

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
                   h.ncr_status, m.machine_id, m.machine_no
            FROM public.shift_mgmt_handovers h
            JOIN public.planner_machines m ON m.machine_id = h.machine_id
            WHERE {" AND ".join(ho_clauses)}
            ORDER BY m.machine_no, h.shift_out
            """,
            tuple(ho_params),
        )
    )
    open_tickets = list_tickets(
        con,
        work_date=work_date,
        shift_out=normalize_shift(shift_out) if shift_out else None,
        status=",".join(OPEN_TICKET_STATUSES),
        limit=80,
    )
    fleet = list_active_machines(con, None)
    mids = [int(m["machine_id"]) for m in fleet]
    blocks = queue_blocks_for_machines(con, mids, per_machine_limit=OPS_QUEUE_DEPTH)
    queue_rows = group_ops_machines(fleet, blocks, {}, {}, {})
    queue_summary = [
        {
            "machine_id": row["machine_id"],
            "machine_no": row.get("machine_no"),
            "machine_category": row.get("machine_category"),
            "queue_count": row.get("queue_count") or 0,
            "head_job": (row.get("jobs") or [{}])[0] if row.get("jobs") else None,
        }
        for row in queue_rows
    ]
    return {
        "work_date": work_date.isoformat(),
        "shift_out": normalize_shift(shift_out) if shift_out else None,
        "kpis": {k: int(v or 0) for k, v in kpis.items()},
        "handovers": [serialize_handover(r) for r in machines],
        "open_tickets": open_tickets,
        "queue": queue_summary,
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


def list_shift_scans(con, work_date: date, shift_out: str) -> list[dict]:
    """ERP quantity jumps whose scan time falls inside the shift window."""
    start, end = shift_scan_bounds(work_date, shift_out)
    ready = one(con.execute("SELECT to_regclass('public.planner_erp_qty_jump') AS reg"))
    if not ready or not ready.get("reg"):
        return []
    data = rows(
        con.execute(
            """
            SELECT jump_id, source_mps_no, pp_partial_no, stage_no, stage_desc, op_no,
                   part_no, part_desc, job_no, so_no,
                   qty_jump, rej_jump, scanned_at, machine_id, machine_no
            FROM public.planner_erp_qty_jump
            WHERE scanned_at >= %s AND scanned_at < %s
            ORDER BY machine_no NULLS LAST, scanned_at, jump_id
            LIMIT 500
            """,
            (start, end),
        )
    )
    out: list[dict] = []
    for raw in data:
        item = serialize_row(raw) or {}
        scanned = raw.get("scanned_at")
        if isinstance(scanned, datetime):
            if scanned.tzinfo is None:
                scanned = scanned.replace(tzinfo=PLANNER_TZ)
            item["scanned_at_label"] = scanned.astimezone(PLANNER_TZ).strftime("%Y-%m-%d %H:%M")
        else:
            item["scanned_at_label"] = compact_text(item.get("scanned_at"))[:16]
        item["process_sheet_no"] = display_ps_id(raw.get("source_mps_no"), raw.get("job_no"))
        item["machine_no"] = compact_text(item.get("machine_no"))
        out.append(item)
    _fill_scan_machines(con, out)
    for item in out:
        if not compact_text(item.get("machine_no")):
            item["machine_no"] = "Unassigned"
    return out


def _fill_scan_machines(con, scans: list[dict]) -> None:
    """Use the live queue assignment when a scan row has no machine number."""
    if not any(not compact_text(item.get("machine_no")) for item in scans):
        return
    try:
        from .erp_scanned_output_service import _load_machine_assignments, wo_stage_key

        assigned = _load_machine_assignments(con)
    except Exception:
        log.debug("shift scan machine lookup failed", exc_info=True)
        return
    for item in scans:
        if compact_text(item.get("machine_no")):
            continue
        key = wo_stage_key(item.get("source_mps_no"), item.get("pp_partial_no"), item.get("stage_no"))
        machine = assigned.get(key) or {}
        name = compact_text(machine.get("machine_no"))
        if name:
            item["machine_no"] = name
            if machine.get("machine_id"):
                item["machine_id"] = machine.get("machine_id")


def group_scans_by_machine(scans: list[dict]) -> list[dict]:
    buckets: dict[str, list[dict]] = {}
    order: list[str] = []
    for scan in scans:
        key = compact_text(scan.get("machine_no")) or "Unassigned"
        if key not in buckets:
            order.append(key)
            buckets[key] = []
        buckets[key].append(scan)
    grouped = []
    for key in order:
        items = buckets[key]
        qty = 0.0
        rej = 0.0
        for item in items:
            try:
                qty += float(item.get("qty_jump") or 0)
            except (TypeError, ValueError):
                pass
            try:
                rej += float(item.get("rej_jump") or 0)
            except (TypeError, ValueError):
                pass
        grouped.append(
            {
                "machine_no": key,
                "scans": items,
                "qty": qty,
                "reject": rej,
            }
        )
    return grouped


def report_payload(con, work_date: date, shift_out: str) -> dict[str, Any]:
    shift_out = normalize_shift(shift_out)
    scans = list_shift_scans(con, work_date, shift_out)
    scan_groups = group_scans_by_machine(scans)
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
    scanned_qty = sum(float(group.get("qty") or 0) for group in scan_groups)
    scanned_reject = sum(float(group.get("reject") or 0) for group in scan_groups)
    return {
        "work_date": work_date.isoformat(),
        "shift_out": shift_out,
        "shift_in": opposite_shift(shift_out),
        "window_label": shift_window_label(work_date, shift_out),
        "generated_at": datetime.now(PLANNER_TZ).strftime("%Y-%m-%d %H:%M"),
        "handovers": enriched,
        "tickets": tickets,
        "scans": scans,
        "scan_groups": scan_groups,
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
            "scan_count": len(scans),
            "scanned_machines": len(scan_groups),
            "scanned_qty": scanned_qty,
            "scanned_reject": scanned_reject,
        },
    }


HOTO_STATUSES = ("No Issue", "Issue Raised")
HOTO_ATTENDANCE_ROWS = 11
HOTO_CHECKLIST_ITEMS = (
    {"no": 1, "text": "Work done / production plan for the shift communicated", "see": "", "see_href": "", "see_external": False},
    {
        "no": 2,
        "text": "Qty produced this shift reported",
        "see": "ERP scanned output",
        "see_href": "/erp-scanned-output",
        "see_external": True,
    },
    {
        "no": 3,
        "text": "Scanned items for this shift logged",
        "see": "ERP scanned output",
        "see_href": "/erp-scanned-output",
        "see_external": True,
    },
    {
        "no": 4,
        "text": "Open issues reviewed and handed over",
        "see": "QAQC view",
        "see_href": "/qaqc-view",
        "see_external": True,
    },
    {
        "no": 5,
        "text": "Machines/equipment status and WIP handed over",
        "see": "",
        "see_href": "",
        "see_external": False,
    },
    {
        "no": 6,
        "text": "Housekeeping, tools, keys, and access handed over",
        "see": "",
        "see_href": "",
        "see_external": False,
    },
)


def _json_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return compact_text(value).lower() in {"1", "true", "yes", "y", "on"}


def _parse_handover_at(raw: Any) -> datetime | None:
    if isinstance(raw, datetime):
        dt = raw
    else:
        text = compact_text(raw).replace("Z", "+00:00")
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=PLANNER_TZ)
    return dt.astimezone(PLANNER_TZ)


def _format_local_dt(value: Any) -> str:
    dt = _parse_handover_at(value)
    if not dt:
        return ""
    return dt.strftime("%Y-%m-%dT%H:%M")


def normalize_hoto_items(raw: Any) -> list[dict[str, Any]]:
    by_no: dict[int, dict[str, Any]] = {}
    for row in _json_list(raw):
        if not isinstance(row, dict):
            continue
        try:
            no = int(row.get("no"))
        except (TypeError, ValueError):
            continue
        status = compact_text(row.get("status"))
        if status not in HOTO_STATUSES:
            status = ""
        by_no[no] = {
            "no": no,
            "status": status,
            "remarks": compact_text(row.get("remarks"))[:500],
            "checked_by": compact_text(row.get("checked_by"))[:120],
        }
    return [
        by_no.get(item["no"])
        or {"no": item["no"], "status": "", "remarks": "", "checked_by": ""}
        for item in HOTO_CHECKLIST_ITEMS
    ]


def normalize_hoto_attendance(raw: Any) -> list[dict[str, Any]]:
    by_no: dict[int, dict[str, Any]] = {}
    for row in _json_list(raw):
        if not isinstance(row, dict):
            continue
        try:
            no = int(row.get("no"))
        except (TypeError, ValueError):
            continue
        if no < 1 or no > HOTO_ATTENDANCE_ROWS:
            continue
        by_no[no] = {
            "no": no,
            "name": compact_text(row.get("name"))[:120],
            "late": _as_bool(row.get("late")),
            "remarks": compact_text(row.get("remarks"))[:300],
        }
    return [
        by_no.get(no) or {"no": no, "name": "", "late": False, "remarks": ""}
        for no in range(1, HOTO_ATTENDANCE_ROWS + 1)
    ]


def blank_hoto_checklist(work_date: date, shift_out: str) -> dict[str, Any]:
    shift = normalize_shift(shift_out)
    return {
        "checklist_id": None,
        "work_date": work_date.isoformat(),
        "shift_out": shift,
        "handover_at": _format_local_dt(datetime.now(PLANNER_TZ)),
        "outgoing_supervisor": "",
        "incoming_supervisor": "",
        "items": normalize_hoto_items([]),
        "attendance": normalize_hoto_attendance([]),
        "outgoing_sign_name": "",
        "outgoing_signed_at": "",
        "incoming_sign_name": "",
        "incoming_signed_at": "",
        "doc_status": "draft",
        "submitted_at": "",
        "submitted_by_name": "",
        "locked": False,
        "saved": False,
    }


class HotoSubmitError(ValueError):
    """The handover sheet is not ready to file."""


def hoto_submit_blockers(checklist: dict[str, Any]) -> list[str]:
    """Return the reasons a sheet cannot be filed. Empty means it can."""
    missing = []
    if not compact_text(checklist.get("outgoing_supervisor")):
        missing.append("outgoing shift rep")
    if not compact_text(checklist.get("incoming_supervisor")):
        missing.append("incoming shift rep")
    if not compact_text(checklist.get("outgoing_sign_name")):
        missing.append("outgoing signature")
    if not compact_text(checklist.get("incoming_sign_name")):
        missing.append("incoming signature")
    if not missing:
        return []
    return ["Add " + ", ".join(missing) + " before submitting."]


def _merge_sign(
    new_name: Any,
    old_name: Any,
    old_at: Any,
    confirm: bool,
) -> tuple[str, datetime | None]:
    """Stamp a signature only on confirm. A later name edit keeps that stamp."""
    name = compact_text(new_name)[:120]
    if not name:
        return "", None
    kept = _parse_handover_at(old_at) if old_at else None
    same = name == compact_text(old_name)
    if confirm:
        return name, kept if same and kept else datetime.now(PLANNER_TZ)
    if kept:
        return name, kept
    return name, None


def serialize_hoto(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    data = serialize_row(dict(row)) or {}
    data["items"] = normalize_hoto_items(row.get("items"))
    data["attendance"] = normalize_hoto_attendance(row.get("attendance"))
    data["handover_at"] = _format_local_dt(row.get("handover_at"))
    data["outgoing_signed_at"] = _format_local_dt(row.get("outgoing_signed_at"))
    data["incoming_signed_at"] = _format_local_dt(row.get("incoming_signed_at"))
    data["submitted_at"] = _format_local_dt(row.get("submitted_at"))
    status = compact_text(row.get("doc_status")) or "draft"
    if status not in ("draft", "submitted"):
        status = "draft"
    data["doc_status"] = status
    data["submitted_by_name"] = compact_text(row.get("submitted_by_name"))
    data["locked"] = status == "submitted" or bool(row.get("read_only"))
    data["work_date"] = compact_text(data.get("work_date"))[:10]
    data["saved"] = True
    return data


def get_hoto_checklist(con, work_date: date, shift_out: str) -> dict[str, Any]:
    shift = normalize_shift(shift_out)
    row = one(
        con.execute(
            """
            SELECT c.*, u.display_name AS submitted_by_name
            FROM public.shift_mgmt_hoto_checklists c
            LEFT JOIN public.shift_mgmt_users u ON u.user_id = c.submitted_by
            WHERE c.work_date = %s AND c.shift_out = %s
            """,
            (work_date, shift),
        )
    )
    if not row:
        return blank_hoto_checklist(work_date, shift)
    payload = serialize_hoto(row)
    assert payload is not None
    return payload


def save_hoto_checklist(
    con,
    *,
    work_date: date,
    shift_out: str,
    data: dict[str, Any],
    user: dict[str, Any] | None,
) -> dict[str, Any]:
    from psycopg2.extras import Json

    shift = normalize_shift(shift_out)
    existing = one(
        con.execute(
            """
            SELECT doc_status, outgoing_sign_name, outgoing_signed_at,
                   incoming_sign_name, incoming_signed_at
            FROM public.shift_mgmt_hoto_checklists
            WHERE work_date = %s AND shift_out = %s
            """,
            (work_date, shift),
        )
    ) or {}
    if compact_text(existing.get("doc_status")) == "submitted":
        return get_hoto_checklist(con, work_date, shift)
    items = normalize_hoto_items(data.get("items"))
    attendance = normalize_hoto_attendance(data.get("attendance"))
    outgoing = compact_text(data.get("outgoing_supervisor"))[:120]
    incoming = compact_text(data.get("incoming_supervisor"))[:120]
    handover_at = _parse_handover_at(data.get("handover_at")) or datetime.now(PLANNER_TZ)
    out_name, out_at = _merge_sign(
        data.get("outgoing_sign_name"),
        existing.get("outgoing_sign_name"),
        existing.get("outgoing_signed_at"),
        _as_bool(data.get("outgoing_sign")),
    )
    in_name, in_at = _merge_sign(
        data.get("incoming_sign_name"),
        existing.get("incoming_sign_name"),
        existing.get("incoming_signed_at"),
        _as_bool(data.get("incoming_sign")),
    )
    user_id = None
    if user and user.get("user_id"):
        user_id = int(user["user_id"])
    row = one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_hoto_checklists (
                work_date, shift_out, handover_at,
                outgoing_supervisor, incoming_supervisor,
                items, attendance,
                outgoing_sign_name, outgoing_signed_at,
                incoming_sign_name, incoming_signed_at,
                updated_by, updated_at
            ) VALUES (
                %s, %s, %s,
                %s, %s,
                %s::jsonb, %s::jsonb,
                %s, %s,
                %s, %s,
                %s, NOW()
            )
            ON CONFLICT (work_date, shift_out) DO UPDATE SET
                handover_at = EXCLUDED.handover_at,
                outgoing_supervisor = EXCLUDED.outgoing_supervisor,
                incoming_supervisor = EXCLUDED.incoming_supervisor,
                items = EXCLUDED.items,
                attendance = EXCLUDED.attendance,
                outgoing_sign_name = EXCLUDED.outgoing_sign_name,
                outgoing_signed_at = EXCLUDED.outgoing_signed_at,
                incoming_sign_name = EXCLUDED.incoming_sign_name,
                incoming_signed_at = EXCLUDED.incoming_signed_at,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
            RETURNING *
            """,
            (
                work_date,
                shift,
                handover_at,
                outgoing,
                incoming,
                Json(items),
                Json(attendance),
                out_name,
                out_at,
                in_name,
                in_at,
                user_id,
            ),
        )
    )
    payload = serialize_hoto(row)
    assert payload is not None
    return payload


def _hoto_user_id(user: dict[str, Any] | None) -> int | None:
    if user and user.get("user_id"):
        return int(user["user_id"])
    return None


def submit_hoto_checklist(
    con,
    *,
    work_date: date,
    shift_out: str,
    data: dict[str, Any],
    user: dict[str, Any] | None,
) -> dict[str, Any]:
    """File the current sheet into the handover log and lock it."""
    shift = normalize_shift(shift_out)
    current = get_hoto_checklist(con, work_date, shift)
    if current.get("doc_status") == "submitted":
        raise HotoSubmitError("This handover is already submitted.")
    saved = save_hoto_checklist(
        con,
        work_date=work_date,
        shift_out=shift,
        data=data,
        user=user,
    )
    blockers = hoto_submit_blockers(saved)
    if blockers:
        raise HotoSubmitError(blockers[0])
    user_id = _hoto_user_id(user)
    submitted_at = datetime.now(PLANNER_TZ)
    con.execute(
        """
        INSERT INTO public.shift_mgmt_hoto_submissions (
            checklist_id, work_date, shift_out, handover_at,
            outgoing_supervisor, incoming_supervisor,
            items, attendance,
            outgoing_sign_name, outgoing_signed_at,
            incoming_sign_name, incoming_signed_at,
            submitted_by, submitted_at
        )
        SELECT checklist_id, work_date, shift_out, handover_at,
               outgoing_supervisor, incoming_supervisor,
               items, attendance,
               outgoing_sign_name, outgoing_signed_at,
               incoming_sign_name, incoming_signed_at,
               %s, %s
        FROM public.shift_mgmt_hoto_checklists
        WHERE work_date = %s AND shift_out = %s
        """,
        (user_id, submitted_at, work_date, shift),
    )
    con.execute(
        """
        UPDATE public.shift_mgmt_hoto_checklists
        SET doc_status = 'submitted',
            submitted_at = %s,
            submitted_by = %s,
            updated_at = NOW()
        WHERE work_date = %s AND shift_out = %s
        """,
        (submitted_at, user_id, work_date, shift),
    )
    filed = get_hoto_checklist(con, work_date, shift)
    filed["locked"] = True
    return filed


def reopen_hoto_checklist(con, work_date: date, shift_out: str) -> dict[str, Any]:
    """Unlock a filed sheet so it can be corrected. The log row stays."""
    shift = normalize_shift(shift_out)
    con.execute(
        """
        UPDATE public.shift_mgmt_hoto_checklists
        SET doc_status = 'draft', updated_at = NOW()
        WHERE work_date = %s AND shift_out = %s
        """,
        (work_date, shift),
    )
    sheet = get_hoto_checklist(con, work_date, shift)
    sheet["locked"] = False
    return sheet


def list_hoto_submissions(
    con,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    shift_out: str | None = None,
    limit: int = 300,
) -> list[dict[str, Any]]:
    clauses = ["TRUE"]
    params: list[Any] = []
    if date_from:
        clauses.append("s.work_date >= %s")
        params.append(date_from)
    if date_to:
        clauses.append("s.work_date <= %s")
        params.append(date_to)
    if shift_out in ("Day", "Night"):
        clauses.append("s.shift_out = %s")
        params.append(shift_out)
    params.append(max(1, min(int(limit), 500)))
    found = rows(
        con.execute(
            f"""
            SELECT s.submission_id, s.work_date, s.shift_out, s.handover_at,
                   s.outgoing_supervisor, s.incoming_supervisor,
                   s.outgoing_sign_name, s.incoming_sign_name,
                   s.submitted_at, u.display_name AS submitted_by_name
            FROM public.shift_mgmt_hoto_submissions s
            LEFT JOIN public.shift_mgmt_users u ON u.user_id = s.submitted_by
            WHERE {" AND ".join(clauses)}
            ORDER BY s.submitted_at DESC, s.submission_id DESC
            LIMIT %s
            """,
            tuple(params),
        )
    )
    items = []
    for row in found:
        item = serialize_row(dict(row)) or {}
        item["work_date"] = compact_text(item.get("work_date"))[:10]
        item["submitted_at"] = _format_local_dt(row.get("submitted_at"))
        item["handover_at"] = _format_local_dt(row.get("handover_at"))
        item["submitted_by_name"] = compact_text(item.get("submitted_by_name"))
        items.append(item)
    return items


def get_hoto_submission(con, submission_id: int) -> dict[str, Any] | None:
    row = one(
        con.execute(
            """
            SELECT s.*, u.display_name AS submitted_by_name
            FROM public.shift_mgmt_hoto_submissions s
            LEFT JOIN public.shift_mgmt_users u ON u.user_id = s.submitted_by
            WHERE s.submission_id = %s
            """,
            (submission_id,),
        )
    )
    if not row:
        return None
    row = dict(row)
    row["doc_status"] = "submitted"
    row["read_only"] = True
    payload = serialize_hoto(row)
    assert payload is not None
    payload["locked"] = True
    payload["read_only"] = True
    payload["submission_id"] = int(row["submission_id"])
    return payload


PRODUCTION_REPORT_MIN_ROWS = 8
PRODUCTION_REPORT_MAX_ROWS = 24


def _ensure_production_report_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_production_reports (
            report_id     BIGSERIAL    PRIMARY KEY,
            work_date     DATE         NOT NULL,
            shift_out     TEXT         NOT NULL
                CHECK (shift_out IN ('Day', 'Night')),
            lines         JSONB        NOT NULL DEFAULT '[]'::jsonb,
            updated_by    BIGINT
                REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (work_date, shift_out)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shift_mgmt_production_reports_date
            ON public.shift_mgmt_production_reports (work_date DESC, shift_out)
        """
    )


def _optional_qty(value: Any) -> int | float | None:
    if value is None:
        return None
    text = compact_text(value)
    if not text:
        return None
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    if abs(number - round(number)) < 0.001:
        return int(round(number))
    return round(number, 3)


def _blank_production_line() -> dict[str, Any]:
    return {
        "no": 0,
        "process_sheet_no": "",
        "description": "",
        "target_qty": None,
        "produced_qty": None,
        "rejected_qty": None,
        "cnc": "",
        "scanned_erp": "",
    }


def _production_line_has_data(line: dict[str, Any]) -> bool:
    return bool(
        line.get("process_sheet_no")
        or line.get("description")
        or line.get("cnc")
        or line.get("scanned_erp")
        or line.get("target_qty") is not None
        or line.get("produced_qty") is not None
        or line.get("rejected_qty") is not None
    )


def _normalize_production_line(raw: Any) -> dict[str, Any]:
    row = raw if isinstance(raw, dict) else {}
    scanned = compact_text(row.get("scanned_erp")).upper()
    if scanned not in {"Y", "N"}:
        scanned = ""
    line = _blank_production_line()
    line.update(
        {
            "process_sheet_no": compact_text(row.get("process_sheet_no")).upper()[:80],
            "description": compact_text(row.get("description"))[:200],
            "target_qty": _optional_qty(row.get("target_qty")),
            "produced_qty": _optional_qty(row.get("produced_qty")),
            "rejected_qty": _optional_qty(row.get("rejected_qty")),
            "cnc": compact_text(row.get("cnc"))[:40],
            "scanned_erp": scanned,
        }
    )
    return line


def normalize_production_lines(raw: Any) -> list[dict[str, Any]]:
    parsed = [
        _normalize_production_line(row)
        for row in _json_list(raw)[:PRODUCTION_REPORT_MAX_ROWS]
    ]
    while (
        parsed
        and not _production_line_has_data(parsed[-1])
        and len(parsed) > PRODUCTION_REPORT_MIN_ROWS
    ):
        parsed.pop()
    while len(parsed) < PRODUCTION_REPORT_MIN_ROWS:
        parsed.append(_blank_production_line())
    for index, line in enumerate(parsed, 1):
        line["no"] = index
    return parsed


def blank_production_report(work_date: date, shift_out: str) -> dict[str, Any]:
    return {
        "work_date": work_date.isoformat(),
        "shift_out": normalize_shift(shift_out),
        "lines": normalize_production_lines([]),
        "saved": False,
        "updated_at": "",
    }


def list_cnc_machine_names(con) -> list[str]:
    data = rows(
        con.execute(
            """
            SELECT machine_no
            FROM public.planner_machines
            WHERE COALESCE(active, TRUE) = TRUE
              AND NULLIF(TRIM(machine_no), '') IS NOT NULL
              AND (
                UPPER(TRIM(COALESCE(machine_category, ''))) IN ('TURNING', 'MILLING', 'TURNMILL', 'MPP')
                OR UPPER(TRIM(machine_no)) LIKE '%CNC%'
              )
            ORDER BY machine_no
            """
        )
    )
    names: list[str] = []
    seen: set[str] = set()
    for row in data:
        name = compact_text(row.get("machine_no"))
        key = name.upper()
        if not name or key in seen:
            continue
        seen.add(key)
        names.append(name)
    return names


def _ps_lookup_key(raw: Any) -> str:
    text = compact_text(raw).upper()
    if "::" in text:
        text = text.split("::", 1)[0].strip()
    return text


def lookup_process_sheet_summary(con, process_sheet_no: str) -> dict[str, Any]:
    """Description and order qty for a process sheet number typed on the report."""
    from .helpers import planner_try_savepoint

    typed = compact_text(process_sheet_no)
    key = _ps_lookup_key(typed)
    empty = {
        "process_sheet_no": key or typed.upper(),
        "description": "",
        "target_qty": None,
        "found": False,
    }
    if not key:
        return empty

    def _from_cache():
        return one(
            con.execute(
                """
                SELECT
                    MAX(split_part(ps_id, '::', 1)) AS process_sheet_no,
                    MAX(NULLIF(TRIM(description), '')) AS description,
                    MAX(NULLIF(TRIM(part_no), '')) AS part_no,
                    MAX(total_qty) AS total_qty
                FROM pp_vouchers_cache
                WHERE UPPER(TRIM(split_part(ps_id, '::', 1))) = %s
                """,
                (key,),
            )
        )

    def _from_sheet_info():
        return one(
            con.execute(
                """
                SELECT
                    MAX(process_sheet_no) AS process_sheet_no,
                    '' AS description,
                    MAX(NULLIF(TRIM(inventory_code), '')) AS part_no,
                    MAX(total_qty) AS total_qty
                FROM mfg_process_sheet_info
                WHERE UPPER(TRIM(process_sheet_no)) = %s
                """,
                (key,),
            )
        )

    row = planner_try_savepoint(con, "sm_ps_cache", _from_cache, default=None)
    if not row or not compact_text(row.get("process_sheet_no")):
        row = planner_try_savepoint(con, "sm_ps_info", _from_sheet_info, default=None)
    if not row or not compact_text(row.get("process_sheet_no")):
        return empty

    description = compact_text(row.get("description"))
    part_no = compact_text(row.get("part_no"))
    if not description and part_no:
        def _from_part_desc():
            return one(
                con.execute(
                    """
                    SELECT main_desc
                    FROM part_desc
                    WHERE inventory_code = %s
                    """,
                    (part_no,),
                )
            )

        part = planner_try_savepoint(con, "sm_ps_desc", _from_part_desc, default=None)
        description = compact_text((part or {}).get("main_desc"))

    return {
        "process_sheet_no": compact_text(row.get("process_sheet_no")).upper() or key,
        "description": description[:200],
        "target_qty": _optional_qty(row.get("total_qty")),
        "found": True,
    }


def _like_literal(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _suggest_rank(row: dict[str, Any], needle: str) -> tuple[int, str]:
    key = compact_text(row.get("ps_key") or row.get("process_sheet_no")).upper()
    compact_key = key.replace("-", "").replace(" ", "")
    compact_needle = needle.replace("-", "").replace(" ", "")
    prefix = key.startswith(needle) or (compact_needle and compact_key.startswith(compact_needle))
    return (0 if prefix else 1, key)


def _suggest_search_sql(source: str) -> str:
    if source == "cache":
        key_expr = "UPPER(TRIM(split_part(ps_id, '::', 1)))"
        sheet_expr = "MAX(split_part(ps_id, '::', 1))"
        desc_expr = "MAX(NULLIF(TRIM(description), ''))"
        part_expr = "MAX(NULLIF(TRIM(part_no), ''))"
        qty_expr = "MAX(total_qty)"
        table = "pp_vouchers_cache"
    else:
        key_expr = "UPPER(TRIM(process_sheet_no))"
        sheet_expr = "MAX(process_sheet_no)"
        desc_expr = "''"
        part_expr = "MAX(NULLIF(TRIM(inventory_code), ''))"
        qty_expr = "MAX(total_qty)"
        table = "mfg_process_sheet_info"
    return f"""
        SELECT ps_key, process_sheet_no, description, part_no, total_qty
        FROM (
            SELECT
                {key_expr} AS ps_key,
                {sheet_expr} AS process_sheet_no,
                {desc_expr} AS description,
                {part_expr} AS part_no,
                {qty_expr} AS total_qty
            FROM {table}
            WHERE {key_expr} LIKE %s ESCAPE '\\'
               OR REPLACE({key_expr}, '-', '') LIKE %s ESCAPE '\\'
            GROUP BY 1
        ) matches
        ORDER BY
            CASE
                WHEN ps_key LIKE %s ESCAPE '\\' THEN 0
                WHEN REPLACE(ps_key, '-', '') LIKE %s ESCAPE '\\' THEN 0
                ELSE 1
            END,
            ps_key
        LIMIT %s
    """


def suggest_process_sheets(con, query: str, *, limit: int = 8) -> list[dict[str, Any]]:
    """Process-sheet matches for the reporting typeahead."""
    from .helpers import planner_try_savepoint

    needle = _ps_lookup_key(query)
    if len(needle) < 2:
        return []
    cap = max(1, min(int(limit or 8), 12))
    escaped = _like_literal(needle)
    compact = _like_literal(needle.replace("-", "").replace(" ", ""))
    params = (f"%{escaped}%", f"%{compact}%", f"{escaped}%", f"{compact}%", cap)

    def _search(source: str):
        return rows(con.execute(_suggest_search_sql(source), params))

    cached = planner_try_savepoint(con, "sm_ps_suggest_cache", lambda: _search("cache"), default=None) or []
    extra = planner_try_savepoint(con, "sm_ps_suggest_info", lambda: _search("info"), default=None) or []

    merged: dict[str, dict[str, Any]] = {}
    for row in list(cached) + list(extra):
        key = compact_text((row or {}).get("ps_key") or (row or {}).get("process_sheet_no")).upper()
        if not key or key in merged:
            continue
        merged[key] = row
    picked = sorted(merged.values(), key=lambda row: _suggest_rank(row, needle))[:cap]
    if not picked:
        return []

    missing_parts = sorted({
        compact_text(row.get("part_no"))
        for row in picked
        if compact_text(row.get("part_no")) and not compact_text(row.get("description"))
    })
    descriptions: dict[str, str] = {}
    if missing_parts:
        def _part_descs():
            return rows(
                con.execute(
                    """
                    SELECT inventory_code, main_desc
                    FROM part_desc
                    WHERE inventory_code = ANY(%s)
                    """,
                    (missing_parts,),
                )
            )

        fetched = planner_try_savepoint(con, "sm_ps_suggest_desc", _part_descs, default=None) or []
        descriptions = {
            compact_text(row.get("inventory_code")): compact_text(row.get("main_desc"))
            for row in fetched
            if compact_text(row.get("inventory_code"))
        }

    hits: list[dict[str, Any]] = []
    for row in picked:
        description = compact_text(row.get("description")) or descriptions.get(compact_text(row.get("part_no")), "")
        sheet = compact_text(row.get("process_sheet_no")).upper()
        if not sheet:
            continue
        hits.append(
            {
                "process_sheet_no": sheet,
                "description": description[:200],
                "target_qty": _optional_qty(row.get("total_qty")),
            }
        )
    return hits


def get_production_report(con, work_date: date, shift_out: str) -> dict[str, Any]:
    shift = normalize_shift(shift_out)
    row = one(
        con.execute(
            """
            SELECT lines, updated_at
            FROM public.shift_mgmt_production_reports
            WHERE work_date = %s AND shift_out = %s
            """,
            (work_date, shift),
        )
    )
    if not row:
        sheet = blank_production_report(work_date, shift)
    else:
        sheet = {
            "work_date": work_date.isoformat(),
            "shift_out": shift,
            "lines": normalize_production_lines(row.get("lines")),
            "saved": True,
            "updated_at": _jsonable(row.get("updated_at")) or "",
        }
    sheet["cnc_machines"] = list_cnc_machine_names(con)
    return sheet


def save_production_report(
    con,
    *,
    work_date: date,
    shift_out: str,
    data: dict[str, Any],
    user: dict[str, Any] | None,
) -> dict[str, Any]:
    from psycopg2.extras import Json

    shift = normalize_shift(shift_out)
    lines = normalize_production_lines(data.get("lines"))
    user_id = int(user["user_id"]) if user and user.get("user_id") else None
    one(
        con.execute(
            """
            INSERT INTO public.shift_mgmt_production_reports (
                work_date, shift_out, lines, updated_by, updated_at
            ) VALUES (%s, %s, %s::jsonb, %s, NOW())
            ON CONFLICT (work_date, shift_out) DO UPDATE SET
                lines = EXCLUDED.lines,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
            RETURNING report_id
            """,
            (work_date, shift, Json(lines), user_id),
        )
    )
    return get_production_report(con, work_date, shift)


def _record_date(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return compact_text(value)[:10]


def _record_shift(value: Any) -> str:
    text = compact_text(value)
    if text in {"A", "Day"}:
        return "Day"
    if text in {"B", "C", "Night"}:
        return "Night"
    return ""


def _filled_report_count(lines: Any) -> int:
    count = 0
    for raw in _json_list(lines)[:PRODUCTION_REPORT_MAX_ROWS]:
        if _production_line_has_data(_normalize_production_line(raw)):
            count += 1
    return count


def merge_shift_records(
    reports: list[dict] | None,
    checklists: list[dict] | None,
    tickets: list[dict] | None,
) -> list[dict[str, Any]]:
    """One row per date and shift that has a report, a HOTO sheet, or tickets."""
    slots: dict[tuple[str, str], dict[str, Any]] = {}

    def slot(work_date: Any, shift_out: Any) -> dict[str, Any] | None:
        day = _record_date(work_date)
        shift = _record_shift(shift_out)
        if not day or not shift:
            return None
        key = (day, shift)
        if key not in slots:
            slots[key] = {
                "work_date": day,
                "shift_out": shift,
                "report_filed": False,
                "report_line_count": 0,
                "hoto_status": "",
                "hoto_submitted_at": "",
                "outgoing_supervisor": "",
                "incoming_supervisor": "",
                "submitted_by_name": "",
                "ticket_count": 0,
                "open_ticket_count": 0,
            }
        return slots[key]

    for row in reports or []:
        filled = _filled_report_count(row.get("lines"))
        if filled <= 0:
            continue
        item = slot(row.get("work_date"), row.get("shift_out"))
        if not item:
            continue
        item["report_filed"] = True
        item["report_line_count"] = filled

    for row in checklists or []:
        item = slot(row.get("work_date"), row.get("shift_out"))
        if not item:
            continue
        status = compact_text(row.get("doc_status")) or "draft"
        if status not in ("draft", "submitted"):
            status = "draft"
        item["hoto_status"] = status
        submitted = row.get("submitted_at")
        item["hoto_submitted_at"] = _format_local_dt(submitted) if submitted else ""
        item["outgoing_supervisor"] = compact_text(row.get("outgoing_supervisor"))
        item["incoming_supervisor"] = compact_text(row.get("incoming_supervisor"))
        item["submitted_by_name"] = compact_text(row.get("submitted_by_name"))

    for row in tickets or []:
        count = int(row.get("ticket_count") or 0)
        if count <= 0:
            continue
        item = slot(row.get("work_date"), row.get("shift_out"))
        if not item:
            continue
        item["ticket_count"] = count
        item["open_ticket_count"] = int(row.get("open_ticket_count") or 0)

    items = [
        row
        for row in slots.values()
        if row["report_filed"] or row["hoto_status"] or row["ticket_count"]
    ]
    items.sort(
        key=lambda row: (row["work_date"], 1 if row["shift_out"] == "Night" else 0),
        reverse=True,
    )
    return items


def list_shift_records(
    con,
    *,
    date_from: date,
    date_to: date,
    shift_out: str | None = None,
) -> list[dict[str, Any]]:
    """Index of filed shifts: production report, HOTO, and ticket counts."""
    shift = shift_out if shift_out in ("Day", "Night") else None
    params: list[Any] = [date_from, date_to]
    shift_sql = ""
    hoto_shift_sql = ""
    if shift:
        shift_sql = " AND shift_out = %s"
        hoto_shift_sql = " AND c.shift_out = %s"
        params.append(shift)
    bound = tuple(params)
    reports = rows(
        con.execute(
            f"""
            SELECT work_date, shift_out, lines
            FROM public.shift_mgmt_production_reports
            WHERE work_date >= %s AND work_date <= %s
            {shift_sql}
            """,
            bound,
        )
    )
    checklists = rows(
        con.execute(
            f"""
            SELECT c.work_date, c.shift_out, c.doc_status, c.submitted_at,
                   c.outgoing_supervisor, c.incoming_supervisor,
                   u.display_name AS submitted_by_name
            FROM public.shift_mgmt_hoto_checklists c
            LEFT JOIN public.shift_mgmt_users u ON u.user_id = c.submitted_by
            WHERE c.work_date >= %s AND c.work_date <= %s
            {hoto_shift_sql}
            """,
            bound,
        )
    )
    ticket_rows = rows(
        con.execute(
            f"""
            SELECT work_date, shift_out,
                   COUNT(*) AS ticket_count,
                   COUNT(*) FILTER (
                       WHERE status IN ('open', 'in_progress', 'on_hold')
                   ) AS open_ticket_count
            FROM public.shift_mgmt_tickets
            WHERE work_date >= %s AND work_date <= %s
              AND work_date IS NOT NULL
            {shift_sql}
            GROUP BY work_date, shift_out
            """,
            bound,
        )
    )
    return merge_shift_records(reports, checklists, ticket_rows)


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
        "open_ticket_statuses": list(OPEN_TICKET_STATUSES),
        "guess_shift": _guess_shift(),
        "day_window": "08:01-20:00",
        "night_window": "20:01-08:00",
    }
