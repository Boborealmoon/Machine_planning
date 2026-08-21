"""Dedicated WO accepted-qty tracer: slim COMAIN read, jumps only on increase.

Runs on a 5-minute shop-hours cadence. Does not TRUNCATE staging, rebuild
catalog caches, reconcile queues, or take the full ERP sync advisory lock.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from .helpers import one, planner_db, planner_try_savepoint, rows
from .utils import PLANNER_TZ, compact_text

logger = logging.getLogger(__name__)

_QTY_TRACER_LOCK_KEY = 915_042_003
_DEFAULT_SHOP_START = "08:00"
_DEFAULT_SHOP_END = "20:30"


def _truthy_env(name: str, default: str = "") -> bool:
    return str(os.getenv(name, default) or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def erp_qty_tracer_enabled() -> bool:
    """CLI / scheduled task is on unless DISABLE_ERP_QTY_TRACER=1."""
    return not _truthy_env("DISABLE_ERP_QTY_TRACER")


def erp_qty_tracer_thread_enabled() -> bool:
    """In-app Flask loop is off unless ENABLE_ERP_QTY_TRACER=1."""
    return _truthy_env("ENABLE_ERP_QTY_TRACER") and erp_qty_tracer_enabled()


def _parse_hhmm(raw: str, fallback: str) -> int:
    text = compact_text(raw) or fallback
    parts = text.split(":")
    try:
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except (TypeError, ValueError):
        parts = fallback.split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    return max(0, min(24 * 60, hour * 60 + minute))


def in_shop_hours(when: datetime | None = None) -> bool:
    """Mon–Fri within ERP_QTY_TRACER_START/END (Asia/Singapore wall clock)."""
    stamp = when or datetime.now(timezone.utc)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    local = stamp.astimezone(PLANNER_TZ)
    if local.weekday() >= 5:
        return False
    start_min = _parse_hhmm(os.getenv("ERP_QTY_TRACER_START", ""), _DEFAULT_SHOP_START)
    end_min = _parse_hhmm(os.getenv("ERP_QTY_TRACER_END", ""), _DEFAULT_SHOP_END)
    minutes = local.hour * 60 + local.minute
    return start_min <= minutes <= end_min


def _try_tracer_lock(con) -> bool:
    row = one(con.execute("SELECT pg_try_advisory_lock(%s) AS ok", (_QTY_TRACER_LOCK_KEY,)))
    return bool((row or {}).get("ok"))


def _release_tracer_lock(con) -> None:
    con.execute("SELECT pg_advisory_unlock(%s)", (_QTY_TRACER_LOCK_KEY,))


def _watch_source_mps_nos(con) -> list[str]:
    """Process sheets still in-process or under-required at last full sync / last-known."""
    found: set[str] = set()
    staging = planner_try_savepoint(
        con,
        "qty_tracer_watch_staging",
        lambda: rows(
            con.execute(
                """
                SELECT DISTINCT source_mps_no
                FROM mfg_wo_status
                WHERE source_mps_no IS NOT NULL
                  AND (
                    execution_status IN ('I', 'R')
                    OR COALESCE(total_acc_qty_produced, 0)
                       < COALESCE(wo_qty_required, 0)
                  )
                """
            )
        ),
        default=[],
    ) or []
    for row in staging:
        name = compact_text(row.get("source_mps_no"))
        if name:
            found.add(name)

    incomplete = planner_try_savepoint(
        con,
        "qty_tracer_watch_incomplete",
        lambda: rows(
            con.execute(
                """
                WITH latest_snap AS (
                    SELECT DISTINCT ON (source_mps_no, pp_partial_no, stage_no)
                           source_mps_no, pp_partial_no, stage_no,
                           acc_qty_produced, snapshot_at
                    FROM planner_erp_wo_qty_snapshot
                    ORDER BY source_mps_no, pp_partial_no, stage_no, snapshot_at DESC
                ),
                latest_jump AS (
                    SELECT DISTINCT ON (source_mps_no, pp_partial_no, stage_no)
                           source_mps_no, pp_partial_no, stage_no,
                           new_acc_qty AS acc_qty_produced,
                           scanned_at AS snapshot_at
                    FROM planner_erp_qty_jump
                    ORDER BY source_mps_no, pp_partial_no, stage_no, scanned_at DESC
                ),
                last_known AS (
                    SELECT
                        COALESCE(j.source_mps_no, s.source_mps_no) AS source_mps_no,
                        COALESCE(j.pp_partial_no, s.pp_partial_no) AS pp_partial_no,
                        COALESCE(j.stage_no, s.stage_no) AS stage_no,
                        CASE
                            WHEN j.snapshot_at IS NOT NULL
                             AND (s.snapshot_at IS NULL OR j.snapshot_at >= s.snapshot_at)
                            THEN j.acc_qty_produced
                            ELSE s.acc_qty_produced
                        END AS acc_qty_produced
                    FROM latest_snap s
                    FULL OUTER JOIN latest_jump j
                      ON j.source_mps_no = s.source_mps_no
                     AND j.pp_partial_no = s.pp_partial_no
                     AND j.stage_no = s.stage_no
                )
                SELECT DISTINCT lk.source_mps_no
                FROM last_known lk
                JOIN mfg_wo_status w
                  ON w.source_mps_no = lk.source_mps_no
                 AND w.pp_partial_no = lk.pp_partial_no
                 AND w.stage_no = lk.stage_no
                WHERE COALESCE(lk.acc_qty_produced, 0) < COALESCE(w.wo_qty_required, 0)
                """
            )
        ),
        default=[],
    ) or []
    for row in incomplete:
        name = compact_text(row.get("source_mps_no"))
        if name:
            found.add(name)
    return sorted(found)


def run_erp_wo_qty_tracer(*, force: bool = False, now: datetime | None = None) -> dict:
    """Fetch COMAIN quantum, record accepted-qty increases, update last-known on change."""
    if not force and not erp_qty_tracer_enabled():
        return {"skipped": True, "reason": "disabled"}
    if not force and not in_shop_hours(now):
        return {"skipped": True, "reason": "outside shop hours"}

    from db import domain_sync_unreachable

    if domain_sync_unreachable():
        return {"skipped": True, "reason": "COMAIN unreachable"}

    from sync import (
        erp_sync_advisory_lock_is_held,
        fetch_mfg_wo_qty_tracer_rows,
    )

    t0 = time.monotonic()
    with planner_db() as con:
        if erp_sync_advisory_lock_is_held(con):
            return {"skipped": True, "reason": "ERP sync already running"}
        if not _try_tracer_lock(con):
            return {"skipped": True, "reason": "tracer already running"}
        try:
            watch = _watch_source_mps_nos(con)
            t_query = time.monotonic()
            current = fetch_mfg_wo_qty_tracer_rows(watch)
            query_ms = int((time.monotonic() - t_query) * 1000)
            when = now or datetime.now(timezone.utc)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)

            from .erp_actuals import record_erp_wo_qty_snapshots

            counts: dict[str, int] = {}
            snapshot_count = record_erp_wo_qty_snapshots(
                con,
                current,
                synced_at=when,
                only_if_changed=True,
                capture_jumps=True,
                counts=counts,
            )
            jump_count = int(counts.get("jumps") or 0)
            duration_ms = int((time.monotonic() - t0) * 1000)
            summary = {
                "skipped": False,
                "watch_count": len(watch),
                "comain_rows": len(current),
                "jumps": int(jump_count or 0),
                "snapshots": int(snapshot_count or 0),
                "query_ms": query_ms,
                "duration_ms": duration_ms,
            }
            logger.info(
                "WO qty tracer: watch=%d rows=%d jumps=%d snapshots=%d query=%dms total=%dms",
                summary["watch_count"],
                summary["comain_rows"],
                summary["jumps"],
                summary["snapshots"],
                query_ms,
                duration_ms,
            )
            return summary
        finally:
            try:
                _release_tracer_lock(con)
            except Exception:
                logger.warning("WO qty tracer lock release skipped", exc_info=True)
