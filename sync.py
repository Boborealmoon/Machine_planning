"""
Sync pipeline: COMAIN -> Supabase

Reads source data from COMAIN and reloads Supabase tables via direct Postgres
(SUPA_DB_URL) when available, otherwise REST delete+insert.

Thread-safe: a lock prevents concurrent syncs; a cooldown prevents
re-syncing within SYNC_COOLDOWN_SECS of the last successful sync.
"""

import logging
import os
import threading
import time

import requests
from datetime import datetime, timezone

log = logging.getLogger(__name__)

SYNC_COOLDOWN_SECS = 300
BATCH_SIZE = 500

_last_sync_at: float = 0.0
_sync_lock = threading.Lock()

_last_material_sync_at: float = 0.0
_material_sync_lock = threading.Lock()

_last_bom_stage_sync_at: float = 0.0
_bom_stage_sync_lock = threading.Lock()

_last_wo_status_sync_at: float = 0.0
_wo_status_sync_lock = threading.Lock()

_last_qty_shipped_sync_at: float = 0.0
_qty_shipped_sync_lock = threading.Lock()


# ── REST helpers ───────────────────────────────────────────────────────────

_SUPA_PAGE_SIZE = 1000


def _supa_fetch_all(url: str, headers: dict, params: dict) -> list:
    """Paginate through a Supabase REST endpoint, returning all rows.

    PostgREST silently truncates to 1000 rows by default; this loops with
    limit/offset until a short page signals the end.
    """
    all_rows = []
    offset = 0
    base_params = {k: v for k, v in params.items() if k not in ("limit", "offset")}
    while True:
        page_params = {**base_params, "limit": _SUPA_PAGE_SIZE, "offset": offset}
        r = requests.get(url, headers=headers, params=page_params)
        r.raise_for_status()
        page = r.json()
        all_rows.extend(page)
        if len(page) < _SUPA_PAGE_SIZE:
            break
        offset += _SUPA_PAGE_SIZE
    return all_rows


def _supa_reload(table: str, clear_col: str, columns: list, rows: list) -> None:
    """Clear a Supabase table then insert rows in batches via REST API."""
    from db import supa_url, supa_headers
    base = supa_url()
    hdrs = supa_headers(write=True)

    # Delete all existing rows (PostgREST requires at least one filter)
    r = requests.delete(f"{base}/{table}", headers=hdrs, params={clear_col: "not.is.null"})
    r.raise_for_status()

    if not rows:
        return

    # Insert in batches
    insert_hdrs = {**hdrs, "Prefer": "return=minimal"}
    for i in range(0, len(rows), BATCH_SIZE):
        chunk = [dict(zip(columns, row)) for row in rows[i:i + BATCH_SIZE]]
        # Convert non-serialisable types (e.g. Decimal, date) to plain Python
        for record in chunk:
            for k, v in record.items():
                if hasattr(v, "isoformat"):
                    record[k] = v.isoformat()
                elif v is not None and not isinstance(v, (str, int, float, bool)):
                    record[k] = str(v)
        r = requests.post(f"{base}/{table}", headers=insert_hdrs, json=chunk)
        r.raise_for_status()


# ── Direct Postgres reload (SUPA_DB_URL) ───────────────────────────────────

RELOAD_DIRECT_POSTGRES = "direct_postgres"
RELOAD_REST_DELETE_INSERT = "rest_delete_insert"

PLANNER_STATEMENT_TIMEOUT_MS = int(os.getenv("PLANNER_STATEMENT_TIMEOUT_MS", "600000"))


def _planner_db_available() -> bool:
    return bool(os.getenv("SUPA_DB_URL", "").strip())


def _planner_set_timeout(cur) -> None:
    cur.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")


