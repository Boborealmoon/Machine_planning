"""
Sync pipeline: COMAIN → Supabase

Reads the final PP voucher result set from COMAIN and reloads
the pp_vouchers_cache table in Supabase.

Thread-safe: a lock prevents concurrent syncs; a cooldown prevents
re-syncing within SYNC_COOLDOWN_SECS of the last successful sync.
"""

import logging
import threading
import time
from datetime import datetime, timezone

from psycopg2.extras import execute_values

log = logging.getLogger(__name__)

SYNC_COOLDOWN_SECS = 300  # 5 minutes between auto-syncs
_last_sync_at: float = 0.0
_sync_lock = threading.Lock()

# ── Source query (runs against COMAIN) ────────────────────────────────────

_PP_VOUCHERS_SQL = """
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

# ── Public API ─────────────────────────────────────────────────────────────

def is_sync_needed() -> bool:
    return (time.monotonic() - _last_sync_at) >= SYNC_COOLDOWN_SECS


def run_sync(force: bool = False) -> dict:
    """
    Fetch the PP voucher result set from COMAIN and reload Supabase cache.

    Returns a dict with synced_at, duration_ms, row_count on success,
    or skipped=True if within cooldown or another sync is already running.
    Set force=True to bypass the cooldown check.
    """
    global _last_sync_at

    if not force and not is_sync_needed():
        return {"skipped": True, "reason": "within cooldown"}

    if not _sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}

    try:
        from db import get_conn, release_conn, get_supa_conn, release_supa_conn

        t0 = time.monotonic()
        src = get_conn()
        dst = get_supa_conn()
        try:
            with src.cursor() as scur:
                scur.execute(_PP_VOUCHERS_SQL)
                rows = scur.fetchall()

            with dst.cursor() as dcur:
                dcur.execute("TRUNCATE TABLE public.pp_vouchers_cache")
                if rows:
                    execute_values(
                        dcur,
                        """
                        INSERT INTO public.pp_vouchers_cache
                            (ps_id, pp_partial_no, part_no, description,
                             total_qty, partial_qty, due_date, order_date,
                             bom_code, status)
                        VALUES %s
                        """,
                        rows,
                    )
            dst.commit()

            _last_sync_at = time.monotonic()
            log.info("pp_vouchers sync complete — %d rows in %dms",
                     len(rows), int((time.monotonic() - t0) * 1000))
            return {
                "synced_at": datetime.now(timezone.utc).isoformat(),
                "duration_ms": int((time.monotonic() - t0) * 1000),
                "row_count": len(rows),
            }

        except Exception:
            dst.rollback()
            raise
        finally:
            release_conn(src)
            release_supa_conn(dst)

    finally:
        _sync_lock.release()
