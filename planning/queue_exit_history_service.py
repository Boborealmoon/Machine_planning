"""Historical log when scheduled ops naturally leave machine lane queues."""
from __future__ import annotations

import logging
from typing import Any

from .blocks import _row_planner_ps_identity
from .helpers import one, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

_SCHEMA_READY = False

_BLOCK_EXIT_SQL = """
SELECT
    b.block_id,
    b.machine_id,
    b.queue_position,
    b.scheduled_qty,
    b.execution_status,
    b.group_id,
    o.source_ps_id AS planner_ps_id,
    o.job_no,
    o.source_op_no,
    o.source_op_seq_id,
    m.machine_no,
    os_row.sequence_no,
    seq.op_seq_id,
    seq.op_type,
    seq.source_stage_no AS stage_no,
    COALESCE(NULLIF(TRIM(bos.stage_desc), ''), NULLIF(TRIM(seq.op_type), ''), '') AS stage_desc,
    bv.inventory_code AS part_no,
    bv.bom_code,
    qs.good_qty AS qs_good_qty,
    co.cycle_id,
    co.pp_partial_no AS mpp_pp_partial_no
FROM planner_run_block b
JOIN planner_operation o ON o.operation_id = b.operation_id
JOIN planner_machines m ON m.machine_id = b.machine_id
LEFT JOIN planner_operation_sequence os_row ON os_row.block_id = b.block_id
LEFT JOIN planner_operation_seq seq ON seq.op_seq_id = o.source_op_seq_id
LEFT JOIN planner_bom_variation bv ON bv.bom_id = seq.bom_id
LEFT JOIN bom_op_stage bos
       ON bos.inventory_code = bv.inventory_code
      AND bos.bom_code = bv.bom_code
      AND bos.stage_no = seq.source_stage_no
LEFT JOIN planner_machine_queue_state qs ON qs.block_id = b.block_id
LEFT JOIN planner_mpp_cycle_op co ON co.block_id = b.block_id
WHERE b.block_id = %s
"""


