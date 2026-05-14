"""
Sync pipeline: COMAIN -> Supabase

Reads source data from COMAIN and reloads Supabase tables via REST API.
Thread-safe: a lock prevents concurrent syncs; a cooldown prevents
re-syncing within SYNC_COOLDOWN_SECS of the last successful sync.
"""

import logging
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


# ── REST helpers ───────────────────────────────────────────────────────────

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
    WHERE ps_id LIKE '%APS%'
       OR ps_id LIKE '%NPS%'
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
            WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
            ELSE pp_qty
        END                     AS total_qty,
        CASE
            WHEN partial_qty_raw IS NULL
              OR partial_qty_raw = 0
              OR partial_qty_raw >= CASE
                    WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                    WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
                    ELSE pp_qty END
              OR (length(ps_id) - length(replace(ps_id, '-', ''))) > 1
            THEN CASE
                    WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                    WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
                    ELSE pp_qty END
            ELSE partial_qty_raw
        END                     AS partial_qty,
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
    "bom_code", "status", "execution_status",
]


def is_sync_needed() -> bool:
    return (time.monotonic() - _last_sync_at) >= SYNC_COOLDOWN_SECS


def run_sync(force: bool = False) -> dict:
    """Read from Supabase vw_pp_vouchers (populated by Power Query) and reload the cache."""
    global _last_sync_at

    if not force and not is_sync_needed():
        return {"skipped": True, "reason": "within cooldown"}

    if not _sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}

    try:
        from db import supa_url, supa_headers

        t0 = time.monotonic()
        r = requests.get(
            f"{supa_url()}/vw_pp_vouchers",
            headers=supa_headers(write=True),
            params={"select": ",".join(_PP_VOUCHERS_COLS), "order": "ps_id,pp_partial_no"},
        )
        r.raise_for_status()
        rows = [tuple(row[c] for c in _PP_VOUCHERS_COLS) for row in r.json()]

        _supa_reload("pp_vouchers_cache", "_synced_at", _PP_VOUCHERS_COLS, rows)

        _last_sync_at = time.monotonic()
        log.info("pp_vouchers sync complete - %d rows in %dms",
                 len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
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
SELECT pp_voucher_no, inventory_code, bom_code, pp_qty,
       source_voucher_no, source_rsd, source_line_item_no, status
FROM public.mfg_pp_vch
"""
_PP_VOUCHER_COLS = [
    "pp_voucher_no", "inventory_code", "bom_code", "pp_qty",
    "source_voucher_no", "source_rsd", "source_line_item_no", "status",
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
        _supa_reload("pp_voucher", "_loaded_at", _PP_VOUCHER_COLS, rows)
        _last_pp_voucher_sync_at = time.monotonic()
        log.info("pp_voucher sync complete - %d rows in %dms", len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows)}
    finally:
        _pp_voucher_sync_lock.release()


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
        _supa_reload("mfg_process_sheet_info", "_loaded_at", _PROCESS_SHEET_COLS, rows)
        _last_process_sheet_sync_at = time.monotonic()
        log.info("mfg_process_sheet_info sync complete - %d rows in %dms", len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows)}
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
        _supa_reload("workorder_status", "_loaded_at", _WORKORDER_STATUS_COLS, rows)
        _last_workorder_status_sync_at = time.monotonic()
        log.info("workorder_status sync complete - %d rows in %dms", len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows)}
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
        _supa_reload("part_desc", "_loaded_at", _PART_DESC_COLS, rows)
        _last_part_desc_sync_at = time.monotonic()
        log.info("part_desc sync complete - %d rows in %dms", len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows)}
    finally:
        _part_desc_sync_lock.release()


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
        _supa_reload("pp_partial", "_loaded_at", _PP_PARTIAL_COLS, rows)
        _last_pp_partial_sync_at = time.monotonic()
        log.info("pp_partial sync complete - %d rows in %dms", len(rows), int((time.monotonic() - t0) * 1000))
        return {"synced_at": datetime.now(timezone.utc).isoformat(), "duration_ms": int((time.monotonic() - t0) * 1000), "row_count": len(rows)}
    finally:
        _pp_partial_sync_lock.release()


# ── mfg_wo_status ──────────────────────────────────────────────────────────
# Reads mfg_wo_vch from COMAIN and aggregates execution_status per PP voucher.
# Priority: P (In Process) > R (Ready to Start) > I (Pending SI) > C (Completed)

_MFG_WO_STATUS_SQL = """
SELECT
    source_mps_no,
    CASE
        WHEN bool_or(execution_status = 'P') THEN 'P'
        WHEN bool_or(execution_status = 'R') THEN 'R'
        WHEN bool_or(execution_status = 'I') THEN 'I'
        ELSE 'C'
    END AS execution_status
FROM public.mfg_wo_vch
WHERE source_mps_no IS NOT NULL
GROUP BY source_mps_no
ORDER BY source_mps_no
"""

_MFG_WO_STATUS_COLS = ["source_mps_no", "execution_status"]


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

        _supa_reload("mfg_wo_status", "_loaded_at", _MFG_WO_STATUS_COLS, rows)

        _last_wo_status_sync_at = time.monotonic()
        log.info("mfg_wo_status sync complete - %d rows in %dms",
                 len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
        }

    finally:
        _wo_status_sync_lock.release()
