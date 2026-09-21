"""Post-machining queue — synced staging (mfg_wo_status + pp_vouchers_cache) per PP partial."""

from __future__ import annotations

import threading
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from planning.erp_wo_merge import (
    FINISHING_STAGE_DESCS,
    finishing_final_inspection_sql_match,
    finishing_stage_bucket,
    finishing_stage_sql_match,
    is_finishing_stage_desc,
)
from planning.helpers import one, planner_try_savepoint, rows
from planning.process_sheets import format_planner_ps_id, parse_planner_ps_id
from planning.utils import compact_text, planner_wall_datetime_to_api, shipped_quantity_completed
from sync import _pp_ps_id_prefix_params, _pp_ps_id_prefix_sql

_TEMP_PS_PREFIX_LIKE = "[Temp]%"


def _finishing_ps_prefix_sql(column: str) -> str:
    return f"({_pp_ps_id_prefix_sql(column)} OR {column} LIKE %s)"


def _finishing_ps_prefix_params() -> tuple:
    return _pp_ps_id_prefix_params() + (_TEMP_PS_PREFIX_LIKE,)


def _open_execution_status_sql(column: str) -> str:
    """Open WO rows without wrapping the column in COALESCE (keeps partial indexes usable)."""
    return (
        f"{column} IS NOT NULL "
        f"AND {column} <> '' "
        f"AND {column} NOT IN ('C', 'Completed')"
    )


def _finishing_stage_eq_sql(column: str) -> str:
    """Index-friendly finishing predicate (mfg_wo_status.stage_desc is stored trimmed)."""
    final_insp = finishing_final_inspection_sql_match(column)
    return f"""(
        {column} = ANY(%s)
        OR {final_insp}
        OR {column} ILIKE 'Engraving%%Packing%%'
        OR {column} ILIKE 'Packing%%Engraving%%'
    )"""


_tables_initialized = False
_tables_lock = threading.Lock()
_mi_overlay_initialized = False
_mi_overlay_lock = threading.Lock()


def _ensure_tables_once(con) -> None:
    global _tables_initialized
    if _tables_initialized:
        return
    with _tables_lock:
        if _tables_initialized:
            return
        ensure_finishing_queue_tables(con)
        try:
            dedupe_active_inspectors(con)
        except Exception:
            pass
        _tables_initialized = True


def _ensure_mi_overlay_once(con) -> None:
    global _mi_overlay_initialized
    if _mi_overlay_initialized:
        return
    with _mi_overlay_lock:
        if _mi_overlay_initialized:
            return
        # Inspector FK target must exist before MI overlay DDL.
        _ensure_tables_once(con)
        ensure_material_inspection_overlay_table(con)
        _mi_overlay_initialized = True


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


def _build_finishing_queue_staging_sql() -> tuple[str, tuple]:
    """One row per PP partial at its current open finishing stage (synced mfg_wo_status).

    Candidates are partials that already have an open finishing-stage WO. Current
    stage is then resolved only for those keys so the API does not DISTINCT ON
    the whole open WO table (that scan hits statement_timeout under load).
    Tie-break prefers the main WO (highest wo_qty_required) so qty=1 rework
    rows with inverted stage numbers cannot steal the current finishing stage.
    """
    finishing_match_ws = _finishing_stage_eq_sql("ws.stage_desc")
    finishing_match_ces = finishing_stage_sql_match("ces.stage_desc")
    prefix_sql = _finishing_ps_prefix_sql("ws.source_mps_no")
    open_sql = _open_execution_status_sql("ws.execution_status")
    sql = f"""
WITH finishing_candidates AS (
    SELECT DISTINCT ws.source_mps_no, ws.pp_partial_no
    FROM mfg_wo_status ws
    WHERE {open_sql}
      AND ws.stage_no IS NOT NULL
      AND {finishing_match_ws}
      AND {prefix_sql}
),
current_execution_stage AS (
    SELECT DISTINCT ON (ws.source_mps_no, ws.pp_partial_no)
        ws.source_mps_no,
        ws.pp_partial_no,
        ws.stage_no,
        TRIM(COALESCE(ws.stage_desc, '')) AS stage_desc,
        ws.execution_status,
        ws.wo_qty_required,
        ws.total_acc_qty_produced,
        ws.total_rej_qty_produced
    FROM mfg_wo_status ws
    INNER JOIN finishing_candidates cand
            ON cand.source_mps_no = ws.source_mps_no
           AND cand.pp_partial_no = ws.pp_partial_no
    WHERE {open_sql}
      AND ws.stage_no IS NOT NULL
    ORDER BY
        ws.source_mps_no,
        ws.pp_partial_no,
        CASE ws.execution_status
            WHEN 'I' THEN 0
            WHEN 'R' THEN 1
            WHEN 'P' THEN 2
            ELSE 3
        END,
        COALESCE(ws.wo_qty_required, 0) DESC,
        ws.stage_no ASC
),
finishing_current AS (
    SELECT
        ces.source_mps_no AS ps_id,
        ces.pp_partial_no,
        ces.stage_no AS current_stage_no,
        ces.stage_desc AS current_stage_desc,
        ces.execution_status AS current_stage_status,
        ces.wo_qty_required AS stage_qty_required,
        ces.total_acc_qty_produced AS stage_qty_produced,
        ces.total_rej_qty_produced AS stage_qty_rejected
    FROM current_execution_stage ces
    WHERE NULLIF(ces.stage_desc, '') IS NOT NULL
      AND {finishing_match_ces}
)
SELECT
    fc.ps_id,
    fc.pp_partial_no,
    fc.current_stage_no,
    fc.current_stage_desc,
    fc.current_stage_status,
    fc.stage_qty_required,
    fc.stage_qty_produced,
    fc.stage_qty_rejected,
    m.part_no,
    m.part_desc,
    m.bom_code,
    m.sales_order_no,
    m.sales_order_line,
    m.due_date,
    m.qty,
    m.qty_shipped,
    m.so_det_qty,
    m.pp_status
FROM finishing_current fc
LEFT JOIN LATERAL (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.part_no,
        c.description AS part_desc,
        c.bom_code,
        c.source_voucher_no AS sales_order_no,
        c.source_line_item_no AS sales_order_line,
        c.due_date,
        COALESCE(NULLIF(c.partial_qty, 0), c.total_qty) AS qty,
        c.qty_shipped,
        c.so_det_qty,
        c.status AS pp_status
    FROM pp_vouchers_cache c
    WHERE c.ps_id = fc.ps_id
      AND c.pp_partial_no = fc.pp_partial_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
) m ON TRUE
ORDER BY
    CASE
        WHEN fc.current_stage_desc = 'Deburring' THEN 1
        WHEN {finishing_final_inspection_sql_match("fc.current_stage_desc")} THEN 2
        WHEN fc.current_stage_desc = 'Packing' THEN 3
        WHEN fc.current_stage_desc ILIKE 'Engraving%%Packing%%'
          OR fc.current_stage_desc ILIKE 'Packing%%Engraving%%' THEN 4
        ELSE 5
    END,
    CASE fc.current_stage_status
        WHEN 'I' THEN 0
        WHEN 'R' THEN 1
        WHEN 'P' THEN 2
        ELSE 3
    END,
    m.due_date NULLS LAST,
    fc.ps_id,
    fc.pp_partial_no
"""
    stage_params = (list(FINISHING_STAGE_DESCS),)
    return sql, stage_params + _finishing_ps_prefix_params() + stage_params