def ensure_queue_exit_history_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_queue_exit_history (
            exit_id           BIGSERIAL    PRIMARY KEY,
            block_id          BIGINT       NOT NULL,
            machine_id        BIGINT       NOT NULL,
            machine_no        TEXT         NOT NULL DEFAULT '',
            queue_position    NUMERIC,
            sequence_no       INTEGER,
            exit_reason       TEXT         NOT NULL DEFAULT '',
            exit_kind         TEXT         NOT NULL DEFAULT 'STANDARD',
            source_ps_id      TEXT         NOT NULL DEFAULT '',
            planner_ps_id     TEXT         NOT NULL DEFAULT '',
            pp_partial_no     INTEGER      NOT NULL DEFAULT 1,
            source_op_no      TEXT         NOT NULL DEFAULT '',
            op_seq_id         BIGINT,
            part_no           TEXT         NOT NULL DEFAULT '',
            bom_code          TEXT         NOT NULL DEFAULT '',
            stage_no          INTEGER      NOT NULL DEFAULT 0,
            stage_desc        TEXT         NOT NULL DEFAULT '',
            op_type           TEXT         NOT NULL DEFAULT '',
            scheduled_qty     NUMERIC      NOT NULL DEFAULT 0,
            good_qty          NUMERIC      NOT NULL DEFAULT 0,
            reject_qty        NUMERIC      NOT NULL DEFAULT 0,
            group_id          BIGINT,
            cycle_id          BIGINT,
            exited_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_queue_exit_part_stage_machine
            ON planner_queue_exit_history (part_no, stage_no, machine_no)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_queue_exit_exited_at
            ON planner_queue_exit_history (exited_at DESC)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_queue_exit_machine_no
            ON planner_queue_exit_history (machine_no)
        """
    )
    _SCHEMA_READY = True


def _qty_totals_for_block(con, block_id: int) -> tuple[float, float]:
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
    return float(totals.get("good_qty") or 0), float(totals.get("reject_qty") or 0)


def _block_exit_context(con, block_id: int) -> dict[str, Any] | None:
    return one(con.execute(_BLOCK_EXIT_SQL, (int(block_id),)))


def record_queue_exit_for_block(
    con,
    block_id: int,
    *,
    reason: str = "AUTO_DONE",
    exit_kind: str = "STANDARD",
) -> bool:
    """Persist one queue-exit event. Call before block removal/deactivation."""
    ensure_queue_exit_history_schema(con)
    ctx = _block_exit_context(con, int(block_id))
    if not ctx:
        return False

    source_ps_id, pp_partial_no = _row_planner_ps_identity(ctx)
    if int(ctx.get("mpp_pp_partial_no") or 0) > 0:
        pp_partial_no = int(ctx["mpp_pp_partial_no"])

    good_qty, reject_qty = _qty_totals_for_block(con, int(block_id))
    if good_qty <= 0:
        good_qty = float(
            ctx.get("qs_good_qty")
            or ctx.get("scheduled_qty")
            or 0
        )
    scheduled_qty = float(ctx.get("scheduled_qty") or 0)
    if good_qty <= 0 and scheduled_qty > 0:
        good_qty = scheduled_qty

    con.execute(
        """
        INSERT INTO planner_queue_exit_history (
            block_id, machine_id, machine_no, queue_position, sequence_no,
            exit_reason, exit_kind,
            source_ps_id, planner_ps_id, pp_partial_no, source_op_no, op_seq_id,
            part_no, bom_code, stage_no, stage_desc, op_type,
            scheduled_qty, good_qty, reject_qty, group_id, cycle_id, exited_at
        ) VALUES (
            %s, %s, %s, %s, %s,
            %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s, NOW()
        )
        """,
        (
            int(ctx["block_id"]),
            int(ctx["machine_id"]),
            compact_text(ctx.get("machine_no")),
            ctx.get("queue_position"),
            int(ctx.get("sequence_no") or 0) or None,
            compact_text(reason),
            compact_text(exit_kind) or "STANDARD",
            compact_text(source_ps_id),
            compact_text(ctx.get("planner_ps_id") or ctx.get("job_no")),
            int(pp_partial_no or 1),
            compact_text(ctx.get("source_op_no")),
            int(ctx.get("op_seq_id") or ctx.get("source_op_seq_id") or 0) or None,
            compact_text(ctx.get("part_no")),
            compact_text(ctx.get("bom_code")),
            int(ctx.get("stage_no") or 0),
            compact_text(ctx.get("stage_desc") or ctx.get("op_type")),
            compact_text(ctx.get("op_type")),
            scheduled_qty,
            good_qty,
            reject_qty,
            int(ctx.get("group_id") or 0) or None,
            int(ctx.get("cycle_id") or 0) or None,
        ),
    )
    logger.debug(
        "queue exit recorded block=%s part=%s stage=%s machine=%s qty=%s reason=%s",
        block_id,
        ctx.get("part_no"),
        ctx.get("stage_no"),
        ctx.get("machine_no"),
        good_qty,
        reason,
    )
    return True


def fetch_queue_exit_history(
    con,
    *,
    part_no: str = "",
    bom_code: str = "",
    machine_no: str = "",
    stage_no: int = 0,
    source_ps_id: str = "",
    from_date: str = "",
    to_date: str = "",
    limit: int = 500,
) -> list[dict[str, Any]]:
    ensure_queue_exit_history_schema(con)
    clauses = ["1=1"]
    params: list[Any] = []

    part_no = compact_text(part_no)
    if part_no:
        clauses.append("part_no ILIKE %s")
        params.append(f"%{part_no}%")
    bom_code = compact_text(bom_code)
    if bom_code:
        clauses.append("bom_code ILIKE %s")
        params.append(f"%{bom_code}%")
    machine_no = compact_text(machine_no)
    if machine_no:
        clauses.append("machine_no ILIKE %s")
        params.append(f"%{machine_no}%")
    if int(stage_no or 0) > 0:
        clauses.append("stage_no = %s")
        params.append(int(stage_no))
    source_ps_id = compact_text(source_ps_id)
    if source_ps_id:
        clauses.append("(source_ps_id = %s OR planner_ps_id ILIKE %s)")
        params.extend([source_ps_id, f"%{source_ps_id}%"])
    from_date = compact_text(from_date)
    if from_date:
        clauses.append("exited_at >= %s::timestamptz")
        params.append(from_date)
    to_date = compact_text(to_date)
    if to_date:
        clauses.append("exited_at < (%s::date + INTERVAL '1 day')")
        params.append(to_date)

    limit = max(1, min(int(limit or 500), 5000))
    params.append(limit)

    return rows(
        con.execute(
            f"""
            SELECT
                exit_id, block_id, machine_id, machine_no, queue_position, sequence_no,
                exit_reason, exit_kind,
                source_ps_id, planner_ps_id, pp_partial_no, source_op_no, op_seq_id,
                part_no, bom_code, stage_no, stage_desc, op_type,
                scheduled_qty, good_qty, reject_qty, group_id, cycle_id, exited_at
            FROM planner_queue_exit_history
            WHERE {' AND '.join(clauses)}
            ORDER BY exited_at DESC, exit_id DESC
            LIMIT %s
            """,
            tuple(params),
        )
    )


def fetch_queue_exit_summary(
    con,
    *,
    part_no: str = "",
    bom_code: str = "",
    machine_no: str = "",
    stage_no: int = 0,
    from_date: str = "",
    to_date: str = "",
    limit: int = 500,
) -> list[dict[str, Any]]:
    """Aggregate exit counts and quantities by part × stage × machine."""
    ensure_queue_exit_history_schema(con)
    clauses = ["1=1"]
    params: list[Any] = []

    part_no = compact_text(part_no)
    if part_no:
        clauses.append("part_no ILIKE %s")
        params.append(f"%{part_no}%")
    bom_code = compact_text(bom_code)
    if bom_code:
        clauses.append("bom_code ILIKE %s")
        params.append(f"%{bom_code}%")
    machine_no = compact_text(machine_no)
    if machine_no:
        clauses.append("machine_no ILIKE %s")
        params.append(f"%{machine_no}%")
    if int(stage_no or 0) > 0:
        clauses.append("stage_no = %s")
        params.append(int(stage_no))
    from_date = compact_text(from_date)
    if from_date:
        clauses.append("exited_at >= %s::timestamptz")
        params.append(from_date)
    to_date = compact_text(to_date)
    if to_date:
        clauses.append("exited_at < (%s::date + INTERVAL '1 day')")
        params.append(to_date)

    limit = max(1, min(int(limit or 500), 5000))
    params.append(limit)

    return rows(
        con.execute(
            f"""
            SELECT
                part_no,
                bom_code,
                stage_no,
                MAX(stage_desc) AS stage_desc,
                MAX(op_type) AS op_type,
                machine_no,
                COUNT(*)::INTEGER AS exit_count,
                COALESCE(SUM(good_qty), 0) AS total_good_qty,
                COALESCE(SUM(reject_qty), 0) AS total_reject_qty,
                COALESCE(SUM(scheduled_qty), 0) AS total_scheduled_qty,
                MAX(exited_at) AS last_exited_at,
                MIN(exited_at) AS first_exited_at
            FROM planner_queue_exit_history
            WHERE {' AND '.join(clauses)}
            GROUP BY part_no, bom_code, stage_no, machine_no
            ORDER BY last_exited_at DESC
            LIMIT %s
            """,
            tuple(params),
        )
    )