def _planner_reload(table: str, columns: list, rows: list) -> int:
    """TRUNCATE live table and insert rows via SUPA_DB_URL."""
    from db import planner_get_conn, planner_release_conn

    live = f"public.{table}"
    conn = planner_get_conn()
    try:
        with conn.cursor() as cur:
            _planner_set_timeout(cur)
            cur.execute(f"TRUNCATE {live}")
            if rows:
                col_list = ", ".join(columns)
                placeholders = ", ".join(["%s"] * len(columns))
                insert_sql = f"INSERT INTO {live} ({col_list}) VALUES ({placeholders})"
                for i in range(0, len(rows), BATCH_SIZE):
                    cur.executemany(insert_sql, rows[i : i + BATCH_SIZE])
            cur.execute(f"SELECT COUNT(*) FROM {live}")
            row_count = int(cur.fetchone()[0])
        conn.commit()
        return row_count
    except Exception:
        conn.rollback()
        raise
    finally:
        planner_release_conn(conn)


def _staging_reload(table: str, clear_col: str, columns: list, rows: list) -> str:
    """Prefer direct Postgres via SUPA_DB_URL; fall back to REST delete+insert."""
    if _planner_db_available():
        try:
            _planner_reload(table, columns, rows)
            return RELOAD_DIRECT_POSTGRES
        except Exception as exc:
            log.warning(
                "direct Postgres reload failed for %s (%s); using REST delete+insert",
                table,
                exc,
            )
    _supa_reload(table, clear_col, columns, rows)
    return RELOAD_REST_DELETE_INSERT


def _planner_cache_rebuild() -> int:
    """Rebuild pp_vouchers_cache from vw_pp_vouchers via direct Postgres."""
    from db import planner_get_conn, planner_release_conn

    cols = ", ".join(_PP_VOUCHERS_COLS)
    conn = planner_get_conn()
    try:
        with conn.cursor() as cur:
            _planner_set_timeout(cur)
            cur.execute("TRUNCATE public.pp_vouchers_cache")
            cur.execute(
                f"""
                INSERT INTO public.pp_vouchers_cache ({cols})
                SELECT {cols}
                FROM public.vw_pp_vouchers
                ORDER BY ps_id, pp_partial_no, stage_no
                """
            )
            row_count = int(cur.rowcount)
        conn.commit()
        return row_count
    except Exception:
        conn.rollback()
        raise
    finally:
        planner_release_conn(conn)


# ── PP Vouchers ────────────────────────────────────────────────────────────
# Source tables (pp_voucher, workorder_status, etc.) live in Supabase and are
# loaded by Power Query. We read from the vw_pp_vouchers view and cache the
# result in pp_vouchers_cache for fast API reads.

_PP_VOUCHERS_SQL_UNUSED = """
WITH
base AS (
    SELECT
        pp_voucher_no,
        inventory_code,
        bom_code,
        pp_qty,
        source_voucher_no,
        source_rsd,
        source_line_item_no,
        status
    FROM pp_voucher
),
process_source AS (
    SELECT
        pp_voucher_no,
        process_sheet_no,
        inventory_code,
        total_qty,
        sales_order_date
    FROM mfg_process_sheet_info_v1_view
),
workorder_agg AS (
    SELECT
        source_voucher_no,
        source_voucher_line_item_no,
        MIN(item_qty) AS ws_item_qty,
        MIN(status)   AS ws_status
    FROM workorder_status
    GROUP BY source_voucher_no, source_voucher_line_item_no
),
part_desc_agg AS (
    SELECT
        inventory_code,
        MIN(main_desc) AS description
    FROM part_desc
    GROUP BY inventory_code
),
joined AS (
    SELECT
        b.pp_voucher_no,
        b.inventory_code,
        b.bom_code,
        b.pp_qty,
        b.source_voucher_no,
        b.source_rsd,
        b.source_line_item_no,
        b.status,
        ps.process_sheet_no                                 AS ps_id_raw,
        ps.inventory_code                                   AS ps_inventory_code,
        ps.total_qty                                        AS ps_total_qty,
        ps.sales_order_date                                 AS ps_order_date,
        COALESCE(ps.process_sheet_no, b.pp_voucher_no)      AS ps_id,
        CASE WHEN ps.process_sheet_no IS NOT NULL
             THEN ps.inventory_code
             ELSE b.inventory_code
        END                                                 AS final_inventory_code
    FROM base b
    LEFT JOIN process_source ps ON b.pp_voucher_no = ps.pp_voucher_no
),
filtered AS (
    SELECT *
    FROM joined
    WHERE ps_id LIKE '%MPS%'
       OR ps_id LIKE '%APS%'
       OR ps_id LIKE '%NPS%'
       OR ps_id LIKE '%PPS%'
       OR ps_id LIKE '%CPS%'
       OR ps_id LIKE '%[SR]%'
),
with_workorder AS (
    SELECT
        f.*,
        wa.ws_item_qty,
        wa.ws_status
    FROM filtered f
    LEFT JOIN workorder_agg wa
           ON f.source_voucher_no  = wa.source_voucher_no
          AND f.source_line_item_no = wa.source_voucher_line_item_no
),
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw
    FROM with_workorder ww
    LEFT JOIN pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.description
    FROM with_partial wp
    LEFT JOIN part_desc_agg pd ON wp.final_inventory_code = pd.inventory_code
),
computed AS (
    SELECT DISTINCT
        ps_id,
        pp_partial_no,
        final_inventory_code    AS part_no,
        description,
        CASE
            WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
            WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
            ELSE ws_item_qty
        END                     AS total_qty,
        COALESCE(
            NULLIF(partial_qty_raw, 0),
            CASE
                WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
                ELSE ws_item_qty
            END
        )                       AS partial_qty,
        source_rsd              AS due_date,
        ps_order_date           AS order_date,
        bom_code,
        CASE
            WHEN ws_status IS NOT NULL THEN ws_status
            WHEN status = 'H'          THEN 'History'
            WHEN status = 'O'          THEN 'Outstanding'
            ELSE status
        END                     AS status
    FROM with_desc
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no
"""