def _build_recently_packed_staging_sql() -> tuple[str, tuple]:
    """Completed pack/engrave stages from synced mfg_wo_status (plan_end_date as packed date)."""
    from planning.erp_wo_merge import finishing_pack_stage_sql_match

    pack_match = finishing_pack_stage_sql_match("ws.stage_desc")
    prefix_sql = _finishing_ps_prefix_sql("ws.source_mps_no")
    sql = f"""
WITH packed AS (
    SELECT DISTINCT ON (ws.source_mps_no, ws.pp_partial_no, TRIM(COALESCE(ws.stage_desc, '')))
        ws.source_mps_no AS ps_id,
        ws.pp_partial_no,
        TRIM(COALESCE(ws.stage_desc, '')) AS current_stage_desc,
        ws.plan_end_date::date AS packed_on,
        ws.wo_qty_required AS stage_qty_required,
        ws.total_acc_qty_produced AS stage_qty_produced
    FROM mfg_wo_status ws
    WHERE COALESCE(ws.execution_status, '') IN ('C', 'Completed')
      AND {pack_match}
      AND {prefix_sql}
      AND ws.plan_end_date IS NOT NULL
      AND ws.plan_end_date::date >= %s::date
      AND ws.plan_end_date::date <= %s::date
    ORDER BY
        ws.source_mps_no,
        ws.pp_partial_no,
        TRIM(COALESCE(ws.stage_desc, '')),
        ws.plan_end_date DESC
)
SELECT
    p.ps_id,
    p.pp_partial_no,
    p.current_stage_desc,
    p.packed_on,
    p.stage_qty_required,
    p.stage_qty_produced,
    m.part_no,
    m.part_desc,
    m.bom_code,
    m.sales_order_no,
    m.sales_order_line,
    m.due_date,
    m.qty,
    m.qty_shipped,
    m.so_det_qty,
    m.pp_status
FROM packed p
LEFT JOIN LATERAL (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.part_no,
        c.description AS part_desc,
        c.bom_code,
        c.source_voucher_no AS sales_order_no,
        c.source_line_item_no AS sales_order_line,
        c.due_date,
        COALESCE(NULLIF(c.partial_qty, 0), c.total_qty) AS qty,
        c.qty_shipped,
        c.so_det_qty,
        c.status AS pp_status
    FROM pp_vouchers_cache c
    WHERE c.ps_id = p.ps_id
      AND c.pp_partial_no = p.pp_partial_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
) m ON TRUE
ORDER BY p.packed_on DESC, p.ps_id, p.pp_partial_no
"""
    return sql, _finishing_ps_prefix_params()


def fetch_finishing_queue_from_planner(con) -> list[dict[str, Any]]:
    sql, params = _build_finishing_queue_staging_sql()
    return [_serialize_row(dict(row)) for row in rows(con.execute(sql, params))]


def fetch_recently_packed_from_staging(
    con,
    *,
    week_start: date,
    week_end: date,
) -> list[dict[str, Any]]:
    sql, params = _build_recently_packed_staging_sql()
    bound = params + (week_start.isoformat(), week_end.isoformat())
    return [_serialize_row(dict(row)) for row in rows(con.execute(sql, bound))]


