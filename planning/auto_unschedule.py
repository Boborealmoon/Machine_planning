"""Auto-return DONE run blocks from machine lanes to the catalog (soft unschedule).

Triggers (any one is enough):
  - Full scheduler page reload (GET /api/trial/schedule — primary for hosted + local use)
  - Saving production actuals that mark a block DONE
  - Background thread in app.py and/or OS cron scripts (optional backup)

Opt out: DISABLE_AUTO_UNSCHEDULE_DONE_OPS=1
"""
from __future__ import annotations

import os

from .blocks import recalculate_machine
from .helpers import one, rows
from .utils import compact_text


def _truthy_env(name: str, default: str = "") -> bool:
    return str(os.getenv(name, default) or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def auto_unschedule_enabled() -> bool:
    if _truthy_env("DISABLE_AUTO_UNSCHEDULE_DONE_OPS"):
        return False
    # On by default; set PLANNER_AUTO_UNSCHEDULE_DONE_OPS=0 to disable without the DISABLE_ alias.
    if os.getenv("PLANNER_AUTO_UNSCHEDULE_DONE_OPS") is not None:
        return _truthy_env("PLANNER_AUTO_UNSCHEDULE_DONE_OPS")
    return True


def _has_saved_anchor_column(con) -> bool:
    row = one(
        con.execute(
            """
            SELECT 1 AS ok
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'planner_planning_card'
              AND column_name = 'saved_anchor_datetime'
            """
        )
    )
    return bool(row)


def _persist_saved_anchor(con, *, ps_id: str, group_id: int, anchor_dt) -> None:
    if anchor_dt is None or not _has_saved_anchor_column(con):
        return
    ps_id = compact_text(ps_id)
    group_id = int(group_id or 0)
    if group_id > 0:
        con.execute(
            """
            UPDATE planner_planning_card
            SET saved_anchor_datetime = COALESCE(saved_anchor_datetime, %s),
                updated_at = NOW()
            WHERE scheduled_block_group_id = %s
            """,
            (anchor_dt, group_id),
        )
        return
    if not ps_id:
        return
    con.execute(
        """
        UPDATE planner_planning_card
        SET saved_anchor_datetime = COALESCE(saved_anchor_datetime, %s),
            updated_at = NOW()
        WHERE planner_ps_id = %s
          AND card_type IN ('SINGLE', 'NORMAL', 'COMBINED')
        """,
        (anchor_dt, ps_id),
    )


def _release_planning_cards(con, *, ps_id: str, group_id: int) -> None:
    group_id = int(group_id or 0)
    if group_id > 0:
        con.execute(
            """
            UPDATE planner_planning_card
            SET planning_status = 'PLANNED',
                machine_id = NULL,
                scheduled_block_group_id = NULL,
                updated_at = NOW()
            WHERE scheduled_block_group_id = %s
            """,
            (group_id,),
        )
        return
    ps_id = compact_text(ps_id)
    if not ps_id:
        return
    con.execute(
        """
        UPDATE planner_planning_card
        SET planning_status = 'PLANNED',
            machine_id = NULL,
            scheduled_block_group_id = NULL,
            updated_at = NOW()
        WHERE planner_ps_id = %s
          AND planning_status = 'SCHEDULED'
        """,
        (ps_id,),
    )


def lookup_saved_anchor(con, source_ps_id: str, source_op_no: str = "", group_id: int = 0):
    if not _has_saved_anchor_column(con):
        return None
    group_id = int(group_id or 0)
    if group_id > 0:
        row = one(
            con.execute(
                """
                SELECT saved_anchor_datetime
                FROM planner_planning_card
                WHERE scheduled_block_group_id = %s
                  AND saved_anchor_datetime IS NOT NULL
                ORDER BY card_id
                LIMIT 1
                """,
                (group_id,),
            )
        )
        return (row or {}).get("saved_anchor_datetime")
    ps_id = compact_text(source_ps_id)
    op_no = compact_text(source_op_no)
    if not ps_id:
        return None
    row = one(
        con.execute(
            """
            SELECT pc.saved_anchor_datetime
            FROM planner_planning_card pc
            LEFT JOIN planner_planning_card_operation pco ON pco.card_id = pc.card_id
            WHERE pc.planner_ps_id = %s
              AND pc.saved_anchor_datetime IS NOT NULL
              AND (
                    %s = ''
                 OR COALESCE(pco.source_op_no, '') = %s
                 OR pc.operation_label = %s
              )
            ORDER BY pc.card_id DESC
            LIMIT 1
            """,
            (ps_id, op_no, op_no, op_no),
        )
    )
    return (row or {}).get("saved_anchor_datetime")


def _group_blocks(con, group_id: int):
    return rows(
        con.execute(
            """
            SELECT b.block_id, b.machine_id, b.group_id, b.execution_status, b.anchor_datetime,
                   b.active, b.scheduled_qty, o.source_ps_id, o.job_no, o.source_op_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.group_id = %s
              AND COALESCE(b.active, TRUE) = TRUE
            ORDER BY b.queue_position, b.block_id
            """,
            (int(group_id),),
        )
    )


def _execution_status_completed(value: str) -> bool:
    text = compact_text(value).upper().replace("-", "_").replace(" ", "_")
    return text in {"C", "COMPLETED", "DONE"}


def _erp_marks_row_done(con, row) -> bool:
    source_ps = compact_text(row.get("source_ps_id") or row.get("job_no"))
    if not source_ps:
        return False
    base_ps, _, partial = source_ps.partition("::")
    ps_id = base_ps or source_ps
    try:
        partial_no = max(1, int(partial or 1))
    except (TypeError, ValueError):
        partial_no = 1
    op_no = compact_text(row.get("source_op_no"))
    op_candidates = []
    if op_no:
        op_candidates.append(op_no)
        if op_no.isdigit():
            op_candidates.extend([str(int(op_no)), f"OP{int(op_no)}"])
        elif op_no.upper().startswith("OP") and op_no[2:].isdigit():
            op_candidates.append(op_no[2:])
    # Keep order, drop duplicates
    op_candidates = [v for i, v in enumerate(op_candidates) if v and v not in op_candidates[:i]]

    scheduled_qty = float(row.get("scheduled_qty") or 0)
    if scheduled_qty <= 0:
        return False

    op_rows = []
    if op_candidates:
        op_rows = rows(
            con.execute(
                """
                SELECT execution_status, wo_qty_produced, wo_qty_rejected
                FROM pp_vouchers_cache
                WHERE ps_id = %s
                  AND pp_partial_no = %s
                  AND NULLIF(TRIM(COALESCE(op_no::text, '')), '') = ANY(%s)
                """,
                (ps_id, partial_no, op_candidates),
            )
        )
    if op_rows:
        produced = max(
            (float(item.get("wo_qty_produced") or 0) - float(item.get("wo_qty_rejected") or 0))
            for item in op_rows
        )
        completed = all(_execution_status_completed(item.get("execution_status")) for item in op_rows)
        return completed and produced >= scheduled_qty

    # Stale/missing op mapping fallback: if the PS partial itself is fully completed in ERP,
    # treat lingering planned rows for this PS as done and clear them from machine lanes.
    ps_rows = rows(
        con.execute(
            """
            SELECT execution_status, wo_qty_produced, wo_qty_rejected
            FROM pp_vouchers_cache
            WHERE ps_id = %s
              AND pp_partial_no = %s
            """,
            (ps_id, partial_no),
        )
    )
    if not ps_rows:
        return False
    produced = max(
        (float(item.get("wo_qty_produced") or 0) - float(item.get("wo_qty_rejected") or 0))
        for item in ps_rows
    )
    completed = all(_execution_status_completed(item.get("execution_status")) for item in ps_rows)
    return completed and produced >= scheduled_qty


def block_ready_for_auto_unschedule(con, block_id: int) -> bool:
    block = one(
        con.execute(
            """
            SELECT b.block_id, b.group_id, b.execution_status, b.active, b.scheduled_qty,
                   o.source_ps_id, o.job_no, o.source_op_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not block or not block.get("active", True):
        return False
    status = compact_text(block.get("execution_status")).upper()
    if status != "DONE":
        return _erp_marks_row_done(con, block)
    group_id = int(block.get("group_id") or 0)
    if group_id <= 0:
        return True
    members = _group_blocks(con, group_id)
    if not members:
        return False
    return all(
        compact_text(row.get("execution_status")).upper() == "DONE"
        or _erp_marks_row_done(con, row)
        for row in members
    )


def unschedule_done_block(con, block_id: int, *, reason: str = "AUTO_DONE") -> dict:
    """Soft-remove a DONE block (or DONE combined group) from its machine lane."""
    block = one(
        con.execute(
            """
            SELECT b.*, o.source_ps_id, o.job_no, o.source_op_no
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not block:
        return {"ok": False, "reason": "not_found", "block_ids": []}
    if not block.get("active", True):
        return {"ok": False, "reason": "already_inactive", "block_ids": []}

    group_id = int(block.get("group_id") or 0)
    if group_id > 0:
        member_rows = _group_blocks(con, group_id)
        if not member_rows:
            return {"ok": False, "reason": "empty_group", "block_ids": []}
        if not all(
            compact_text(row.get("execution_status")).upper() == "DONE"
            or _erp_marks_row_done(con, row)
            for row in member_rows
        ):
            return {"ok": False, "reason": "group_not_all_done", "block_ids": []}
        target_rows = member_rows
        anchor_dt = next(
            (row.get("anchor_datetime") for row in member_rows if row.get("anchor_datetime")),
            None,
        )
        ps_id = compact_text(member_rows[0].get("source_ps_id") or member_rows[0].get("job_no"))
    else:
        if compact_text(block.get("execution_status")).upper() != "DONE" and not _erp_marks_row_done(con, block):
            return {"ok": False, "reason": "not_done", "block_ids": []}
        target_rows = [block]
        anchor_dt = block.get("anchor_datetime")
        ps_id = compact_text(block.get("source_ps_id") or block.get("job_no"))

    block_ids = [int(row["block_id"]) for row in target_rows]
    machine_ids = sorted({int(row["machine_id"]) for row in target_rows if int(row.get("machine_id") or 0)})

    _persist_saved_anchor(con, ps_id=ps_id, group_id=group_id, anchor_dt=anchor_dt)
    _release_planning_cards(con, ps_id=ps_id, group_id=group_id)

    for row in target_rows:
        con.execute(
            """
            UPDATE planner_run_block
            SET active = FALSE, updated_at = NOW()
            WHERE block_id = %s
            """,
            (int(row["block_id"]),),
        )

    for machine_id in machine_ids:
        recalculate_machine(con, machine_id)

    return {
        "ok": True,
        "reason": reason,
        "block_ids": block_ids,
        "machine_ids": machine_ids,
        "group_id": group_id,
        "saved_anchor": bool(anchor_dt),
    }


def maybe_auto_unschedule_block(con, block_id: int) -> dict | None:
    if not auto_unschedule_enabled():
        return None
    if not block_ready_for_auto_unschedule(con, block_id):
        return None
    return unschedule_done_block(con, block_id, reason="AUTO_DONE_ACTUAL")


def find_done_active_block_ids(con) -> list[int]:
    """Leader block ids eligible for auto-unschedule (one per combined group)."""
    raw = rows(
        con.execute(
            """
            SELECT b.block_id, b.group_id
            FROM planner_run_block b
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND UPPER(COALESCE(b.execution_status, '')) = 'DONE'
            ORDER BY b.machine_id, b.queue_position, b.block_id
            """
        )
    )
    leaders = []
    seen_groups: set[int] = set()
    for row in raw:
        group_id = int(row.get("group_id") or 0)
        block_id = int(row["block_id"])
        if group_id > 0:
            if group_id in seen_groups:
                continue
            if not block_ready_for_auto_unschedule(con, block_id):
                continue
            seen_groups.add(group_id)
        leaders.append(block_id)
    return leaders


_AUTO_UNSCHEDULE_LOCK_KEY = 915_042_001


def _try_sweep_lock(con) -> bool:
    row = one(con.execute("SELECT pg_try_advisory_lock(%s) AS ok", (_AUTO_UNSCHEDULE_LOCK_KEY,)))
    return bool((row or {}).get("ok"))


def _release_sweep_lock(con) -> None:
    con.execute("SELECT pg_advisory_unlock(%s)", (_AUTO_UNSCHEDULE_LOCK_KEY,))


def ensure_saved_anchor_column(con) -> None:
    con.execute(
        """
        ALTER TABLE public.planner_planning_card
        ADD COLUMN IF NOT EXISTS saved_anchor_datetime TIMESTAMPTZ
        """
    )


def run_auto_unschedule_sweep(con, *, dry_run: bool = False, reason: str = "AUTO_DONE_SWEEP") -> dict:
    if not dry_run and not _try_sweep_lock(con):
        return {"dry_run": False, "skipped": "locked", "candidates": 0, "unscheduled": 0, "results": []}
    try:
        return _run_auto_unschedule_sweep_locked(con, dry_run=dry_run, reason=reason)
    finally:
        if not dry_run:
            _release_sweep_lock(con)


def auto_unschedule_on_page_load(con) -> dict | None:
    """Run when the scheduler board is fully reloaded (not per-machine refresh)."""
    if not auto_unschedule_enabled():
        return None
    ensure_saved_anchor_column(con)
    return run_auto_unschedule_sweep(con, reason="AUTO_DONE_PAGE_LOAD")


def auto_unschedule_for_machines(con, machine_ids, *, reason: str = "AUTO_DONE_MACHINE_REFRESH") -> dict | None:
    """Run auto-unschedule for DONE blocks on a scoped machine list."""
    if not auto_unschedule_enabled():
        return None
    mids = sorted({int(mid) for mid in (machine_ids or []) if int(mid or 0) > 0})
    if not mids:
        return {"candidates": 0, "unscheduled": 0, "results": []}
    ensure_saved_anchor_column(con)
    candidates = rows(
        con.execute(
            """
            SELECT b.block_id
            FROM planner_run_block b
            WHERE COALESCE(b.active, TRUE) = TRUE
              AND b.machine_id = ANY(%s)
            ORDER BY b.machine_id, b.queue_position, b.block_id
            """,
            (mids,),
        )
    )
    seen_groups: set[int] = set()
    block_ids: list[int] = []
    for row in candidates:
        block_id = int(row.get("block_id") or 0)
        if block_id <= 0:
            continue
        block = one(
            con.execute(
                "SELECT group_id FROM planner_run_block WHERE block_id = %s",
                (block_id,),
            )
        )
        group_id = int((block or {}).get("group_id") or 0)
        if group_id > 0:
            if group_id in seen_groups:
                continue
            seen_groups.add(group_id)
        block_ids.append(block_id)

    results = []
    for block_id in block_ids:
        if not block_ready_for_auto_unschedule(con, block_id):
            continue
        results.append(unschedule_done_block(con, block_id, reason=reason))
    ok_count = sum(1 for item in results if item.get("ok"))
    return {"candidates": len(block_ids), "unscheduled": ok_count, "results": results}


def _run_auto_unschedule_sweep_locked(con, *, dry_run: bool = False, reason: str = "AUTO_DONE_SWEEP") -> dict:
    block_ids = find_done_active_block_ids(con)
    results = []
    if dry_run:
        return {"dry_run": True, "candidates": block_ids, "results": []}
    for block_id in block_ids:
        results.append(unschedule_done_block(con, block_id, reason=reason))
    ok_count = sum(1 for item in results if item.get("ok"))
    return {
        "dry_run": False,
        "candidates": len(block_ids),
        "unscheduled": ok_count,
        "results": results,
    }


def apply_saved_anchor_to_new_block(
    con,
    block_id: int,
    source_ps_id: str,
    source_op_no: str = "",
    *,
    explicit_anchor=None,
    group_id: int = 0,
) -> bool:
    if compact_text(explicit_anchor):
        return False
    saved = lookup_saved_anchor(con, source_ps_id, source_op_no, group_id=group_id)
    if not saved:
        return False
    con.execute(
        """
        UPDATE planner_run_block
        SET anchor_datetime = %s, updated_at = NOW()
        WHERE block_id = %s
        """,
        (saved, int(block_id)),
    )
    return True