_PP_VOUCHERS_COLS = [
    "ps_id", "pp_partial_no", "part_no", "description",
    "total_qty", "partial_qty", "due_date", "order_date",
    "bom_code", "source_voucher_no", "source_line_item_no",
    "qty_shipped", "so_det_qty", "status", "execution_status",
    "wo_qty_required", "wo_qty_produced", "wo_qty_rejected",
    "stage_no", "stage_desc", "op_no",
    "current_stage_no", "current_stage_desc", "current_stage_status",
]


def is_sync_needed() -> bool:
    return (time.monotonic() - _last_sync_at) >= SYNC_COOLDOWN_SECS


def run_sync(force: bool = False) -> dict:
    """Read from Supabase vw_pp_vouchers and reload the cache."""
    global _last_sync_at

    if not force and not is_sync_needed():
        return {"skipped": True, "reason": "within cooldown"}

    if not _sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}

    try:
        t0 = time.monotonic()
        if not _planner_db_available():
            raise RuntimeError(
                "SUPA_DB_URL is required to rebuild pp_vouchers_cache (direct Postgres)"
            )
        row_count = _planner_cache_rebuild()
        reload_mode = RELOAD_DIRECT_POSTGRES

        _last_sync_at = time.monotonic()
        log.info(
            "pp_vouchers cache rebuild (%s) - %d rows in %dms",
            reload_mode,
            row_count,
            int((time.monotonic() - t0) * 1000),
        )
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": row_count,
            "reload": reload_mode,
        }

    finally:
        _sync_lock.release()


# ── material_per_bom ───────────────────────────────────────────────────────

_MATERIAL_PER_BOM_SQL = """
SELECT DISTINCT
    source_inventory_code,
    bom_code,
    material_inventory_code,
    description
FROM public.inventory_bom_listing
WHERE source_inventory_code IS NOT NULL
  AND material_inventory_code NOT IN (
      SELECT source_inventory_code
      FROM public.inventory_bom_listing
      WHERE source_inventory_code IS NOT NULL
  )
ORDER BY source_inventory_code, bom_code, material_inventory_code
"""

_MATERIAL_PER_BOM_COLS = [
    "source_inventory_code", "bom_code", "material_inventory_code", "description",
]


def run_material_per_bom_sync(force: bool = False) -> dict:
    global _last_material_sync_at

    if not force and (time.monotonic() - _last_material_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}

    if not _material_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}

    try:
        from db import get_conn, release_conn

        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_MATERIAL_PER_BOM_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)

        _supa_reload("material_per_bom", "_loaded_at", _MATERIAL_PER_BOM_COLS, rows)

        _last_material_sync_at = time.monotonic()
        log.info("material_per_bom sync complete - %d rows in %dms",
                 len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
        }

    finally:
        _material_sync_lock.release()