def ensure_finishing_queue_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_finishing_queue_inspector (
            inspector_id   BIGSERIAL    PRIMARY KEY,
            name           TEXT         NOT NULL,
            active         BOOLEAN      NOT NULL DEFAULT TRUE,
            created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_finishing_queue_overlay (
            ps_id           TEXT         NOT NULL,
            pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
            stage_desc      TEXT         NOT NULL DEFAULT '',
            remarks         TEXT         NOT NULL DEFAULT '',
            inspector_id    BIGINT       REFERENCES public.planner_finishing_queue_inspector(inspector_id) ON DELETE SET NULL,
            qa_due_date     DATE,
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (ps_id, pp_partial_no, stage_desc)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fq_overlay_inspector
            ON public.planner_finishing_queue_overlay (inspector_id)
            WHERE inspector_id IS NOT NULL
        """
    )
    try:
        con.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_fq_inspector_name_active_unique
                ON public.planner_finishing_queue_inspector (LOWER(TRIM(name)))
                WHERE active = TRUE
            """
        )
    except Exception:
        pass
    for ddl in (
        "ALTER TABLE public.planner_finishing_queue_overlay ADD COLUMN IF NOT EXISTS checklist_done BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE public.planner_finishing_queue_overlay ADD COLUMN IF NOT EXISTS exception_flag BOOLEAN NOT NULL DEFAULT FALSE",
    ):
        try:
            con.execute(ddl)
        except Exception:
            pass
    try:
        _ensure_deburr_qc_push_table(con)
    except Exception:
        pass


def ensure_material_inspection_overlay_table(con) -> None:
    """Planner-side assignment overlay for ERP material inspections (shares the QC inspector team)."""
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_material_inspection_overlay (
            inspection_voucher_no TEXT         PRIMARY KEY,
            inspector_id          BIGINT       REFERENCES public.planner_finishing_queue_inspector(inspector_id) ON DELETE SET NULL,
            remarks               TEXT         NOT NULL DEFAULT '',
            done                  BOOLEAN      NOT NULL DEFAULT FALSE,
            updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mi_overlay_inspector
            ON public.planner_material_inspection_overlay (inspector_id)
            WHERE inspector_id IS NOT NULL
        """
    )


_DEBURR_PUSH_SOURCE_JUMP = "qty_jump"
_DEBURR_PUSH_SOURCE_BASELINE = "baseline"
_DEBURR_QTY_EPS = 1e-9


def _ensure_deburr_qc_push_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_deburr_qc_push (
            source_mps_no   TEXT         NOT NULL,
            pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
            pushed_at       TIMESTAMPTZ  NOT NULL,
            source          TEXT         NOT NULL DEFAULT 'qty_jump',
            qty_jump        NUMERIC,
            stage_no        INTEGER,
            jump_id         BIGINT,
            acc_qty         NUMERIC,
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (source_mps_no, pp_partial_no)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_deburr_qc_push_pushed_at
            ON public.planner_deburr_qc_push (pushed_at DESC)
        """
    )
    try:
        con.execute(
            "ALTER TABLE public.planner_deburr_qc_push "
            "ADD COLUMN IF NOT EXISTS acc_qty NUMERIC"
        )
    except Exception:
        pass


def _deburr_push_key(ps_id: Any, pp_partial_no: Any) -> tuple[str, int] | None:
    ps = compact_text(ps_id)
    if not ps:
        return None
    try:
        partial = max(1, int(pp_partial_no or 1))
    except (TypeError, ValueError):
        partial = 1
    return ps, partial


def is_deburr_qty_jump(jump: dict[str, Any] | None) -> bool:
    if not jump:
        return False
    return finishing_stage_bucket(jump.get("stage_desc")) == "deburring"


def _deburr_qty_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def decide_deburr_push_action(
    current_qty: float | None,
    *,
    stored_acc: float | None = None,
    stored_source: str = "",
    latest_qty: float | None = None,
    latest_known: bool = False,
) -> str:
    """How to persist a Deburring WO qty observation.

    jump     — produced qty increased vs a known baseline; stamp pushed_at
    baseline — first observation with no prior qty; store qty, keep date blank
    seed_acc — already have a scan timestamp; fill acc_qty only
    none     — no write
    """
    if current_qty is None:
        return "none"
    source = compact_text(stored_source)
    if source == _DEBURR_PUSH_SOURCE_JUMP:
        if stored_acc is not None and current_qty > stored_acc + _DEBURR_QTY_EPS:
            return "jump"
        if stored_acc is None:
            return "seed_acc"
        return "none"
    if stored_acc is not None:
        prev = stored_acc
    elif latest_known:
        prev = float(latest_qty or 0.0)
    else:
        return "baseline"
    if current_qty > prev + _DEBURR_QTY_EPS:
        return "jump"
    return "none"


def _deburr_push_upsert_sql() -> str:
    return """
        INSERT INTO planner_deburr_qc_push (
            source_mps_no, pp_partial_no, pushed_at, source, qty_jump, stage_no, jump_id, acc_qty, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (source_mps_no, pp_partial_no) DO UPDATE SET
            pushed_at = CASE
                WHEN EXCLUDED.source = 'qty_jump' AND (
                    planner_deburr_qc_push.source <> 'qty_jump'
                    OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                ) THEN EXCLUDED.pushed_at
                ELSE planner_deburr_qc_push.pushed_at
            END,
            source = CASE
                WHEN EXCLUDED.source = 'qty_jump' THEN 'qty_jump'
                ELSE planner_deburr_qc_push.source
            END,
            qty_jump = CASE
                WHEN EXCLUDED.source = 'qty_jump' AND (
                    planner_deburr_qc_push.source <> 'qty_jump'
                    OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                ) THEN EXCLUDED.qty_jump
                ELSE planner_deburr_qc_push.qty_jump
            END,
            stage_no = CASE
                WHEN EXCLUDED.source = 'qty_jump' AND (
                    planner_deburr_qc_push.source <> 'qty_jump'
                    OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                ) THEN EXCLUDED.stage_no
                ELSE planner_deburr_qc_push.stage_no
            END,
            jump_id = CASE
                WHEN EXCLUDED.source = 'qty_jump' AND (
                    planner_deburr_qc_push.source <> 'qty_jump'
                    OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                ) THEN EXCLUDED.jump_id
                ELSE planner_deburr_qc_push.jump_id
            END,
            acc_qty = COALESCE(EXCLUDED.acc_qty, planner_deburr_qc_push.acc_qty),
            updated_at = NOW()
        WHERE EXCLUDED.source = 'qty_jump'
          AND (
                planner_deburr_qc_push.source <> 'qty_jump'
                OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                OR planner_deburr_qc_push.acc_qty IS DISTINCT FROM EXCLUDED.acc_qty
          )
    """


def record_deburr_qc_pushes_from_jumps(con, jumps: list[dict[str, Any]] | None) -> int:
    """Persist latest Deburring ERP scan as the time the job was pushed toward QC."""
    _ensure_tables_once(con)
    _ensure_deburr_qc_push_table(con)
    payload = []
    latest: dict[tuple[str, int], tuple] = {}
    for jump in jumps or []:
        if not is_deburr_qty_jump(jump):
            continue
        key = _deburr_push_key(jump.get("source_mps_no"), jump.get("pp_partial_no"))
        if not key:
            continue
        scanned_at = jump.get("scanned_at")
        if scanned_at is None:
            continue
        existing = latest.get(key)
        if existing and existing[2] and scanned_at <= existing[2]:
            continue
        qty_jump = jump.get("qty_jump")
        acc_qty = jump.get("new_acc_qty")
        if acc_qty is None:
            acc_qty = qty_jump
        stage_no = jump.get("stage_no")
        jump_id = jump.get("jump_id")
        latest[key] = (
            key[0],
            key[1],
            scanned_at,
            _DEBURR_PUSH_SOURCE_JUMP,
            qty_jump,
            int(stage_no) if stage_no is not None else None,
            int(jump_id) if jump_id is not None else None,
            acc_qty,
        )
    payload = list(latest.values())
    if not payload:
        return 0
    con.executemany(_deburr_push_upsert_sql(), payload)
    return len(payload)


def _backfill_deburr_qc_pushes_from_jumps(con, keys: list[tuple[str, int]]) -> None:
    if not keys:
        return
    ps_ids = [k[0] for k in keys]
    partials = [k[1] for k in keys]

    def _run():
        con.execute(
            f"""
            INSERT INTO planner_deburr_qc_push (
                source_mps_no, pp_partial_no, pushed_at, source, qty_jump, stage_no, jump_id, acc_qty, updated_at
            )
            SELECT DISTINCT ON (j.source_mps_no, j.pp_partial_no)
                j.source_mps_no,
                j.pp_partial_no,
                j.scanned_at,
                '{_DEBURR_PUSH_SOURCE_JUMP}',
                j.qty_jump,
                j.stage_no,
                j.jump_id,
                j.new_acc_qty,
                NOW()
            FROM planner_erp_qty_jump j
            INNER JOIN UNNEST(%s::text[], %s::int[]) AS k(source_mps_no, pp_partial_no)
                    ON j.source_mps_no = k.source_mps_no
                   AND j.pp_partial_no = k.pp_partial_no
            WHERE LOWER(BTRIM(COALESCE(j.stage_desc, ''))) = 'deburring'
            ORDER BY j.source_mps_no, j.pp_partial_no, j.scanned_at DESC
            ON CONFLICT (source_mps_no, pp_partial_no) DO UPDATE SET
                pushed_at = CASE
                    WHEN planner_deburr_qc_push.source <> 'qty_jump'
                      OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                    THEN EXCLUDED.pushed_at
                    ELSE planner_deburr_qc_push.pushed_at
                END,
                source = 'qty_jump',
                qty_jump = CASE
                    WHEN planner_deburr_qc_push.source <> 'qty_jump'
                      OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                    THEN EXCLUDED.qty_jump
                    ELSE planner_deburr_qc_push.qty_jump
                END,
                stage_no = CASE
                    WHEN planner_deburr_qc_push.source <> 'qty_jump'
                      OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                    THEN EXCLUDED.stage_no
                    ELSE planner_deburr_qc_push.stage_no
                END,
                jump_id = CASE
                    WHEN planner_deburr_qc_push.source <> 'qty_jump'
                      OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                    THEN EXCLUDED.jump_id
                    ELSE planner_deburr_qc_push.jump_id
                END,
                acc_qty = COALESCE(EXCLUDED.acc_qty, planner_deburr_qc_push.acc_qty),
                updated_at = NOW()
            WHERE planner_deburr_qc_push.source <> 'qty_jump'
               OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
            """,
            (ps_ids, partials),
        )

    planner_try_savepoint(con, "deburr_qc_push_backfill", _run)


def load_deburr_qc_push_map(
    con, keys: list[tuple[str, int]]
) -> dict[tuple[str, int], dict[str, Any]]:
    clean = []
    seen: set[tuple[str, int]] = set()
    for key in keys:
        parsed = _deburr_push_key(key[0], key[1]) if key else None
        if not parsed or parsed in seen:
            continue
        seen.add(parsed)
        clean.append(parsed)
    if not clean:
        return {}
    ps_ids = [k[0] for k in clean]
    partials = [k[1] for k in clean]
    try:
        overlay_rows = rows(
            con.execute(
                """
                SELECT o.source_mps_no, o.pp_partial_no, o.pushed_at, o.source,
                       o.qty_jump, o.stage_no, o.jump_id, o.acc_qty
                FROM planner_deburr_qc_push o
                INNER JOIN UNNEST(%s::text[], %s::int[]) AS k(source_mps_no, pp_partial_no)
                    ON o.source_mps_no = k.source_mps_no
                   AND o.pp_partial_no = k.pp_partial_no
                """,
                (ps_ids, partials),
            )
        )
    except Exception:
        return {}
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in overlay_rows:
        key = _deburr_push_key(row.get("source_mps_no"), row.get("pp_partial_no"))
        if key:
            out[key] = dict(row)
    return out


def _serialize_deburr_push(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {"deburr_pushed_at": "", "deburr_push_source": ""}
    source = compact_text(row.get("source"))
    if source != _DEBURR_PUSH_SOURCE_JUMP:
        return {"deburr_pushed_at": "", "deburr_push_source": source}
    return {
        "deburr_pushed_at": planner_wall_datetime_to_api(row.get("pushed_at")),
        "deburr_push_source": source,
    }


def _clear_guessed_deburr_qc_pushes(con) -> None:
    """Drop inferred first-seen stamps so the column stays blank without a Deburring qty increase."""
    def _run():
        con.execute(
            """
            DELETE FROM planner_deburr_qc_push
            WHERE source = 'first_seen'
            """
        )

    planner_try_savepoint(con, "deburr_qc_push_clear_guessed", _run)


def _load_deburr_wo_qty_map(
    con, keys: list[tuple[str, int]]
) -> dict[tuple[str, int], dict[str, Any]]:
    if not keys:
        return {}
    ps_ids = [k[0] for k in keys]
    partials = [k[1] for k in keys]

    def _run():
        return rows(
            con.execute(
                """
                SELECT DISTINCT ON (ws.source_mps_no, ws.pp_partial_no)
                    ws.source_mps_no,
                    ws.pp_partial_no,
                    ws.stage_no,
                    ws.total_acc_qty_produced AS acc_qty
                FROM mfg_wo_status ws
                INNER JOIN UNNEST(%s::text[], %s::int[]) AS k(source_mps_no, pp_partial_no)
                        ON ws.source_mps_no = k.source_mps_no
                       AND ws.pp_partial_no = k.pp_partial_no
                WHERE LOWER(BTRIM(COALESCE(ws.stage_desc, ''))) = 'deburring'
                ORDER BY ws.source_mps_no, ws.pp_partial_no,
                         COALESCE(ws.wo_qty_required, 0) DESC,
                         COALESCE(ws.total_acc_qty_produced, 0) DESC
                """,
                (ps_ids, partials),
            )
        )

    wo_rows = planner_try_savepoint(con, "deburr_wo_qty", _run, default=[]) or []
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in wo_rows:
        key = _deburr_push_key(row.get("source_mps_no"), row.get("pp_partial_no"))
        if key:
            out[key] = dict(row)
    return out


def _load_latest_acc_for_stages(
    con, stage_keys: list[tuple[str, int, int]]
) -> dict[tuple[str, int, int], float]:
    clean = []
    seen: set[tuple[str, int, int]] = set()
    for key in stage_keys:
        if not key or key in seen:
            continue
        seen.add(key)
        clean.append(key)
    if not clean:
        return {}
    ps_ids = [k[0] for k in clean]
    partials = [k[1] for k in clean]
    stages = [k[2] for k in clean]

    def _run():
        return rows(
            con.execute(
                """
                SELECT l.source_mps_no, l.pp_partial_no, l.stage_no, l.acc_qty_produced
                FROM planner_erp_wo_qty_latest l
                INNER JOIN UNNEST(%s::text[], %s::int[], %s::int[])
                        AS k(source_mps_no, pp_partial_no, stage_no)
                        ON l.source_mps_no = k.source_mps_no
                       AND l.pp_partial_no = k.pp_partial_no
                       AND l.stage_no = k.stage_no
                """,
                (ps_ids, partials, stages),
            )
        )

    latest_rows = planner_try_savepoint(con, "deburr_latest_acc", _run, default=[]) or []
    out: dict[tuple[str, int, int], float] = {}
    for row in latest_rows:
        key = _deburr_push_key(row.get("source_mps_no"), row.get("pp_partial_no"))
        try:
            stage_no = int(row.get("stage_no"))
        except (TypeError, ValueError):
            continue
        if not key:
            continue
        qty = _deburr_qty_float(row.get("acc_qty_produced"))
        out[(key[0], key[1], stage_no)] = 0.0 if qty is None else qty
    return out


def _sync_deburr_qc_pushes_from_wo_status(con, keys: list[tuple[str, int]]) -> None:
    """Stamp Pushed to QC when Deburring produced qty increases vs the last known qty."""
    if not keys:
        return
    wo_map = _load_deburr_wo_qty_map(con, keys)
    if not wo_map:
        return
    stored_map = load_deburr_qc_push_map(con, keys)
    stage_keys = []
    for key, wo in wo_map.items():
        try:
            stage_keys.append((key[0], key[1], int(wo.get("stage_no"))))
        except (TypeError, ValueError):
            continue
    latest_map = _load_latest_acc_for_stages(con, stage_keys)
    now = datetime.now(timezone.utc)
    payload = []
    for key, wo in wo_map.items():
        current_qty = _deburr_qty_float(wo.get("acc_qty"))
        if current_qty is None:
            continue
        stored = stored_map.get(key) or {}
        try:
            stage_no = int(wo.get("stage_no")) if wo.get("stage_no") is not None else None
        except (TypeError, ValueError):
            stage_no = None
        latest_key = (key[0], key[1], stage_no) if stage_no is not None else None
        latest_known = latest_key in latest_map
        action = decide_deburr_push_action(
            current_qty,
            stored_acc=_deburr_qty_float(stored.get("acc_qty")),
            stored_source=compact_text(stored.get("source")),
            latest_qty=latest_map.get(latest_key) if latest_key else None,
            latest_known=latest_known,
        )
        if action == "none":
            continue
        if action == "jump":
            source = _DEBURR_PUSH_SOURCE_JUMP
        elif action == "seed_acc":
            source = compact_text(stored.get("source")) or _DEBURR_PUSH_SOURCE_JUMP
        else:
            source = _DEBURR_PUSH_SOURCE_BASELINE
        prev_acc = _deburr_qty_float(stored.get("acc_qty"))
        if prev_acc is None and latest_known:
            prev_acc = float(latest_map.get(latest_key) or 0.0)
        qty_jump = current_qty - prev_acc if action == "jump" and prev_acc is not None else None
        pushed_at = now if action == "jump" else (stored.get("pushed_at") or now)
        payload.append(
            (
                key[0],
                key[1],
                pushed_at,
                source,
                qty_jump,
                stage_no,
                None,
                current_qty,
            )
        )
    if not payload:
        return

    def _run():
        con.executemany(_deburr_wo_upsert_sql(), payload)

    planner_try_savepoint(con, "deburr_qc_push_wo", _run)


def _deburr_wo_upsert_sql() -> str:
    return """
        INSERT INTO planner_deburr_qc_push (
            source_mps_no, pp_partial_no, pushed_at, source, qty_jump, stage_no, jump_id, acc_qty, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (source_mps_no, pp_partial_no) DO UPDATE SET
            pushed_at = CASE
                WHEN EXCLUDED.source = 'qty_jump'
                 AND (
                    planner_deburr_qc_push.source <> 'qty_jump'
                    OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                 )
                THEN EXCLUDED.pushed_at
                ELSE planner_deburr_qc_push.pushed_at
            END,
            source = CASE
                WHEN EXCLUDED.source = 'qty_jump' THEN 'qty_jump'
                ELSE planner_deburr_qc_push.source
            END,
            qty_jump = CASE
                WHEN EXCLUDED.source = 'qty_jump'
                 AND (
                    planner_deburr_qc_push.source <> 'qty_jump'
                    OR EXCLUDED.pushed_at > planner_deburr_qc_push.pushed_at
                 )
                THEN EXCLUDED.qty_jump
                ELSE planner_deburr_qc_push.qty_jump
            END,
            stage_no = COALESCE(EXCLUDED.stage_no, planner_deburr_qc_push.stage_no),
            jump_id = planner_deburr_qc_push.jump_id,
            acc_qty = EXCLUDED.acc_qty,
            updated_at = NOW()
    """


def sync_deburr_qc_pushes_for_items(con, items: list[dict[str, Any]]) -> dict[tuple[str, int], dict[str, Any]]:
    """Backfill Deburring qty increases, then return the lookup map."""
    _ensure_tables_once(con)
    _ensure_deburr_qc_push_table(con)
    keys = []
    for item in items:
        key = _deburr_push_key(item.get("ps_id"), item.get("pp_partial_no"))
        if key:
            keys.append(key)
    try:
        _clear_guessed_deburr_qc_pushes(con)
        _backfill_deburr_qc_pushes_from_jumps(con, keys)
        _sync_deburr_qc_pushes_from_wo_status(con, keys)
    except Exception:
        import logging
        logging.getLogger(__name__).warning("deburr QC push sync failed", exc_info=True)
    return load_deburr_qc_push_map(con, keys)


def attach_deburr_qc_pushes_to_rows(con, rows_in: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach deburr_pushed_at onto QC-queue ERP rows matched by MPS / process sheet."""
    keys = []
    for row in rows_in or []:
        mps = (
            compact_text(row.get("mps_no"))
            or compact_text(row.get("alloc_source_mps_no"))
            or compact_text(row.get("process_sheet_no"))
        )
        partial = row.get("source_seq_partial_no") or row.get("pp_partial_no") or 1
        key = _deburr_push_key(mps, partial)
        if key:
            keys.append(key)
    if not keys:
        for row in rows_in or []:
            row["deburr_pushed_at"] = compact_text(row.get("deburr_pushed_at"))
            row["deburr_push_source"] = compact_text(row.get("deburr_push_source"))
        return rows_in
    push_map = sync_deburr_qc_pushes_for_items(
        con,
        [{"ps_id": key[0], "pp_partial_no": key[1]} for key in keys],
    )
    for row in rows_in or []:
        mps = (
            compact_text(row.get("mps_no"))
            or compact_text(row.get("alloc_source_mps_no"))
            or compact_text(row.get("process_sheet_no"))
        )
        partial = row.get("source_seq_partial_no") or row.get("pp_partial_no") or 1
        key = _deburr_push_key(mps, partial)
        serialized = _serialize_deburr_push(push_map.get(key) if key else None)
        row["deburr_pushed_at"] = serialized["deburr_pushed_at"]
        row["deburr_push_source"] = serialized["deburr_push_source"]
    return rows_in


def load_mi_overlay_map(con, voucher_nos: list[str]) -> dict[str, dict[str, Any]]:
    """Map inspection_voucher_no -> overlay row (assignment + done flag)."""
    clean = sorted({compact_text(v) for v in (voucher_nos or []) if compact_text(v)})
    if not clean:
        return {}
    try:
        _ensure_mi_overlay_once(con)
        overlay_rows = rows(
            con.execute(
                """
                SELECT o.inspection_voucher_no, o.inspector_id, o.remarks, o.done, o.updated_at,
                       i.name AS inspector_name
                FROM planner_material_inspection_overlay o
                LEFT JOIN planner_finishing_queue_inspector i
                       ON i.inspector_id = o.inspector_id
                WHERE o.inspection_voucher_no = ANY(%s)
                """,
                (clean,),
            )
        )
    except Exception as exc:
        import logging

        logging.getLogger(__name__).warning("load_mi_overlay_map failed: %s", exc)
        return {}
    return {
        compact_text(row.get("inspection_voucher_no")): dict(row)
        for row in overlay_rows
        if compact_text(row.get("inspection_voucher_no"))
    }


def upsert_mi_overlay(
    con,
    *,
    inspection_voucher_no: str,
    inspector_id: int | None = None,
    remarks: str | None = None,
    done: bool | None = None,
    clear_inspector: bool = False,
) -> dict[str, Any]:
    _ensure_mi_overlay_once(con)
    voucher = compact_text(inspection_voucher_no)
    if not voucher:
        raise ValueError("inspection_voucher_no is required")

    existing = one(
        con.execute(
            """
            SELECT inspector_id, remarks, done
            FROM planner_material_inspection_overlay
            WHERE inspection_voucher_no = %s
            """,
            (voucher,),
        )
    )
    next_inspector = existing.get("inspector_id") if existing else None
    next_remarks = existing.get("remarks", "") if existing else ""
    next_done = bool(existing.get("done")) if existing else False

    if clear_inspector:
        next_inspector = None
    elif inspector_id is not None:
        next_inspector = int(inspector_id) if inspector_id else None
    if remarks is not None:
        next_remarks = compact_text(remarks)
    if done is not None:
        next_done = bool(done)

    row = one(
        con.execute(
            """
            INSERT INTO planner_material_inspection_overlay
                (inspection_voucher_no, inspector_id, remarks, done, updated_at)
            VALUES (%s, %s, %s, %s, NOW())
            ON CONFLICT (inspection_voucher_no) DO UPDATE SET
                inspector_id = EXCLUDED.inspector_id,
                remarks = EXCLUDED.remarks,
                done = EXCLUDED.done,
                updated_at = NOW()
            RETURNING inspection_voucher_no, inspector_id, remarks, done, updated_at
            """,
            (voucher, next_inspector, next_remarks, next_done),
        )
    )
    inspector_name = ""
    if row and row.get("inspector_id"):
        insp = one(
            con.execute(
                "SELECT name FROM planner_finishing_queue_inspector WHERE inspector_id = %s",
                (int(row["inspector_id"]),),
            )
        )
        inspector_name = compact_text(insp.get("name")) if insp else ""
    return {
        "inspection_voucher_no": voucher,
        "inspector_id": row.get("inspector_id") if row else None,
        "inspector_name": inspector_name,
        "remarks": compact_text(row.get("remarks")) if row else "",
        "done": bool(row.get("done")) if row else False,
        "updated_at": _serialize_value(row.get("updated_at")) if row else None,
    }


def dedupe_active_inspectors(con) -> int:
    """Keep one active row per inspector name; re-point overlays; return rows deactivated."""
    dupes = rows(
        con.execute(
            """
            WITH ranked AS (
                SELECT inspector_id,
                       LOWER(TRIM(name)) AS name_key,
                       ROW_NUMBER() OVER (
                           PARTITION BY LOWER(TRIM(name))
                           ORDER BY inspector_id
                       ) AS rn,
                       FIRST_VALUE(inspector_id) OVER (
                           PARTITION BY LOWER(TRIM(name))
                           ORDER BY inspector_id
                       ) AS keep_id
                FROM planner_finishing_queue_inspector
                WHERE active = TRUE
            )
            SELECT inspector_id, keep_id
            FROM ranked
            WHERE rn > 1
            """
        )
    )
    if not dupes:
        return 0

    remove_ids = [int(row["inspector_id"]) for row in dupes]
    for row in dupes:
        keep_id = int(row["keep_id"])
        remove_id = int(row["inspector_id"])
        con.execute(
            """
            UPDATE planner_finishing_queue_overlay
            SET inspector_id = %s
            WHERE inspector_id = %s
            """,
            (keep_id, remove_id),
        )

    con.execute(
        """
        UPDATE planner_finishing_queue_inspector
        SET active = FALSE
        WHERE inspector_id = ANY(%s)
        """,
        (remove_ids,),
    )
    return len(remove_ids)


def _overlay_key(ps_id: str, pp_partial_no: int, stage_desc: str) -> tuple[str, int, str]:
    return (
        compact_text(ps_id),
        int(pp_partial_no or 1),
        compact_text(stage_desc),
    )


def _planner_ps_id(ps_id: str, pp_partial_no: int) -> str:
    return format_planner_ps_id(ps_id, pp_partial_no)


def load_inspectors(con) -> list[dict[str, Any]]:
    try:
        _ensure_tables_once(con)
        return rows(
            con.execute(
                """
                SELECT DISTINCT ON (LOWER(TRIM(name)))
                       inspector_id, name, active, created_at
                FROM planner_finishing_queue_inspector
                WHERE active = TRUE
                ORDER BY LOWER(TRIM(name)), inspector_id
                """
            )
        )
    except Exception:
        return []


def load_overlay_map(con, items: list[dict[str, Any]]) -> dict[tuple[str, int, str], dict[str, Any]]:
    if not items:
        return {}
    keys = []
    seen = set()
    for item in items:
        key = _overlay_key(item.get("ps_id"), item.get("pp_partial_no"), item.get("current_stage_desc"))
        if key[0] and key not in seen:
            seen.add(key)
            keys.append(key)
    if not keys:
        return {}

    ps_ids = [k[0] for k in keys]
    partials = [k[1] for k in keys]
    stages = [k[2] for k in keys]
    try:
        overlay_rows = rows(
            con.execute(
                """
                SELECT o.ps_id, o.pp_partial_no, o.stage_desc, o.remarks, o.inspector_id,
                       o.qa_due_date, o.checklist_done, o.exception_flag, o.updated_at,
                       i.name AS inspector_name
                FROM planner_finishing_queue_overlay o
                LEFT JOIN planner_finishing_queue_inspector i
                       ON i.inspector_id = o.inspector_id
                INNER JOIN UNNEST(%s::text[], %s::int[], %s::text[]) AS k(ps_id, pp_partial_no, stage_desc)
                    ON o.ps_id = k.ps_id
                   AND o.pp_partial_no = k.pp_partial_no
                   AND o.stage_desc = k.stage_desc
                """,
                (ps_ids, partials, stages),
            )
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("load_overlay_map failed: %s", exc)
        return {}
    return {
        _overlay_key(row.get("ps_id"), row.get("pp_partial_no"), row.get("stage_desc")): dict(row)
        for row in overlay_rows
    }


def load_coway_edd_map(con, items: list[dict[str, Any]]) -> dict[str, str]:
    """Coway EDD from planner_process_sheet — same source as delivery schedule."""
    if not items:
        return {}
    source_ids: set[str] = set()
    for item in items:
        raw = compact_text(item.get("ps_id"))
        if not raw:
            continue
        source_ids.add(raw.split("::")[0])
    if not source_ids:
        return {}

    try:
        coway_rows = rows(
            con.execute(
                """
                SELECT source_ps_id, pp_partial_no, coway_proposed_edd
                FROM planner_process_sheet
                WHERE source_ps_id = ANY(%s)
                  AND coway_proposed_edd IS NOT NULL
                """,
                (list(source_ids),),
            )
        )
    except Exception:
        return {}
    out: dict[str, str] = {}
    for row in coway_rows:
        pid = format_planner_ps_id(row.get("source_ps_id"), row.get("pp_partial_no"))
        edd = row.get("coway_proposed_edd")
        if pid and edd:
            out[pid] = _serialize_value(edd) or ""
    return out


def enrich_finishing_items(con, raw_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    overlay_map = load_overlay_map(con, raw_items)
    coway_map = load_coway_edd_map(con, raw_items)
    push_map = sync_deburr_qc_pushes_for_items(con, [
        {
            "ps_id": row.get("ps_id"),
            "pp_partial_no": row.get("pp_partial_no"),
            "stage_bucket": finishing_stage_bucket(compact_text(row.get("current_stage_desc"))),
        }
        for row in raw_items
        if is_finishing_stage_desc(compact_text(row.get("current_stage_desc")))
    ])
    enriched: list[dict[str, Any]] = []
    for row in raw_items:
        stage_desc = compact_text(row.get("current_stage_desc"))
        if not is_finishing_stage_desc(stage_desc):
            continue
        so_qty = row.get("so_det_qty")
        shipped = float(row.get("qty_shipped") or 0)
        if so_qty is not None and shipped_quantity_completed(so_qty, shipped):
            continue

        item = dict(row)
        item["stage_bucket"] = finishing_stage_bucket(stage_desc)
        qty = float(item.get("qty") or 0)
        stage_req = float(item.get("stage_qty_required") or qty or 0)
        stage_prod = float(item.get("stage_qty_produced") or 0)
        item["stage_qty_remaining"] = max(0.0, stage_req - stage_prod) if stage_req > 0 else None

        overlay = overlay_map.get(_overlay_key(item.get("ps_id"), item.get("pp_partial_no"), stage_desc)) or {}
        item["remarks"] = compact_text(overlay.get("remarks"))
        item["inspector_id"] = overlay.get("inspector_id")
        item["inspector_name"] = compact_text(overlay.get("inspector_name"))
        item["qa_due_date"] = _serialize_value(overlay.get("qa_due_date"))
        item["checklist_done"] = bool(overlay.get("checklist_done"))
        item["exception_flag"] = bool(overlay.get("exception_flag"))
        item["overlay_updated_at"] = _serialize_value(overlay.get("updated_at"))
        push = _serialize_deburr_push(
            push_map.get(_deburr_push_key(item.get("ps_id"), item.get("pp_partial_no")))
        )
        item["deburr_pushed_at"] = push["deburr_pushed_at"]
        item["deburr_push_source"] = push["deburr_push_source"]

        planner_id = _planner_ps_id(item.get("ps_id"), item.get("pp_partial_no"))
        item["planner_ps_id"] = planner_id
        coway = coway_map.get(planner_id) or ""
        due = compact_text(item.get("due_date"))
        item["coway_proposed_edd"] = coway
        item["commitment_date"] = coway or due
        enriched.append(item)
    return enriched


def fetch_finishing_queue_rows(con, **_kwargs) -> list[dict[str, Any]]:
    """Synced staging only — run Sync ERP to refresh mfg_wo_status + pp_vouchers_cache."""
    return fetch_finishing_queue_from_planner(con)


def fetch_finishing_queue_bundle(con, **_kwargs) -> dict[str, Any]:
    """Queue rows + inspectors in one planner connection."""
    _ensure_tables_once(con)
    raw_rows = fetch_finishing_queue_rows(con)
    items = enrich_finishing_items(con, raw_rows)
    inspectors = load_inspectors(con)
    return {"items": items, "inspectors": [_serialize_row(dict(i)) for i in inspectors]}


def load_checklist_done_flags(con, planner_ps_ids: list[str]) -> dict[str, bool]:
    """Return {planner_ps_id: True} when any finishing overlay row is checklist_done."""
    ids = [compact_text(pid) for pid in (planner_ps_ids or []) if compact_text(pid)]
    if not ids:
        return {}
    _ensure_tables_once(con)
    by_partial: dict[tuple[str, int], str] = {}
    for pid in ids:
        ps_id, partial_no = parse_planner_ps_id(pid)
        if ps_id:
            by_partial[(ps_id, int(partial_no))] = format_planner_ps_id(ps_id, partial_no)
    if not by_partial:
        return {}
    clauses = []
    params: list[Any] = []
    for (ps_id, partial_no), _planner_id in by_partial.items():
        clauses.append("(ps_id = %s AND pp_partial_no = %s)")
        params.extend([ps_id, partial_no])
    overlay_rows = rows(
        con.execute(
            f"""
            SELECT ps_id, pp_partial_no, checklist_done
            FROM planner_finishing_queue_overlay
            WHERE {' OR '.join(clauses)}
            """,
            tuple(params),
        )
    )
    done_by_planner: dict[str, bool] = {}
    for row in overlay_rows:
        if not bool(row.get("checklist_done")):
            continue
        ps_id = compact_text(row.get("ps_id"))
        try:
            partial_no = int(row.get("pp_partial_no") or 1)
        except (TypeError, ValueError):
            partial_no = 1
        planner_id = format_planner_ps_id(ps_id, partial_no)
        done_by_planner[planner_id] = True
    return done_by_planner


def set_checklist_done_for_planner_ps(
    con,
    planner_ps_id: str,
    checklist_done: bool,
    *,
    stage_desc: str | None = None,
) -> None:
    """Sync delivery-schedule QAQC report flag into finishing-queue overlay rows."""
    ps_id, partial_no = parse_planner_ps_id(planner_ps_id)
    if not ps_id:
        return
    _ensure_tables_once(con)
    stage = compact_text(stage_desc)
    if stage:
        con.execute(
            """
            INSERT INTO planner_finishing_queue_overlay
                (ps_id, pp_partial_no, stage_desc, checklist_done, updated_at)
            VALUES (%s, %s, %s, %s, NOW())
            ON CONFLICT (ps_id, pp_partial_no, stage_desc) DO UPDATE SET
                checklist_done = EXCLUDED.checklist_done,
                updated_at = NOW()
            """,
            (ps_id, int(partial_no), stage, bool(checklist_done)),
        )
        return
    con.execute(
        """
        UPDATE planner_finishing_queue_overlay
        SET checklist_done = %s, updated_at = NOW()
        WHERE ps_id = %s AND pp_partial_no = %s
        """,
        (bool(checklist_done), ps_id, int(partial_no)),
    )


def upsert_overlay(
    con,
    *,
    ps_id: str,
    pp_partial_no: int,
    stage_desc: str,
    remarks: str | None = None,
    inspector_id: int | None = None,
    qa_due_date: str | None = None,
    checklist_done: bool | None = None,
    exception_flag: bool | None = None,
    clear_inspector: bool = False,
    clear_qa_due_date: bool = False,
) -> dict[str, Any]:
    _ensure_tables_once(con)
    ps = compact_text(ps_id)
    partial = int(pp_partial_no or 1)
    stage = compact_text(stage_desc)
    if not ps or not stage:
        raise ValueError("ps_id and stage_desc are required")

    existing = one(
        con.execute(
            """
            SELECT remarks, inspector_id, qa_due_date, checklist_done, exception_flag
            FROM planner_finishing_queue_overlay
            WHERE ps_id = %s AND pp_partial_no = %s AND stage_desc = %s
            """,
            (ps, partial, stage),
        )
    )

    next_remarks = existing.get("remarks", "") if existing else ""
    next_inspector = existing.get("inspector_id") if existing else None
    next_due = existing.get("qa_due_date") if existing else None
    next_checklist_done = bool(existing.get("checklist_done")) if existing else False
    next_exception_flag = bool(existing.get("exception_flag")) if existing else False

    if remarks is not None:
        next_remarks = compact_text(remarks)
    if clear_inspector:
        next_inspector = None
    elif inspector_id is not None:
        next_inspector = int(inspector_id) if inspector_id else None
    if clear_qa_due_date:
        next_due = None
    elif qa_due_date is not None:
        text = compact_text(qa_due_date)
        next_due = text[:10] if text else None
    if checklist_done is not None:
        next_checklist_done = bool(checklist_done)
    if exception_flag is not None:
        next_exception_flag = bool(exception_flag)

    row = one(
        con.execute(
            """
            INSERT INTO planner_finishing_queue_overlay
                (ps_id, pp_partial_no, stage_desc, remarks, inspector_id, qa_due_date,
                 checklist_done, exception_flag, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s::date, %s, %s, NOW())
            ON CONFLICT (ps_id, pp_partial_no, stage_desc) DO UPDATE SET
                remarks = EXCLUDED.remarks,
                inspector_id = EXCLUDED.inspector_id,
                qa_due_date = EXCLUDED.qa_due_date,
                checklist_done = EXCLUDED.checklist_done,
                exception_flag = EXCLUDED.exception_flag,
                updated_at = NOW()
            RETURNING ps_id, pp_partial_no, stage_desc, remarks, inspector_id, qa_due_date,
                      checklist_done, exception_flag, updated_at
            """,
            (ps, partial, stage, next_remarks, next_inspector, next_due, next_checklist_done, next_exception_flag),
        )
    )
    inspector_name = ""
    if row and row.get("inspector_id"):
        insp = one(
            con.execute(
                "SELECT name FROM planner_finishing_queue_inspector WHERE inspector_id = %s",
                (int(row["inspector_id"]),),
            )
        )
        inspector_name = compact_text(insp.get("name")) if insp else ""

    if checklist_done is not None:
        from planning.delivery_planner_service import upsert_delivery_row_flags

        upsert_delivery_row_flags(
            con,
            format_planner_ps_id(ps, partial),
            qaqc_report_ready=bool(next_checklist_done),
            sync_qaqc_checklist=False,
        )

    return {
        "ps_id": ps,
        "pp_partial_no": partial,
        "stage_desc": stage,
        "remarks": compact_text(row.get("remarks")),
        "inspector_id": row.get("inspector_id"),
        "inspector_name": inspector_name,
        "qa_due_date": _serialize_value(row.get("qa_due_date")),
        "checklist_done": bool(row.get("checklist_done")),
        "exception_flag": bool(row.get("exception_flag")),
        "updated_at": _serialize_value(row.get("updated_at")),
    }


def add_inspector(con, name: str) -> tuple[dict[str, Any], bool]:
    """Return (inspector row, created_new). Reuses active/inactive row when name matches."""
    _ensure_tables_once(con)
    clean = compact_text(name)
    if not clean:
        raise ValueError("Inspector name is required")

    existing = one(
        con.execute(
            """
            SELECT inspector_id, name, active, created_at
            FROM planner_finishing_queue_inspector
            WHERE active = TRUE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            ORDER BY inspector_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if existing:
        return dict(existing), False

    inactive = one(
        con.execute(
            """
            SELECT inspector_id, name, active, created_at
            FROM planner_finishing_queue_inspector
            WHERE active = FALSE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            ORDER BY inspector_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if inactive:
        row = one(
            con.execute(
                """
                UPDATE planner_finishing_queue_inspector
                SET active = TRUE, name = %s
                WHERE inspector_id = %s
                RETURNING inspector_id, name, active, created_at
                """,
                (clean, int(inactive["inspector_id"])),
            )
        )
        return (dict(row) if row else {}), True

    row = one(
        con.execute(
            """
            INSERT INTO planner_finishing_queue_inspector (name)
            VALUES (%s)
            RETURNING inspector_id, name, active, created_at
            """,
            (clean,),
        )
    )
    return (dict(row) if row else {}), True


def delete_inspector(con, inspector_id: int) -> dict[str, Any] | None:
    """Deactivate all active rows matching this inspector's name; clear assignments."""
    _ensure_tables_once(con)
    row = one(
        con.execute(
            """
            SELECT inspector_id, name
            FROM planner_finishing_queue_inspector
            WHERE inspector_id = %s AND active = TRUE
            """,
            (int(inspector_id),),
        )
    )
    if not row:
        return None

    name = compact_text(row.get("name"))
    ids = rows(
        con.execute(
            """
            SELECT inspector_id
            FROM planner_finishing_queue_inspector
            WHERE active = TRUE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            """,
            (name,),
        )
    )
    id_list = [int(item["inspector_id"]) for item in ids]
    if not id_list:
        return None

    con.execute(
        """
        UPDATE planner_finishing_queue_overlay
        SET inspector_id = NULL
        WHERE inspector_id = ANY(%s)
        """,
        (id_list,),
    )
    cur = con.execute(
        """
        UPDATE planner_finishing_queue_inspector
        SET active = FALSE
        WHERE inspector_id = ANY(%s) AND active = TRUE
        """,
        (id_list,),
    )
    removed = int(getattr(cur, "rowcount", 0) or 0)
    return {"name": name, "removed_count": removed}
