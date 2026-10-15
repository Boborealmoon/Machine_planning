"""CMM technician queue.

The active list is the programme queue: every process sheet waiting there
gets an open CMM job. Completed history stays a separate query and does not
read NEW parts.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from psycopg2.errors import UniqueViolation
from psycopg2.extras import Json

from .helpers import one, planner_db, rows
from .staged_erp import serialize_row
from .utils import compact_text

logger = logging.getLogger(__name__)

MAX_PROGRAMMES = 50
CMM_HISTORY_LIMIT = 500
CMM_STATUSES = ("PENDING", "IN_PROGRESS", "COMPLETED")
OPEN_CMM_STATUSES = ("PENDING", "IN_PROGRESS")

_JOB_COLUMNS = """
    j.cmm_job_id, j.process_sheet_no, j.part_no, j.part_description,
    j.technician_pic_id, COALESCE(pic.name, '') AS technician_name,
    j.status, j.jig_requirements, j.jigs_ready, j.jigs_ready_at,
    j.programme_count, j.created_at, j.updated_at, j.started_at,
    j.overall_completed_at, j.completed_by
"""

# Programme queue, in the same work order as QA Review.
PROGRAMME_QUEUE_SQL = """
SELECT process_sheet_no, queue_order
FROM public.planner_first_article_new_part
WHERE queue_order IS NOT NULL
ORDER BY queue_order, process_sheet_no
"""

# Open jobs only. Completed rows stay out of this query.
CMM_QUEUE_SQL = f"""
SELECT {_JOB_COLUMNS},
       (
           SELECT COUNT(*)
           FROM public.planner_cmm_subtask s
           WHERE s.cmm_job_id = j.cmm_job_id
       ) AS programme_total,
       (
           SELECT COUNT(*)
           FROM public.planner_cmm_subtask s
           WHERE s.cmm_job_id = j.cmm_job_id
             AND s.completed_at IS NOT NULL
       ) AS programme_done
FROM public.planner_cmm_job j
LEFT JOIN public.planner_first_article_pic pic
    ON pic.pic_id = j.technician_pic_id
WHERE j.status IN ('PENDING', 'IN_PROGRESS')
ORDER BY j.created_at, j.cmm_job_id
"""

# Completed jobs only. Do not join NEW parts or the active queue.
CMM_HISTORY_SQL = f"""
SELECT {_JOB_COLUMNS},
       EXTRACT(EPOCH FROM (
           j.overall_completed_at - COALESCE(j.started_at, j.created_at)
       )) AS duration_seconds
FROM public.planner_cmm_job j
LEFT JOIN public.planner_first_article_pic pic
    ON pic.pic_id = j.technician_pic_id
WHERE j.status = 'COMPLETED'
ORDER BY j.overall_completed_at DESC, j.cmm_job_id DESC
LIMIT %s
"""

CMM_METRICS_SQL = """
SELECT
    COUNT(*) FILTER (
        WHERE (overall_completed_at AT TIME ZONE 'Asia/Singapore')::date
            = (NOW() AT TIME ZONE 'Asia/Singapore')::date
    ) AS completed_today,
    COUNT(*) AS completed_count,
    AVG(EXTRACT(EPOCH FROM (
        overall_completed_at - COALESCE(started_at, created_at)
    ))) AS average_seconds
FROM public.planner_cmm_job
WHERE status = 'COMPLETED'
"""

CMM_JOB_SQL = f"""
SELECT {_JOB_COLUMNS}
FROM public.planner_cmm_job j
LEFT JOIN public.planner_first_article_pic pic
    ON pic.pic_id = j.technician_pic_id
WHERE j.cmm_job_id = %s
"""

CMM_OPEN_LOOKUP_SQL = """
SELECT cmm_job_id
FROM public.planner_cmm_job
WHERE status <> 'COMPLETED'
  AND LOWER(BTRIM(process_sheet_no)) = LOWER(BTRIM(%s))
