"""Post-machining queue — synced staging (mfg_wo_status + pp_vouchers_cache) per PP partial."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from planning.erp_wo_merge import (
    FINISHING_STAGE_DESCS,
    finishing_stage_bucket,
    finishing_stage_sql_match,
    is_finishing_stage_desc,
)
from planning.helpers import one, rows
from planning.process_sheets import format_planner_ps_id
from planning.utils import compact_text, shipped_quantity_completed
from sync import _pp_ps_id_prefix_params, _pp_ps_id_prefix_sql

_TEMP_PS_PREFIX_LIKE = "[Temp]%"


def _finishing_ps_prefix_sql(column: str) -> str:
    return f"({_pp_ps_id_prefix_sql(column)} OR {column} LIKE %s)"


def _finishing_ps_prefix_params() -> tuple:
    return _pp_ps_id_prefix_params() + (_TEMP_PS_PREFIX_LIKE,)


_tables_initialized = False


def _ensure_tables_once(con) -> None:
    global _tables_initialized
    if _tables_initialized:
        return
    ensure_finishing_queue_tables(con)
    try:
        dedupe_active_inspectors(con)
    except Exception:
        pass
    _tables_initialized = True


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
    """One row per PP partial at its current open finishing stage (synced mfg_wo_status)."""
    finishing_match = finishing_stage_sql_match("ces.stage_desc")
    prefix_sql = _finishing_ps_prefix_sql("ces.source_mps_no")
    sql = f"""
WITH current_execution_stage AS (
    SELECT DISTINCT ON (source_mps_no, pp_partial_no)
        source_mps_no,
        pp_partial_no,
        stage_no,
        TRIM(COALESCE(stage_desc, '')) AS stage_desc,
        execution_status,
        wo_qty_required,
        total_acc_qty_produced,
        total_rej_qty_produced
    FROM mfg_wo_status
    WHERE COALESCE(execution_status, '') NOT IN ('C', 'Completed', '')
      AND stage_no IS NOT NULL
    ORDER BY
        source_mps_no,
        pp_partial_no,
        CASE execution_status
            WHEN 'I' THEN 0
            WHEN 'R' THEN 1
            WHEN 'P' THEN 2
            ELSE 3
        END,
        COALESCE(total_acc_qty_produced, 0) DESC,
        stage_no ASC
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
      AND {finishing_match}
      AND {prefix_sql}
),
partial_meta AS (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.ps_id,
        c.pp_partial_no,
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
    INNER JOIN finishing_current fc
            ON fc.ps_id = c.ps_id
           AND fc.pp_partial_no = c.pp_partial_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
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
LEFT JOIN partial_meta m
       ON m.ps_id = fc.ps_id
      AND m.pp_partial_no = fc.pp_partial_no
ORDER BY
    CASE
        WHEN fc.current_stage_desc = 'Deburring' THEN 1
        WHEN fc.current_stage_desc = 'Final Inspection' THEN 2
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
    return sql, (list(FINISHING_STAGE_DESCS),) + _finishing_ps_prefix_params()


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
    ensure_finishing_queue_tables(con)
    raw_rows = fetch_finishing_queue_rows(con)
    items = enrich_finishing_items(con, raw_rows)
    inspectors = load_inspectors(con)
    return {"items": items, "inspectors": [_serialize_row(dict(i)) for i in inspectors]}


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
