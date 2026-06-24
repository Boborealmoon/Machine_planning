"""Preferred machine tracking — live planner sync + completion history."""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

from .helpers import one, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

_MACHINING_OP_RE = re.compile(r"^(Turning|Milling|Turnmill)\b", re.IGNORECASE)
_MACHINING_CATEGORIES = frozenset({"TURNING", "MILLING", "TURNMILL", "MPP", "PLACEHOLDER"})
_SCHEMA_READY = False

_ARCHIVE_SQL = """
WITH bom_base AS (
    SELECT
        bv.bom_id,
        bv.inventory_code AS part_no,
        bv.bom_code,
        bv.bom_desc,
        bv.is_default,
        bv.source_kind AS bom_source_kind
    FROM planner_bom_variation bv
),
steps AS (
    SELECT
        bb.part_no,
        bb.bom_code,
        bb.bom_id,
        bb.bom_desc,
        bb.is_default,
        bb.bom_source_kind,
        os.op_seq_id,
        os.seq_no,
        os.op_no,
        os.op_type,
        os.machine_category,
        COALESCE(NULLIF(TRIM(os.preferred_machine), ''), '') AS preferred_machine,
        os.source_stage_no,
        COALESCE(NULLIF(TRIM(bos.machine_no), ''), '') AS erp_machine_no,
        COALESCE(bos.stage_desc, '') AS erp_stage_desc
    FROM bom_base bb
    JOIN planner_operation_seq os ON os.bom_id = bb.bom_id
    LEFT JOIN bom_op_stage bos
        ON bos.inventory_code = bb.part_no
       AND bos.bom_code = bb.bom_code
       AND bos.stage_no = os.source_stage_no
),
part_desc_lookup AS (
    SELECT inventory_code, MAX(main_desc) AS main_desc
    FROM part_desc
    GROUP BY inventory_code
),
cache_desc AS (
    SELECT TRIM(part_no) AS part_no, MAX(description) AS part_desc
    FROM pp_vouchers_cache
    WHERE COALESCE(NULLIF(TRIM(part_no), ''), '') <> ''
    GROUP BY TRIM(part_no)
),
process_sheets AS (
    SELECT
        TRIM(c.part_no) AS part_no,
        TRIM(COALESCE(c.bom_code, '')) AS bom_code,
        array_agg(DISTINCT c.ps_id ORDER BY c.ps_id) AS ps_ids,
        COUNT(DISTINCT c.ps_id)::INT AS ps_count
    FROM pp_vouchers_cache c
    WHERE COALESCE(NULLIF(TRIM(c.part_no), ''), '') <> ''
      AND COALESCE(NULLIF(TRIM(c.ps_id), ''), '') <> ''
    GROUP BY TRIM(c.part_no), TRIM(COALESCE(c.bom_code, ''))
),
completion_history AS (
    SELECT
        c.op_seq_id,
        json_agg(
            json_build_object(
                'machine_no', c.machine_no,
                'good_qty', c.good_qty,
                'reject_qty', c.reject_qty,
                'completion_count', c.completion_count,
                'last_completed_at', c.last_completed_at,
                'last_source_ps_id', c.last_source_ps_id
            )
            ORDER BY c.last_completed_at DESC NULLS LAST, c.machine_no
        ) AS completions
    FROM planner_op_machine_completion c
    GROUP BY c.op_seq_id
)
SELECT
    s.part_no,
    COALESCE(pd.main_desc, cd.part_desc, '') AS part_desc,
    s.bom_code,
    MAX(s.bom_desc) AS bom_desc,
    BOOL_OR(s.is_default) AS is_default,
    MAX(s.bom_source_kind) AS bom_source_kind,
    json_agg(
        json_build_object(
            'op_seq_id', s.op_seq_id,
            'seq_no', s.seq_no,
            'op_no', s.op_no,
            'op_type', s.op_type,
            'machine_category', s.machine_category,
            'preferred_machine', s.preferred_machine,
            'erp_machine_no', s.erp_machine_no,
            'erp_stage_desc', s.erp_stage_desc,
            'completion_history', COALESCE(ch.completions, '[]'::json)
        )
        ORDER BY s.seq_no
    ) AS operations,
    COALESCE(ps.ps_ids, ARRAY[]::TEXT[]) AS process_sheets,
    COALESCE(ps.ps_count, 0) AS ps_count
FROM steps s
LEFT JOIN part_desc_lookup pd ON pd.inventory_code = s.part_no
LEFT JOIN cache_desc cd ON cd.part_no = s.part_no
LEFT JOIN process_sheets ps
    ON ps.part_no = s.part_no
   AND ps.bom_code = s.bom_code
LEFT JOIN completion_history ch ON ch.op_seq_id = s.op_seq_id
GROUP BY s.part_no, s.bom_code, pd.main_desc, cd.part_desc, ps.ps_ids, ps.ps_count
ORDER BY s.part_no, s.bom_code
"""