# ── bom_op_stage ───────────────────────────────────────────────────────────

_BOM_OP_STAGE_SQL = """
WITH filtered AS (
    SELECT
        inventory_code,
        bom_code,
        stage_no,
        stage_desc,
        CASE
            WHEN stage_desc ~ ' [0-9]+$'
            THEN substring(stage_desc FROM ' ([0-9]+)$')::INTEGER
            ELSE NULL
        END AS op_no
    FROM public.mt_inventory_bom_stage
    WHERE stage_desc LIKE 'Turning%'
       OR stage_desc LIKE 'Milling%'
       OR stage_desc LIKE 'Turnmill%'
)
SELECT
    inventory_code,
    bom_code,
    stage_no,
    stage_desc,
    op_no,
    ROW_NUMBER() OVER (
        PARTITION BY inventory_code, bom_code
        ORDER BY op_no ASC NULLS LAST, stage_no ASC
    ) AS op_index,
    NULL::TEXT AS machine_no,
    180        AS setup_time,
    20         AS cycle_time
FROM filtered
ORDER BY inventory_code, bom_code, op_no NULLS LAST, stage_no
"""

_BOM_OP_STAGE_COLS = [
    "inventory_code", "bom_code", "stage_no", "stage_desc",
    "op_no", "op_index", "machine_no", "setup_time", "cycle_time",
]


def run_bom_op_stage_sync(force: bool = False) -> dict:
    global _last_bom_stage_sync_at

    if not force and (time.monotonic() - _last_bom_stage_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}

    if not _bom_stage_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}

    try:
        from db import get_conn, release_conn

        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_BOM_OP_STAGE_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)

        _supa_reload("bom_op_stage", "_loaded_at", _BOM_OP_STAGE_COLS, rows)

        _last_bom_stage_sync_at = time.monotonic()
        log.info("bom_op_stage sync complete - %d rows in %dms",
                 len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
        }

    finally:
        _bom_stage_sync_lock.release()


# ── pp_voucher staging ─────────────────────────────────────────────────────

_PP_VOUCHER_SQL = """
WITH stage AS (
    SELECT
        inventory_code,
        bom_code,
        stage_no,
        stage_desc,
        CASE
            WHEN stage_desc ~ ' [0-9]+$'
            THEN substring(stage_desc FROM ' ([0-9]+)$')::INTEGER
            ELSE NULL
        END AS op_no
    FROM public.mt_inventory_bom_stage
    WHERE stage_desc LIKE 'Turning%%'
       OR stage_desc LIKE 'Milling%%'
       OR stage_desc LIKE 'Turnmill%%'
)
SELECT
    v.pp_voucher_no,
    v.inventory_code,
    v.bom_code,
    v.pp_qty,
    v.source_voucher_no,
    v.source_rsd,
    regexp_replace(v.source_line_item_no::TEXT, '\\.0+$', '') AS source_line_item_no,
    v.status,
    COALESCE(s.stage_no, 0)     AS stage_no,
    COALESCE(s.stage_desc, '')  AS stage_desc,
    s.op_no
FROM public.mfg_pp_vch v
LEFT JOIN stage s ON s.inventory_code = v.inventory_code
                 AND s.bom_code       = v.bom_code
ORDER BY v.pp_voucher_no, COALESCE(s.stage_no, 0)
"""
_PP_VOUCHER_COLS = [
    "pp_voucher_no", "inventory_code", "bom_code", "pp_qty",
    "source_voucher_no", "source_rsd", "source_line_item_no", "status",
    "stage_no", "stage_desc", "op_no",
]

_last_pp_voucher_sync_at: float = 0.0
_pp_voucher_sync_lock = threading.Lock()