ORDER BY cmm_job_id
LIMIT 1
"""

CMM_SUBTASK_SQL = """
SELECT subtask_id, cmm_job_id, programme_number, completed_at, completed_by, created_at
FROM public.planner_cmm_subtask
WHERE cmm_job_id = ANY(%s)
ORDER BY cmm_job_id, programme_number
"""

CMM_SCHEMA_SQL = (
    """
    CREATE TABLE IF NOT EXISTS public.planner_cmm_job (
        cmm_job_id            BIGSERIAL    PRIMARY KEY,
        process_sheet_no      TEXT         NOT NULL,
        part_no               TEXT         NOT NULL DEFAULT '',
        part_description      TEXT         NOT NULL DEFAULT '',
        technician_pic_id     BIGINT,
        status                TEXT         NOT NULL DEFAULT 'PENDING',
        jig_requirements      TEXT         NOT NULL DEFAULT '',
        jigs_ready            BOOLEAN      NOT NULL DEFAULT FALSE,
        jigs_ready_at         TIMESTAMPTZ,
        programme_count       INTEGER      NOT NULL DEFAULT 0,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        started_at            TIMESTAMPTZ,
        overall_completed_at  TIMESTAMPTZ,
        completed_by          TEXT         NOT NULL DEFAULT '',
        CONSTRAINT planner_cmm_job_status_chk
            CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT planner_cmm_job_programme_count_chk
            CHECK (programme_count >= 0),
        CONSTRAINT planner_cmm_job_complete_chk
            CHECK (
                (status = 'COMPLETED' AND overall_completed_at IS NOT NULL)
                OR (status <> 'COMPLETED' AND overall_completed_at IS NULL)
            )
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cmm_job_open_ps
        ON public.planner_cmm_job (LOWER(BTRIM(process_sheet_no)))
        WHERE status <> 'COMPLETED'
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cmm_job_queue
        ON public.planner_cmm_job (created_at, cmm_job_id)
        WHERE status IN ('PENDING', 'IN_PROGRESS')
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cmm_job_history
        ON public.planner_cmm_job (overall_completed_at DESC, cmm_job_id)
        WHERE status = 'COMPLETED'
    """,
    """
    CREATE TABLE IF NOT EXISTS public.planner_cmm_subtask (
        subtask_id        BIGSERIAL    PRIMARY KEY,
        cmm_job_id        BIGINT       NOT NULL
            REFERENCES public.planner_cmm_job (cmm_job_id) ON DELETE CASCADE,
        programme_number  INTEGER      NOT NULL,
        completed_at      TIMESTAMPTZ,
        completed_by      TEXT         NOT NULL DEFAULT '',
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT planner_cmm_subtask_number_chk
            CHECK (programme_number > 0),
        CONSTRAINT planner_cmm_subtask_job_number_uniq
            UNIQUE (cmm_job_id, programme_number)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS public.planner_cmm_event (
        event_id     BIGSERIAL    PRIMARY KEY,
        cmm_job_id   BIGINT       NOT NULL
            REFERENCES public.planner_cmm_job (cmm_job_id) ON DELETE CASCADE,
        subtask_id   BIGINT
            REFERENCES public.planner_cmm_subtask (subtask_id) ON DELETE SET NULL,
        event_type   TEXT         NOT NULL,
        payload      JSONB        NOT NULL DEFAULT '{}',
        actor        TEXT         NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cmm_event_job_at
        ON public.planner_cmm_event (cmm_job_id, created_at DESC)
    """,
)

_schema_ready = False
_schema_lock = threading.Lock()


class CmmError(Exception):
    def __init__(self, message: str, status: int = 400, **extra: Any):
        super().__init__(message)
        self.status = status
        self.extra = extra


def ensure_cmm_schema(con) -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        con.execute("SET LOCAL lock_timeout = '5s'")
        for statement in CMM_SCHEMA_SQL:
            con.execute(statement)
        _schema_ready = True


def parse_programme_count(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        raise CmmError("Number of programmes must be a whole number from 0 to 50.")
    if isinstance(value, float):
        if not value.is_integer():
            raise CmmError("Number of programmes must be a whole number from 0 to 50.")
        value = int(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text.isdigit():
            raise CmmError("Number of programmes must be a whole number from 0 to 50.")
        value = int(text)
    if not isinstance(value, int) or isinstance(value, bool):
        raise CmmError("Number of programmes must be a whole number from 0 to 50.")
    if value < 0 or value > MAX_PROGRAMMES:
        raise CmmError("Number of programmes must be a whole number from 0 to 50.")
    return value


def parse_override(value: Any) -> bool:
    if value is None or value is False:
        return False
    if value is True:
        return True
    text = compact_text(value).lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"", "0", "false", "no", "off"}:
        return False
    raise CmmError("override must be a boolean.")


def plan_programme_change(existing: list[dict[str, Any]], count: int) -> dict[str, list[int]]:
    """Return programme numbers to add and sub-task ids that can be removed."""
    by_number: dict[int, dict[str, Any]] = {}
    for row in existing:
        by_number[int(row["programme_number"])] = row
    blocked = sorted(
        number
        for number, row in by_number.items()
        if number > count and row.get("completed_at")
    )
    if blocked:
        raise CmmError(
            "Completed programmes stay on the job. Lower the count only for programmes that are still open.",
            409,
        )
    delete_ids = [
        int(row["subtask_id"])
        for number, row in by_number.items()
        if number > count and not row.get("completed_at")
    ]
    add_numbers = [number for number in range(1, count + 1) if number not in by_number]
    return {"add_numbers": add_numbers, "delete_ids": delete_ids}


def completion_block_reason(subtasks: list[dict[str, Any]], *, override: bool) -> str | None:
    if not subtasks:
        return "Generate at least one programme before marking the process sheet complete."
    open_count = sum(1 for row in subtasks if not row.get("completed_at"))
    if open_count and not override:
        noun = "programme is" if open_count == 1 else "programmes are"
        return (
            f"{open_count} {noun} still open. Tick them, or complete with an override."
        )
    return None


def subtask_complete_error(*, job_status: str, completed_at: Any, requested: bool) -> str | None:
    if compact_text(job_status).upper() == "COMPLETED":
        return "This process sheet is already complete."
    if not requested:
        return "Completed programmes stay locked."
    if completed_at:
        return "This programme is already complete."
    return None


def _sheet_key(value: Any) -> str:
    return compact_text(value).upper()


def sheets_missing_from_cmm(
    programme_sheets: list[dict[str, Any]],
    open_jobs: list[dict[str, Any]],
    completed_keys: set[str],
) -> list[dict[str, Any]]:
    """Programme-queue sheets that still need an open CMM job.

    A sheet that already has an open job, or whose latest CMM job is
    complete, is left alone.
    """
    open_keys = {_sheet_key(job.get("process_sheet_no")) for job in open_jobs}
    missing: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sheet in programme_sheets or []:
        key = _sheet_key(sheet.get("process_sheet_no"))
        if not key or key in seen or key in open_keys or key in completed_keys:
            continue
        seen.add(key)
        missing.append(sheet)
    return missing


def order_open_cmm_jobs(
    programme_sheets: list[dict[str, Any]],
    open_jobs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Open CMM jobs that are still in the programme queue, in that order.

    A sheet removed from the programme queue leaves this list. Its CMM row
    stays, so putting the sheet back keeps programmes and jig notes.
    """
    by_key: dict[str, dict[str, Any]] = {}
    for job in open_jobs or []:
        key = _sheet_key(job.get("process_sheet_no"))
        if key and key not in by_key:
            by_key[key] = job
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sheet in programme_sheets or []:
        key = _sheet_key(sheet.get("process_sheet_no"))
        job = by_key.get(key)
        if not key or not job or key in seen:
            continue
        seen.add(key)
        placed = dict(job)
        order = sheet.get("queue_order")
        try:
            placed["queue_order"] = int(order) if order not in (None, "") else None
        except (TypeError, ValueError):
            placed["queue_order"] = None
        ordered.append(placed)
    return ordered


def only_open_jobs(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [job for job in jobs if job.get("status") in OPEN_CMM_STATUSES]


def only_completed_jobs(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [job for job in jobs if job.get("status") == "COMPLETED"]


def _rollback_to(con, savepoint: str) -> None:
    try:
        con.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
    except Exception:
        logger.exception("cmm savepoint rollback failed")


def _programme_sheets(con) -> list[dict[str, Any]]:
    con.execute("SAVEPOINT cmm_programme_queue")
    try:
        fetched = rows(con.execute(PROGRAMME_QUEUE_SQL))
    except Exception:
        logger.exception("cmm programme queue lookup failed")
        _rollback_to(con, "cmm_programme_queue")
        return []
    con.execute("RELEASE SAVEPOINT cmm_programme_queue")
    return fetched or []


def _completed_sheet_keys(con) -> set[str]:
    fetched = rows(
        con.execute(
            """
            SELECT LOWER(BTRIM(process_sheet_no)) AS ps_key
            FROM public.planner_cmm_job
            WHERE status = 'COMPLETED'
            """
        )
    )
    return {compact_text(row.get("ps_key")).upper() for row in fetched if row.get("ps_key")}


def _part_details(con, process_sheets: list[str]) -> dict[str, dict[str, str]]:
    wanted = sorted({_sheet_key(sheet) for sheet in process_sheets if _sheet_key(sheet)})
    if not wanted:
        return {}
    details: dict[str, dict[str, str]] = {}
    con.execute("SAVEPOINT cmm_part_lookup")
    try:
        cached = rows(
            con.execute(
                """
                SELECT
                    UPPER(TRIM(split_part(ps_id, '::', 1))) AS ps_key,
                    MAX(part_no) AS part_no,
                    MAX(description) AS part_description
                FROM pp_vouchers_cache
                WHERE UPPER(TRIM(split_part(ps_id, '::', 1))) = ANY(%s)
                GROUP BY UPPER(TRIM(split_part(ps_id, '::', 1)))
                """,
                (wanted,),
            )
        )
        for row in cached or []:
            key = _sheet_key(row.get("ps_key"))
            if not key:
                continue
            details[key] = {
                "part_no": compact_text(row.get("part_no"))[:80],
                "part_description": compact_text(row.get("part_description"))[:240],
            }
        missing = [key for key in wanted if not details.get(key, {}).get("part_no")]
        if missing:
            info = rows(
                con.execute(
                    """
                    SELECT
                        UPPER(TRIM(process_sheet_no)) AS ps_key,
                        MAX(inventory_code) AS part_no
                    FROM mfg_process_sheet_info
                    WHERE UPPER(TRIM(process_sheet_no)) = ANY(%s)
                    GROUP BY UPPER(TRIM(process_sheet_no))
                    """,
                    (missing,),
                )
            )
            for row in info or []:
                key = _sheet_key(row.get("ps_key"))
                part_no = compact_text(row.get("part_no"))[:80]
                if not key or not part_no:
                    continue
                current = details.setdefault(key, {"part_no": "", "part_description": ""})
                if not current["part_no"]:
                    current["part_no"] = part_no
        codes = sorted({
            item["part_no"]
            for item in details.values()
            if item.get("part_no") and not item.get("part_description")
        })
        if codes:
            described = rows(
                con.execute(
                    """
                    SELECT inventory_code, main_desc
                    FROM part_desc
                    WHERE inventory_code = ANY(%s)
                    """,
                    (codes,),
                )
            )
            by_code = {
                compact_text(row.get("inventory_code")): compact_text(row.get("main_desc"))[:240]
                for row in described or []
                if compact_text(row.get("inventory_code"))
            }
            for item in details.values():
                if not item.get("part_description"):
                    item["part_description"] = by_code.get(item.get("part_no") or "", "")
    except Exception:
        logger.exception("cmm part lookup failed")
        _rollback_to(con, "cmm_part_lookup")
        return {}
    con.execute("RELEASE SAVEPOINT cmm_part_lookup")
    return details


def _open_missing_programme_jobs(con, sheets: list[dict[str, Any]]) -> None:
    if not sheets:
        return
    open_rows = rows(con.execute(CMM_QUEUE_SQL))
    missing = sheets_missing_from_cmm(sheets, open_rows, _completed_sheet_keys(con))
    if not missing:
        return
    details = _part_details(con, [sheet.get("process_sheet_no") for sheet in missing])
    for sheet in missing:
        process_sheet_no = compact_text(sheet.get("process_sheet_no"))
        if not process_sheet_no:
            continue
        part = details.get(_sheet_key(process_sheet_no), {})
        con.execute("SAVEPOINT cmm_open_sheet")
        try:
            created = one(
                con.execute(
                    """
                    INSERT INTO public.planner_cmm_job (
                        process_sheet_no, part_no, part_description, status
                    )
                    VALUES (%s, %s, %s, 'PENDING')
                    RETURNING cmm_job_id
                    """,
                    (
                        process_sheet_no,
                        part.get("part_no") or "",
                        part.get("part_description") or "",
                    ),
                )
            )
            _event(
                con,
                int(created["cmm_job_id"]),
                "job_created",
                {"process_sheet_no": process_sheet_no, "source": "programme_queue"},
                "",
            )
            con.execute("RELEASE SAVEPOINT cmm_open_sheet")
        except UniqueViolation:
            _rollback_to(con, "cmm_open_sheet")


def list_cmm_queue() -> list[dict[str, Any]]:
    with planner_db() as con:
        _prepare(con)
        sheets = _programme_sheets(con)
        _open_missing_programme_jobs(con, sheets)
        fetched = rows(con.execute(CMM_QUEUE_SQL))
        jobs = only_open_jobs([_present_job(row) for row in fetched])
    return order_open_cmm_jobs(sheets, jobs)


def list_cmm_history() -> list[dict[str, Any]]:
    with planner_db() as con:
        _prepare(con)
        fetched = rows(con.execute(CMM_HISTORY_SQL, (CMM_HISTORY_LIMIT,)))
        jobs = only_completed_jobs([_present_job(row) for row in fetched])
        grouped = _group_subtasks(con, [int(job["cmm_job_id"]) for job in jobs])
    for job in jobs:
        subtasks = grouped.get(int(job["cmm_job_id"]), [])
        job["subtasks"] = subtasks
        job["programme_total"] = len(subtasks)
        job["programme_done"] = sum(1 for item in subtasks if item.get("completed_at"))
    return jobs


def cmm_metrics() -> dict[str, Any]:
    with planner_db() as con:
        _prepare(con)
        row = one(con.execute(CMM_METRICS_SQL)) or {}
    average = row.get("average_seconds")
    return {
        "completed_today": int(row.get("completed_today") or 0),
        "completed_count": int(row.get("completed_count") or 0),
        "average_seconds": None if average is None else int(round(float(average))),
    }


def get_cmm_job(job_id: int) -> dict[str, Any]:
    with planner_db() as con:
        _prepare(con)
        return _job_detail(con, job_id)


def create_cmm_job(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CmmError("A JSON object is required.")
    process_sheet_no = compact_text(payload.get("process_sheet_no") or payload.get("pp_voucher_no"))
    if not process_sheet_no:
        raise CmmError("process_sheet_no is required.")
    if len(process_sheet_no) > 80:
        raise CmmError("process_sheet_no is too long.")
    part_no = compact_text(payload.get("part_no"))[:80]
    part_description = compact_text(payload.get("part_description"))[:240]
    actor = _actor(payload.get("actor"))
    try:
        with planner_db() as con:
            _prepare(con)
            technician_pic_id = _technician_pic_id(con, payload.get("technician_pic_id"))
            existing = one(con.execute(CMM_OPEN_LOOKUP_SQL, (process_sheet_no,)))
            if existing:
                raise CmmError(
                    "This process sheet is already in the CMM queue.",
                    409,
                    cmm_job_id=int(existing["cmm_job_id"]),
                )
            created = one(
                con.execute(
                    """
                    INSERT INTO public.planner_cmm_job (
                        process_sheet_no, part_no, part_description, technician_pic_id, status
                    )
                    VALUES (%s, %s, %s, %s, 'PENDING')
                    RETURNING cmm_job_id
                    """,
                    (process_sheet_no, part_no, part_description, technician_pic_id),
                )
            )
            job_id = int(created["cmm_job_id"])
            _event(
                con,
                job_id,
                "job_created",
                {"process_sheet_no": process_sheet_no},
                actor,
            )
            return _job_detail(con, job_id)
    except UniqueViolation:
        raise CmmError("This process sheet is already in the CMM queue.", 409) from None


def set_cmm_programmes(job_id: int, count: int, actor: str = "") -> dict[str, Any]:
    count = parse_programme_count(count)
    actor_text = _actor(actor)
    with planner_db() as con:
        _prepare(con)
        _lock_open_job(con, job_id)
        existing = _subtask_rows(con, job_id)
        plan = plan_programme_change(existing, count)
        for subtask_id in plan["delete_ids"]:
            con.execute(
                """
                DELETE FROM public.planner_cmm_subtask
                WHERE subtask_id = %s
                  AND cmm_job_id = %s
                  AND completed_at IS NULL
                """,
                (subtask_id, job_id),
            )
        for number in plan["add_numbers"]:
            con.execute(
                """
                INSERT INTO public.planner_cmm_subtask (cmm_job_id, programme_number)
                VALUES (%s, %s)
                """,
                (job_id, number),
            )
        con.execute(
            """
            UPDATE public.planner_cmm_job
            SET programme_count = (
                    SELECT COUNT(*)
                    FROM public.planner_cmm_subtask
                    WHERE cmm_job_id = %s
                ),
                status = CASE
                    WHEN (
                        SELECT COUNT(*)
                        FROM public.planner_cmm_subtask
                        WHERE cmm_job_id = %s
                    ) > 0 THEN 'IN_PROGRESS'
                    ELSE status
                END,
                started_at = CASE
                    WHEN started_at IS NULL
                     AND (
                        SELECT COUNT(*)
                        FROM public.planner_cmm_subtask
                        WHERE cmm_job_id = %s
                     ) > 0 THEN NOW()
                    ELSE started_at
                END,
                updated_at = NOW()
            WHERE cmm_job_id = %s
            """,
            (job_id, job_id, job_id, job_id),
        )
        _event(
            con,
            job_id,
            "programmes_set",
            {"count": count, "added": plan["add_numbers"], "removed": plan["delete_ids"]},
            actor_text,
        )
        return _job_detail(con, job_id)


def complete_cmm_subtask(job_id: int, subtask_id: int, actor: str = "") -> dict[str, Any]:
    actor_text = _actor(actor)
    with planner_db() as con:
        _prepare(con)
        job = _lock_open_job(con, job_id)
        subtask = one(
            con.execute(
                """
                SELECT subtask_id, programme_number, completed_at
                FROM public.planner_cmm_subtask
                WHERE subtask_id = %s AND cmm_job_id = %s
                FOR UPDATE
                """,
                (subtask_id, job_id),
            )
        )
        if not subtask:
            raise CmmError("Programme not found.", 404)
        reason = subtask_complete_error(
            job_status=job["status"],
            completed_at=subtask.get("completed_at"),
            requested=True,
        )
        if reason:
            raise CmmError(reason, 409)
        con.execute(
            """
            UPDATE public.planner_cmm_subtask
            SET completed_at = NOW(),
                completed_by = %s
            WHERE subtask_id = %s
              AND cmm_job_id = %s
              AND completed_at IS NULL
            """,
            (actor_text, subtask_id, job_id),
        )
        con.execute(
            """
            UPDATE public.planner_cmm_job
            SET updated_at = NOW()
            WHERE cmm_job_id = %s
            """,
            (job_id,),
        )
        _event(
            con,
            job_id,
            "subtask_completed",
            {"programme_number": int(subtask["programme_number"])},
            actor_text,
            subtask_id=subtask_id,
        )
        return _job_detail(con, job_id)


def update_cmm_jigs(
    job_id: int,
    *,
    jig_requirements: Any,
    jigs_ready: Any,
    actor: str = "",
) -> dict[str, Any]:
    if not isinstance(jig_requirements, str):
        raise CmmError("jig_requirements must be text.")
    if len(jig_requirements) > 4000:
        raise CmmError("jig_requirements must be 4000 characters or fewer.")
    ready = _parse_bool(jigs_ready, field="jigs_ready")
    text = jig_requirements.strip()
    actor_text = _actor(actor)
    with planner_db() as con:
        _prepare(con)
        _lock_open_job(con, job_id)
        con.execute(
            """
            UPDATE public.planner_cmm_job
            SET jig_requirements = %s,
                jigs_ready = %s,
                jigs_ready_at = CASE
                    WHEN %s AND NOT jigs_ready THEN NOW()
                    WHEN %s AND jigs_ready THEN jigs_ready_at
                    ELSE NULL
                END,
                updated_at = NOW()
            WHERE cmm_job_id = %s
            """,
            (text, ready, ready, ready, job_id),
        )
        _event(
            con,
            job_id,
            "jigs_updated",
            {"jigs_ready": ready, "jig_requirements": text},
            actor_text,
        )
        return _job_detail(con, job_id)


def complete_cmm_job(job_id: int, *, override: bool = False, actor: str = "") -> dict[str, Any]:
    actor_text = _actor(actor)
    with planner_db() as con:
        _prepare(con)
        job = _lock_job(con, job_id)
        if job["status"] == "COMPLETED":
            raise CmmError("This process sheet is already complete.", 409)
        subtasks = _subtask_rows(con, job_id)
        reason = completion_block_reason(subtasks, override=bool(override))
        if reason:
            raise CmmError(reason, 409)
        con.execute(
            """
            UPDATE public.planner_cmm_job
            SET status = 'COMPLETED',
                overall_completed_at = NOW(),
                completed_by = %s,
                updated_at = NOW()
            WHERE cmm_job_id = %s
              AND status <> 'COMPLETED'
            """,
            (actor_text, job_id),
        )
        _event(
            con,
            job_id,
            "job_completed",
            {"override": bool(override)},
            actor_text,
        )
        return _job_detail(con, job_id)


def _prepare(con) -> None:
    from .first_article_service import _ensure_tables

    _ensure_tables(con)
    ensure_cmm_schema(con)


def _actor(value: Any) -> str:
    return compact_text(value)[:80]


def _parse_bool(value: Any, *, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value in (0, 1):
            return bool(value)
        raise CmmError(f"{field} must be a boolean.")
    text = compact_text(value).lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"", "0", "false", "no", "off"}:
        return False
    raise CmmError(f"{field} must be a boolean.")


def _technician_pic_id(con, value: Any) -> int | None:
    if value is None or value is False or compact_text(value) == "":
        return None
    if isinstance(value, bool):
        raise CmmError("technician_pic_id must be an integer.")
    text = compact_text(value)
    if not text.isdigit():
        raise CmmError("technician_pic_id must be an integer.")
    pic_id = int(text)
    found = one(
        con.execute(
            """
            SELECT pic_id
            FROM public.planner_first_article_pic
            WHERE pic_id = %s
            """,
            (pic_id,),
        )
    )
    if not found:
        raise CmmError("Technician was not found.")
    return pic_id


def _lock_job(con, job_id: int) -> dict[str, Any]:
    row = one(
        con.execute(
            """
            SELECT cmm_job_id, status
            FROM public.planner_cmm_job
            WHERE cmm_job_id = %s
            FOR UPDATE
            """,
            (job_id,),
        )
    )
    if not row:
        raise CmmError("CMM job not found.", 404)
    return row


def _lock_open_job(con, job_id: int) -> dict[str, Any]:
    row = _lock_job(con, job_id)
    if row["status"] == "COMPLETED":
        raise CmmError("This process sheet is already complete.", 409)
    return row


def _subtask_rows(con, job_id: int) -> list[dict[str, Any]]:
    return rows(
        con.execute(
            """
            SELECT subtask_id, cmm_job_id, programme_number, completed_at, completed_by, created_at
            FROM public.planner_cmm_subtask
            WHERE cmm_job_id = %s
            ORDER BY programme_number
            """,
            (job_id,),
        )
    )


def _event(
    con,
    job_id: int,
    event_type: str,
    payload: dict[str, Any],
    actor: str = "",
    subtask_id: int | None = None,
) -> None:
    con.execute(
        """
        INSERT INTO public.planner_cmm_event (
            cmm_job_id, subtask_id, event_type, payload, actor
        )
        VALUES (%s, %s, %s, %s, %s)
        """,
        (job_id, subtask_id, event_type, Json(payload), actor),
    )


def _job_detail(con, job_id: int) -> dict[str, Any]:
    row = one(con.execute(CMM_JOB_SQL, (job_id,)))
    if not row:
        raise CmmError("CMM job not found.", 404)
    subtasks = _group_subtasks(con, [job_id]).get(job_id, [])
    return _present_job(row, subtasks)


def _group_subtasks(con, job_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
    if not job_ids:
        return {}
    fetched = rows(con.execute(CMM_SUBTASK_SQL, (job_ids,)))
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in fetched:
        item = _present_subtask(row)
        grouped.setdefault(int(item["cmm_job_id"]), []).append(item)
    return grouped


def _present_job(row: dict[str, Any], subtasks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    job = serialize_row(dict(row))
    for key in (
        "cmm_job_id",
        "technician_pic_id",
        "programme_count",
        "programme_total",
        "programme_done",
    ):
        if job.get(key) is not None:
            job[key] = int(job[key])
    if job.get("duration_seconds") is not None:
        job["duration_seconds"] = int(round(float(job["duration_seconds"])))
    job["jigs_ready"] = bool(job.get("jigs_ready"))
    job["technician_name"] = compact_text(job.get("technician_name"))
    job["jig_requirements"] = job.get("jig_requirements") or ""
    job["completed_by"] = job.get("completed_by") or ""
    if subtasks is not None:
        job["subtasks"] = subtasks
        job["programme_total"] = len(subtasks)
        job["programme_done"] = sum(1 for item in subtasks if item.get("completed_at"))
        job["programme_count"] = len(subtasks)
    return job


def _present_subtask(row: dict[str, Any]) -> dict[str, Any]:
    item = serialize_row(dict(row))
    item["subtask_id"] = int(item["subtask_id"])
    item["cmm_job_id"] = int(item["cmm_job_id"])
    item["programme_number"] = int(item["programme_number"])
    item["completed_by"] = item.get("completed_by") or ""
    return item