def ensure_preferred_machines_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_op_machine_completion (
            completion_id      BIGSERIAL    PRIMARY KEY,
            op_seq_id            BIGINT       NOT NULL,
            bom_id               BIGINT       NOT NULL,
            part_no              TEXT         NOT NULL DEFAULT '',
            bom_code             TEXT         NOT NULL DEFAULT '',
            op_no                TEXT         NOT NULL DEFAULT '',
            machine_no           TEXT         NOT NULL,
            good_qty             NUMERIC      NOT NULL DEFAULT 0,
            reject_qty           NUMERIC      NOT NULL DEFAULT 0,
            completion_count     INTEGER      NOT NULL DEFAULT 0,
            last_block_id        BIGINT,
            last_source_ps_id    TEXT         NOT NULL DEFAULT '',
            last_completed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (op_seq_id, machine_no)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_op_machine_completion_part_bom
            ON planner_op_machine_completion (part_no, bom_code)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_op_machine_completion_machine
            ON planner_op_machine_completion (machine_no)
        """
    )
    _SCHEMA_READY = True


def _is_machining_op(op: dict[str, Any]) -> bool:
    cat = compact_text(op.get("machine_category")).upper()
    if cat in _MACHINING_CATEGORIES:
        return True
    if compact_text(op.get("preferred_machine")):
        return True
    op_text = compact_text(op.get("op_type"))
    return bool(op_text and _MACHINING_OP_RE.match(op_text))


def _block_context(con, block_id: int) -> dict[str, Any] | None:
    return one(
        con.execute(
            """
            SELECT
                b.block_id,
                b.machine_id,
                b.scheduled_qty,
                b.execution_status,
                b.status,
                o.source_op_seq_id,
                o.source_op_no,
                o.source_ps_id,
                m.machine_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )


def _step_context(con, op_seq_id: int) -> dict[str, Any] | None:
    if int(op_seq_id or 0) <= 0:
        return None
    return one(
        con.execute(
            """
            SELECT
                os.op_seq_id,
                os.op_no,
                os.bom_id,
                bv.inventory_code AS part_no,
                bv.bom_code
            FROM planner_operation_seq os
            JOIN planner_bom_variation bv ON bv.bom_id = os.bom_id
            WHERE os.op_seq_id = %s
            """,
            (int(op_seq_id),),
        )
    )


def sync_preferred_machine_from_block(con, block_id: int, *, source: str = "PLANNER") -> bool:
    """Set planner_operation_seq.preferred_machine to the block's current machine."""
    ensure_preferred_machines_schema(con)
    block = _block_context(con, int(block_id))
    if not block:
        return False
    op_seq_id = int(block.get("source_op_seq_id") or 0)
    machine_no = compact_text(block.get("machine_no"))
    if op_seq_id <= 0 or not machine_no:
        return False
    con.execute(
        """
        UPDATE planner_operation_seq
        SET preferred_machine = %s
        WHERE op_seq_id = %s
          AND COALESCE(NULLIF(TRIM(preferred_machine), ''), '') IS DISTINCT FROM %s
        """,
        (machine_no, op_seq_id, machine_no),
    )
    logger.debug("preferred machine sync block=%s op_seq=%s machine=%s source=%s", block_id, op_seq_id, machine_no, source)
    return True


def sync_preferred_machines_for_blocks(con, block_ids: list[int] | set[int], *, source: str = "PLANNER") -> int:
    updated = 0
    for block_id in sorted({int(value) for value in (block_ids or []) if int(value or 0) > 0}):
        if sync_preferred_machine_from_block(con, block_id, source=source):
            updated += 1
    return updated