def run_pp_voucher_sync(force: bool = False) -> dict:
    global _last_pp_voucher_sync_at
    if not force and (time.monotonic() - _last_pp_voucher_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _pp_voucher_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_PP_VOUCHER_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("pp_voucher", "_loaded_at", _PP_VOUCHER_COLS, rows)
        _last_pp_voucher_sync_at = time.monotonic()
        log.info("pp_voucher sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows), "reload": reload_mode}
    finally:
        _pp_voucher_sync_lock.release()


# ── sum_qty_shipped_by_sales_order staging ─────────────────────────────────

_QTY_SHIPPED_SQL = """
SELECT
    sales_order_no,
    line_item_no::TEXT AS line_item_no,
    qty_shipped
FROM public.sum_qty_shipped_by_sales_order
WHERE sales_order_no IS NOT NULL
  AND line_item_no IS NOT NULL
"""

_QTY_SHIPPED_COLS = ["sales_order_no", "line_item_no", "qty_shipped"]


def run_qty_shipped_sync(force: bool = False) -> dict:
    global _last_qty_shipped_sync_at
    if not force and (time.monotonic() - _last_qty_shipped_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _qty_shipped_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_QTY_SHIPPED_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("sum_qty_shipped_by_sales_order", "_loaded_at", _QTY_SHIPPED_COLS, rows)
        _last_qty_shipped_sync_at = time.monotonic()
        log.info("sum_qty_shipped sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows), "reload": reload_mode}
    finally:
        _qty_shipped_sync_lock.release()


# ── mfg_process_sheet_info staging ─────────────────────────────────────────

_PROCESS_SHEET_SQL = """
SELECT pp_voucher_no, process_sheet_no, inventory_code, total_qty, sales_order_date
FROM public.mfg_process_sheet_info_v1_view
"""
_PROCESS_SHEET_COLS = [
    "pp_voucher_no", "process_sheet_no", "inventory_code", "total_qty", "sales_order_date",
]

_last_process_sheet_sync_at: float = 0.0
_process_sheet_sync_lock = threading.Lock()


def run_process_sheet_sync(force: bool = False) -> dict:
    global _last_process_sheet_sync_at
    if not force and (time.monotonic() - _last_process_sheet_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _process_sheet_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_PROCESS_SHEET_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("mfg_process_sheet_info", "_loaded_at", _PROCESS_SHEET_COLS, rows)
        _last_process_sheet_sync_at = time.monotonic()
        log.info("mfg_process_sheet_info sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows), "reload": reload_mode}
    finally:
        _process_sheet_sync_lock.release()


# ── workorder_status staging ────────────────────────────────────────────────
# Source: mfg_wo_vch, aggregated per (origin_voucher_no, origin_voucher_line_item_no)
# to satisfy the unique PK in the Supabase staging table.

_WORKORDER_STATUS_SQL = """
SELECT
    origin_voucher_no           AS source_voucher_no,
    origin_voucher_line_item_no AS source_voucher_line_item_no,
    MIN(wo_qty_required)        AS item_qty,
    MIN(execution_status)       AS status
FROM public.mfg_wo_vch
WHERE origin_voucher_no IS NOT NULL
  AND origin_voucher_line_item_no IS NOT NULL
GROUP BY origin_voucher_no, origin_voucher_line_item_no
ORDER BY origin_voucher_no, origin_voucher_line_item_no
"""
_WORKORDER_STATUS_COLS = [
    "source_voucher_no", "source_voucher_line_item_no", "item_qty", "status",
]

_last_workorder_status_sync_at: float = 0.0
_workorder_status_sync_lock = threading.Lock()


def run_workorder_status_sync(force: bool = False) -> dict:
    global _last_workorder_status_sync_at
    if not force and (time.monotonic() - _last_workorder_status_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _workorder_status_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_WORKORDER_STATUS_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("workorder_status", "_loaded_at", _WORKORDER_STATUS_COLS, rows)
        _last_workorder_status_sync_at = time.monotonic()
        log.info("workorder_status sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows), "reload": reload_mode}
    finally:
        _workorder_status_sync_lock.release()


# ── part_desc staging ───────────────────────────────────────────────────────

_PART_DESC_SQL = """
SELECT inventory_code, main_desc
FROM public.mt_inventory
WHERE inventory_code IS NOT NULL
"""
_PART_DESC_COLS = ["inventory_code", "main_desc"]

_last_part_desc_sync_at: float = 0.0
_part_desc_sync_lock = threading.Lock()


def run_part_desc_sync(force: bool = False) -> dict:
    global _last_part_desc_sync_at
    if not force and (time.monotonic() - _last_part_desc_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _part_desc_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_PART_DESC_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("part_desc", "_loaded_at", _PART_DESC_COLS, rows)
        _last_part_desc_sync_at = time.monotonic()
        log.info("part_desc sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows), "reload": reload_mode}
    finally:
        _part_desc_sync_lock.release()


# ── so_detail staging (sales order line qty from ERP order tables) ───────────

_SO_DETAIL_SQL = """
SELECT
    sales_order_no,
    line_item_no,
    inventory_code,
    inventory_code AS item_code,
    qty,
    item_qty
FROM (
    SELECT
        sales_order_no,
        regexp_replace(line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        inventory_code,
        qty,
        CASE
            WHEN dt_type = 'I' AND unit_selling_price_type = 'P' THEN no_of_pack
            ELSE qty
        END AS item_qty
    FROM public.so_order_new_det n
    JOIN public.so_order_new_hdr h USING (sales_order_no)
    WHERE h.status <> 'V'
      AND sales_order_no IS NOT NULL
      AND line_item_no IS NOT NULL
      AND inventory_code IS NOT NULL

    UNION ALL

    SELECT
        sales_order_no,
        regexp_replace(line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        inventory_code,
        qty,
        CASE
            WHEN dt_type = 'I' AND unit_selling_price_type = 'P' THEN no_of_pack
            ELSE qty
        END AS item_qty
    FROM public.so_order_ost_det
    WHERE sales_order_no IS NOT NULL
      AND line_item_no IS NOT NULL
      AND inventory_code IS NOT NULL
) so_lines
"""
_SO_DETAIL_COLS = [
    "sales_order_no", "line_item_no", "inventory_code", "item_code", "qty", "item_qty",
]

_last_so_detail_sync_at: float = 0.0
_so_detail_sync_lock = threading.Lock()


def run_so_detail_sync(force: bool = False) -> dict:
    global _last_so_detail_sync_at
    if not force and (time.monotonic() - _last_so_detail_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _so_detail_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_SO_DETAIL_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("so_detail", "_loaded_at", _SO_DETAIL_COLS, rows)
        _last_so_detail_sync_at = time.monotonic()
        log.info("so_detail sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
            "reload": reload_mode,
        }
    finally:
        _so_detail_sync_lock.release()


# ── pp_partial staging ──────────────────────────────────────────────────────

_PP_PARTIAL_SQL = """
SELECT pp_voucher_no, pp_partial_no, partial_qty
FROM public.mfg_pp_partial
"""
_PP_PARTIAL_COLS = ["pp_voucher_no", "pp_partial_no", "partial_qty"]

_last_pp_partial_sync_at: float = 0.0
_pp_partial_sync_lock = threading.Lock()


def run_pp_partial_sync(force: bool = False) -> dict:
    global _last_pp_partial_sync_at
    if not force and (time.monotonic() - _last_pp_partial_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _pp_partial_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from db import get_conn, release_conn
        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_PP_PARTIAL_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)
        reload_mode = _staging_reload("pp_partial", "_loaded_at", _PP_PARTIAL_COLS, rows)
        _last_pp_partial_sync_at = time.monotonic()
        log.info("pp_partial sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows), "reload": reload_mode}
    finally:
        _pp_partial_sync_lock.release()


# ── mfg_wo_status ──────────────────────────────────────────────────────────
# Reads mfg_wo_vch from COMAIN and aggregates execution_status per PP voucher.
# Priority: I (In Process) > R (Ready to Start) > P (Pending SI) > C (Completed)

_MFG_WO_STATUS_SQL = """
WITH wo_rows AS (
    SELECT
        t2.source_pp_no                   AS source_mps_no,
        COALESCE(pp.pp_partial_no, 1)     AS pp_partial_no,
        t3.execution_status,
        t3.wo_qty_required,
        t3.total_acc_qty_produced,
        t3.total_rej_qty_produced,
        NULLIF(t2.stage_no::TEXT, '')::INTEGER AS stage_no,
        t3.stage_desc,
        t3.plan_start_date,
        t3.plan_end_date,
        t3.origin_rsd,
        t2.origin_voucher_no
    FROM mfg_mps_vch t2
    JOIN mfg_wo_vch t3
      ON t2.wo_voucher_no = t3.voucher_no
     AND t2.stage_no = t3.stage_no
    LEFT JOIN LATERAL (
        SELECT p.pp_partial_no
        FROM public.mfg_pp_partial p
        WHERE p.pp_voucher_no = t2.source_pp_no
          AND p.partial_qty = t3.wo_qty_required
        ORDER BY p.pp_partial_no
        LIMIT 1
    ) pp ON TRUE
    WHERE t2.source_pp_no IS NOT NULL
      AND t2.stage_no IS NOT NULL
)
SELECT
    source_mps_no,
    pp_partial_no,
    CASE
        WHEN bool_or(execution_status = 'I') THEN 'I'
        WHEN bool_or(execution_status = 'R') THEN 'R'
        WHEN bool_or(execution_status = 'P') THEN 'P'
        ELSE 'C'
    END                               AS execution_status,
    SUM(wo_qty_required)              AS wo_qty_required,
    SUM(total_acc_qty_produced)       AS total_acc_qty_produced,
    SUM(total_rej_qty_produced)       AS total_rej_qty_produced,
    stage_no,
    MAX(stage_desc)                   AS stage_desc,
    MIN(plan_start_date)              AS plan_start_date,
    MAX(plan_end_date)                AS plan_end_date,
    MAX(origin_rsd)                   AS po_due_date,
    MAX(origin_voucher_no)            AS so_no
FROM wo_rows
GROUP BY source_mps_no, pp_partial_no, stage_no
ORDER BY source_mps_no, pp_partial_no, stage_no
"""

_MFG_WO_STATUS_COLS = [
    "source_mps_no",
    "pp_partial_no",
    "execution_status",
    "wo_qty_required",
    "total_acc_qty_produced",
    "total_rej_qty_produced",
    "stage_no",
    "stage_desc",
    "plan_start_date",
    "plan_end_date",
    "po_due_date",
    "so_no",
]


def run_mfg_wo_status_sync(force: bool = False) -> dict:
    global _last_wo_status_sync_at

    if not force and (time.monotonic() - _last_wo_status_sync_at) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}

    if not _wo_status_sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}

    try:
        from db import get_conn, release_conn

        t0 = time.monotonic()
        src = get_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_MFG_WO_STATUS_SQL)
                rows = scur.fetchall()
        finally:
            release_conn(src)

        reload_mode = _staging_reload(
            "mfg_wo_status", "_loaded_at", _MFG_WO_STATUS_COLS, rows
        )

        _last_wo_status_sync_at = time.monotonic()
        log.info(
            "mfg_wo_status sync complete (%s) - %d rows in %dms",
            reload_mode,
            len(rows),
            int((time.monotonic() - t0) * 1000),
        )
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
            "reload": reload_mode,
        }

    finally:
        _wo_status_sync_lock.release()


# ── PP staging orchestrator ──────────────────────────────────────────────────

PP_STAGING_STEP_ORDER = [
    "pp_voucher",
    "mfg_process_sheet_info",
    "workorder_status",
    "qty_shipped",
    "so_detail",
    "part_desc",
    "pp_partial",
    "mfg_wo_status",
    "pp_vouchers_cache",
]

PP_STAGING_STEP_LABELS = {
    "pp_voucher": "PP vouchers",
    "mfg_process_sheet_info": "Process sheets",
    "workorder_status": "Work order status",
    "qty_shipped": "Qty shipped",
    "so_detail": "Sales order lines",
    "part_desc": "Part descriptions",
    "pp_partial": "PP partials",
    "mfg_wo_status": "WO status",
    "pp_vouchers_cache": "Voucher cache",
}

PP_STAGING_STEP_ALIASES = {
    "cache": "pp_vouchers_cache",
    "process_sheet": "mfg_process_sheet_info",
    "process_sheets": "mfg_process_sheet_info",
    "wo_status": "mfg_wo_status",
}

_STEP_RUNNERS = {
    "pp_voucher": run_pp_voucher_sync,
    "mfg_process_sheet_info": run_process_sheet_sync,
    "workorder_status": run_workorder_status_sync,
    "qty_shipped": run_qty_shipped_sync,
    "so_detail": run_so_detail_sync,
    "part_desc": run_part_desc_sync,
    "pp_partial": run_pp_partial_sync,
    "mfg_wo_status": run_mfg_wo_status_sync,
    "pp_vouchers_cache": run_sync,
}

_STEP_LOCKS = {
    "pp_voucher": _pp_voucher_sync_lock,
    "mfg_process_sheet_info": _process_sheet_sync_lock,
    "workorder_status": _workorder_status_sync_lock,
    "qty_shipped": _qty_shipped_sync_lock,
    "so_detail": _so_detail_sync_lock,
    "part_desc": _part_desc_sync_lock,
    "pp_partial": _pp_partial_sync_lock,
    "mfg_wo_status": _wo_status_sync_lock,
    "pp_vouchers_cache": _sync_lock,
}

_last_step_results: dict[str, dict] = {}


def normalize_pp_staging_step(name: str) -> str:
    key = (name or "").strip().lower().replace("-", "_")
    key = PP_STAGING_STEP_ALIASES.get(key, key)
    if key not in _STEP_RUNNERS:
        valid = ", ".join(PP_STAGING_STEP_ORDER + sorted(PP_STAGING_STEP_ALIASES))
        raise ValueError(f"Unknown sync step {name!r}; valid: {valid}")
    return key


def resolve_pp_staging_steps(steps: list[str] | None) -> list[str]:
    """Return steps in pipeline order; default is full pipeline."""
    if not steps:
        return list(PP_STAGING_STEP_ORDER)
    normalized = []
    seen = set()
    for raw in steps:
        step = normalize_pp_staging_step(raw)
        if step not in seen:
            normalized.append(step)
            seen.add(step)
    return [s for s in PP_STAGING_STEP_ORDER if s in normalized]


def _record_step_result(step: str, result: dict) -> None:
    _last_step_results[step] = {
        **result,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }


def run_pp_staging_sync(steps: list[str] | None = None, force: bool = True) -> dict:
    """Run selected PP staging steps in pipeline order."""
    ordered = resolve_pp_staging_steps(steps)
    results: dict[str, dict] = {}
    for step in ordered:
        try:
            result = _STEP_RUNNERS[step](force=force)
        except Exception as exc:
            result = {"error": str(exc)}
            _record_step_result(step, result)
            results[step] = result
            results["_failed_at"] = step
            break
        _record_step_result(step, result)
        results[step] = result
        if result.get("error"):
            results["_failed_at"] = step
            break
    results["_steps_requested"] = ordered
    return results


def get_pp_staging_status() -> dict:
    """Last result and lock state per PP staging step."""
    steps = {}
    for step in PP_STAGING_STEP_ORDER:
        lock = _STEP_LOCKS[step]
        steps[step] = {
            "label": PP_STAGING_STEP_LABELS[step],
            "in_progress": lock.locked(),
            "last": _last_step_results.get(step),
        }
    return {
        "steps": steps,
        "step_order": PP_STAGING_STEP_ORDER,
        "cooldown_secs": SYNC_COOLDOWN_SECS,
        "direct_postgres_available": _planner_db_available(),
        "reload_modes": {
            RELOAD_DIRECT_POSTGRES: "TRUNCATE + insert via SUPA_DB_URL",
            RELOAD_REST_DELETE_INSERT: "REST delete all rows then insert",
        },
    }


def run_full_pp_staging_sync(force: bool = True) -> dict:
    """COMAIN → Supabase staging tables, then rebuild pp_vouchers_cache."""
    out = run_pp_staging_sync(steps=None, force=force)
    return {k: v for k, v in out.items() if not k.startswith("_")}