def record_completion_from_block(con, block_id: int) -> bool:
    """Persist completion history when a block finishes on a machine."""
    ensure_preferred_machines_schema(con)
    block = _block_context(con, int(block_id))
    if not block:
        return False

    status = compact_text(block.get("execution_status") or block.get("status")).upper()
    if status not in {"DONE", "COMPLETED", "C"}:
        return False

    op_seq_id = int(block.get("source_op_seq_id") or 0)
    machine_no = compact_text(block.get("machine_no"))
    if op_seq_id <= 0 or not machine_no:
        return False

    step = _step_context(con, op_seq_id) or {}
    totals = one(
        con.execute(
            """
            SELECT
                COALESCE(SUM(COALESCE(output_qty, 0) - COALESCE(reject_qty, 0)), 0) AS good_qty,
                COALESCE(SUM(COALESCE(reject_qty, 0)), 0) AS reject_qty
            FROM planner_production_actual
            WHERE block_id = %s
              AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
            """,
            (int(block_id),),
        )
    ) or {}
    good_qty = float(totals.get("good_qty") or block.get("scheduled_qty") or 0)
    reject_qty = float(totals.get("reject_qty") or 0)
    if good_qty <= 0 and reject_qty <= 0:
        good_qty = float(block.get("scheduled_qty") or 0)

    con.execute(
        """
        INSERT INTO planner_op_machine_completion (
            op_seq_id, bom_id, part_no, bom_code, op_no, machine_no,
            good_qty, reject_qty, completion_count,
            last_block_id, last_source_ps_id, last_completed_at, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1, %s, %s, NOW(), NOW())
        ON CONFLICT (op_seq_id, machine_no) DO UPDATE SET
            good_qty = planner_op_machine_completion.good_qty + EXCLUDED.good_qty,
            reject_qty = planner_op_machine_completion.reject_qty + EXCLUDED.reject_qty,
            completion_count = planner_op_machine_completion.completion_count + 1,
            last_block_id = EXCLUDED.last_block_id,
            last_source_ps_id = EXCLUDED.last_source_ps_id,
            last_completed_at = NOW(),
            updated_at = NOW()
        """,
        (
            op_seq_id,
            int(step.get("bom_id") or 0),
            compact_text(step.get("part_no")),
            compact_text(step.get("bom_code")),
            compact_text(step.get("op_no") or block.get("source_op_no")),
            machine_no,
            good_qty,
            reject_qty,
            int(block_id),
            compact_text(block.get("source_ps_id")),
        ),
    )
    return True


def reconcile_active_block_preferences(con) -> int:
    """Backfill current preferred_machine from active scheduled blocks (latest queue wins)."""
    ensure_preferred_machines_schema(con)
    active_rows = rows(
        con.execute(
            """
            SELECT DISTINCT ON (o.source_op_seq_id)
                o.source_op_seq_id AS op_seq_id,
                m.machine_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND COALESCE(o.source_op_seq_id, 0) > 0
              AND COALESCE(NULLIF(TRIM(m.machine_no), ''), '') <> ''
              AND UPPER(COALESCE(b.execution_status, b.status, '')) NOT IN ('DONE', 'COMPLETED', 'C')
            ORDER BY o.source_op_seq_id, b.queue_position DESC, b.block_id DESC
            """
        )
    )
    updated = 0
    for row in active_rows:
        op_seq_id = int(row.get("op_seq_id") or 0)
        machine_no = compact_text(row.get("machine_no"))
        if op_seq_id <= 0 or not machine_no:
            continue
        cur = con.execute(
            """
            UPDATE planner_operation_seq
            SET preferred_machine = %s
            WHERE op_seq_id = %s
              AND COALESCE(NULLIF(TRIM(preferred_machine), ''), '') IS DISTINCT FROM %s
            """,
            (machine_no, op_seq_id, machine_no),
        )
        if getattr(cur, "rowcount", 0):
            updated += int(cur.rowcount or 0)
    return updated


def _parse_json_list(raw: Any) -> list[dict[str, Any]]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [dict(item) for item in raw]
    import json

    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return [dict(item) for item in parsed] if isinstance(parsed, list) else []


def _parse_ps_list(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [compact_text(item) for item in raw if compact_text(item)]
    text = compact_text(raw)
    if not text:
        return []
    if text.startswith("{") and text.endswith("}"):
        inner = text[1:-1]
        return [compact_text(item.strip('"')) for item in inner.split(",") if compact_text(item.strip('"'))]
    return [text]


def _truncate_text(text: str, max_len: int) -> tuple[str, bool]:
    value = compact_text(text)
    if len(value) <= max_len:
        return value, False
    cut = value[: max_len - 1].rstrip(" ,;")
    return f"{cut}…", True


def _format_op_machine(op: dict[str, Any]) -> str:
    op_no = compact_text(op.get("op_no")) or str(op.get("seq_no") or "?")
    machine = compact_text(op.get("preferred_machine")) or "—"
    return f"{op_no}->{machine}"


def _format_completion_summary(op: dict[str, Any]) -> str:
    history = op.get("completion_history") or []
    if not isinstance(history, list):
        history = _parse_json_list(history)
    parts = []
    for item in history:
        machine = compact_text(item.get("machine_no"))
        if not machine:
            continue
        qty = float(item.get("good_qty") or 0)
        count = int(item.get("completion_count") or 0)
        if qty > 0:
            parts.append(f"{compact_text(op.get('op_no')) or '?'}@{machine}({qty:g})")
        elif count > 0:
            parts.append(f"{compact_text(op.get('op_no')) or '?'}@{machine}")
    return " | ".join(parts)


def serialize_archive_row(row: dict[str, Any]) -> dict[str, Any]:
    operations = _parse_json_list(row.get("operations"))
    machining_ops = [op for op in operations if _is_machining_op(op)]
    for op in machining_ops:
        op["completion_history"] = _parse_json_list(op.get("completion_history"))

    process_sheets = _parse_ps_list(row.get("process_sheets"))
    ps_joined = ", ".join(process_sheets)
    ps_truncated, ps_was_truncated = _truncate_text(ps_joined, 72)

    preferred_parts = [_format_op_machine(op) for op in machining_ops]
    preferred_summary = " | ".join(preferred_parts) if preferred_parts else "—"
    preferred_truncated, preferred_was_truncated = _truncate_text(preferred_summary, 96)

    history_parts = [_format_completion_summary(op) for op in machining_ops]
    history_parts = [part for part in history_parts if part]
    history_summary = " | ".join(history_parts) if history_parts else "—"
    history_truncated, history_was_truncated = _truncate_text(history_summary, 96)

    missing_count = sum(1 for op in machining_ops if not compact_text(op.get("preferred_machine")))
    erp_mismatch_count = sum(
        1
        for op in machining_ops
        if compact_text(op.get("preferred_machine"))
        and compact_text(op.get("erp_machine_no"))
        and compact_text(op.get("preferred_machine")) != compact_text(op.get("erp_machine_no"))
    )
    history_machine_count = len(
        {
            compact_text(item.get("machine_no"))
            for op in machining_ops
            for item in (op.get("completion_history") or [])
            if compact_text(item.get("machine_no"))
        }
    )

    unique_machines = sorted(
        {compact_text(op.get("preferred_machine")) for op in machining_ops if compact_text(op.get("preferred_machine"))}
    )

    return {
        "part_no": compact_text(row.get("part_no")),
        "part_desc": compact_text(row.get("part_desc")),
        "bom_code": compact_text(row.get("bom_code")),
        "bom_desc": compact_text(row.get("bom_desc")),
        "is_default": bool(row.get("is_default")),
        "bom_source_kind": compact_text(row.get("bom_source_kind")) or "ERP",
        "machining_op_count": len(machining_ops),
        "total_op_count": len(operations),
        "missing_preferred_count": missing_count,
        "erp_mismatch_count": erp_mismatch_count,
        "history_machine_count": history_machine_count,
        "unique_machines": unique_machines,
        "preferred_summary": preferred_summary,
        "preferred_summary_truncated": preferred_truncated,
        "preferred_summary_was_truncated": preferred_was_truncated,
        "history_summary": history_summary,
        "history_summary_truncated": history_truncated,
        "history_summary_was_truncated": history_was_truncated,
        "process_sheets": process_sheets,
        "process_sheets_text": ps_joined,
        "process_sheets_truncated": ps_truncated,
        "process_sheets_was_truncated": ps_was_truncated,
        "ps_count": int(row.get("ps_count") or len(process_sheets)),
        "operations": operations,
        "machining_ops": machining_ops,
    }


def fetch_preferred_machines_archive(con, *, reconcile: bool = False) -> list[dict[str, Any]]:
    ensure_preferred_machines_schema(con)
    if reconcile:
        reconcile_active_block_preferences(con)
    raw_rows = rows(con.execute(_ARCHIVE_SQL))
    return [serialize_archive_row(dict(row)) for row in raw_rows]
