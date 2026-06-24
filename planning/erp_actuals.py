"""ERP work-order qty snapshots and daily reconciliation vs shop actuals."""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from .helpers import one, planner_try_savepoint, rows
from .process_sheets import format_planner_ps_id, parse_planner_ps_id
from .utils import compact_text

logger = logging.getLogger(__name__)

_erp_snapshot_schema_ready = False


def ensure_erp_snapshot_table(con) -> None:
    global _erp_snapshot_schema_ready
    if _erp_snapshot_schema_ready:
        return
    # Table only on the hot path; index is created by migrations/add_erp_wo_qty_snapshot.sql.
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_erp_wo_qty_snapshot (
            snapshot_id          BIGSERIAL    PRIMARY KEY,
            source_mps_no        TEXT         NOT NULL,
            pp_partial_no        INTEGER      NOT NULL DEFAULT 1,
            stage_no             INTEGER      NOT NULL,
            snapshot_date        DATE         NOT NULL,
            snapshot_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            acc_qty_produced     NUMERIC      NOT NULL DEFAULT 0,
            acc_rej_qty_produced NUMERIC      NOT NULL DEFAULT 0,
            UNIQUE (source_mps_no, pp_partial_no, stage_no, snapshot_date)
        )
        """
    )
    _erp_snapshot_schema_ready = True


def _float(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _ps_id_candidates(source_mps_no, pp_partial_no):
    source_mps_no = compact_text(source_mps_no)
    try:
        partial_no = max(1, int(pp_partial_no or 1))
    except (TypeError, ValueError):
        partial_no = 1
    candidates = []
    for value in (
        source_mps_no,
        format_planner_ps_id(source_mps_no, partial_no),
        f"{source_mps_no}::{partial_no}" if partial_no > 1 else "",
    ):
        text = compact_text(value)
        if text and text not in candidates:
            candidates.append(text)
    return candidates


def _op_no_candidates(op_no, stage_no=0):
    op_no = compact_text(op_no)
    stage_no = int(stage_no or 0)
    candidates = []
    if op_no:
        candidates.append(op_no)
    if op_no.isdigit():
        candidates.extend([f"OP{op_no}", str(int(op_no))])
    elif op_no.upper().startswith("OP") and op_no[2:].isdigit():
        candidates.append(op_no[2:])
    if stage_no > 0:
        for value in (str(stage_no), f"OP{stage_no}"):
            if value not in candidates:
                candidates.append(value)
    return candidates


def _stage_no_from_process_flow(con, source_mps_no, pp_partial_no, op_no, op_seq_id):
    op_no = compact_text(op_no)
    op_candidates = _op_no_candidates(op_no)

    # Prefer the live process-sheet BOM step for this op label. Stale source_op_seq_id
    # values on older queue rows can point at the wrong ERP stage (e.g. OP30 -> stage 3).
    if op_candidates:
        flow = one(
            con.execute(
                """
                SELECT pfs.source_stage_no, pfs.op_no
                FROM planner_process_sheet ps
                JOIN planner_operation_seq pfs ON pfs.bom_id = ps.selected_bom_id
                WHERE ps.planner_ps_id = ANY(%s)
                  AND NULLIF(TRIM(COALESCE(pfs.op_no, '')), '') = ANY(%s)
                ORDER BY pfs.seq_no, pfs.op_seq_id
                LIMIT 1
                """,
                (_ps_id_candidates(source_mps_no, pp_partial_no), op_candidates),
            )
        )
        if flow and int(flow.get("source_stage_no") or 0) > 0:
            return int(flow["source_stage_no"]), compact_text(flow.get("op_no") or op_no)

    if int(op_seq_id or 0) > 0:
        seq = one(
            con.execute(
                """
                SELECT source_stage_no, op_no
                FROM planner_operation_seq
                WHERE op_seq_id = %s
                LIMIT 1
                """,
                (int(op_seq_id),),
            )
        )
        if seq and int(seq.get("source_stage_no") or 0) > 0:
            seq_op = compact_text(seq.get("op_no"))
            if not op_no or not seq_op or seq_op in _op_no_candidates(op_no, 0):
                return int(seq["source_stage_no"]), compact_text(seq_op or op_no)

    for ps_id in _ps_id_candidates(source_mps_no, pp_partial_no):
        if not op_candidates:
            break
        cache = one(
            con.execute(
                """
                SELECT stage_no, op_no
                FROM pp_vouchers_cache
                WHERE ps_id = %s
                  AND pp_partial_no = %s
                  AND NULLIF(TRIM(COALESCE(op_no::text, '')), '') = ANY(%s)
                ORDER BY stage_no
                LIMIT 1
                """,
                (ps_id, int(pp_partial_no), op_candidates),
            )
        )
        if cache and int(cache.get("stage_no") or 0) > 0:
            return int(cache["stage_no"]), compact_text(cache.get("op_no") or op_no)

    if op_no.isdigit():
        return int(op_no), op_no
    if op_no.upper().startswith("OP") and op_no[2:].isdigit():
        return int(op_no[2:]), op_no
    return 0, op_no


def erp_wo_key_for_block(con, block_row):
    """Resolve ERP mfg_wo_status key (source_mps_no, pp_partial_no, stage_no) for a run block."""
    if not block_row:
        return None

    raw_ps = compact_text(block_row.get("source_ps_id") or block_row.get("job_no"))
    source_mps_no, pp_partial_no = parse_planner_ps_id(raw_ps)
    if not source_mps_no:
        return None

    op_seq_id = int(block_row.get("source_op_seq_id") or 0)
    op_no = compact_text(block_row.get("source_op_no"))
    stage_no, resolved_op_no = _stage_no_from_process_flow(
        con, source_mps_no, pp_partial_no, op_no, op_seq_id
    )
    if stage_no <= 0:
        return None

    return {
        "source_mps_no": source_mps_no,
        "pp_partial_no": int(pp_partial_no),
        "stage_no": int(stage_no),
        "op_no": resolved_op_no or op_no,
    }


def record_erp_wo_qty_snapshots(con, mfg_rows, synced_at=None, columns=None) -> int:
    """Upsert one snapshot row per WO stage for the sync calendar day."""
    if not mfg_rows:
        return 0

    from psycopg2.extras import execute_values

    ensure_erp_snapshot_table(con)
    when = synced_at or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    snapshot_date = when.astimezone().date()

    batch: list[tuple] = []
    for raw in mfg_rows:
        if isinstance(raw, dict):
            row = raw
        elif columns and isinstance(raw, (list, tuple)):
            row = dict(zip(columns, raw))
        else:
            continue
        source_mps_no = compact_text(row.get("source_mps_no"))
        stage_no = row.get("stage_no")
        if not source_mps_no or stage_no is None:
            continue
        try:
            pp_partial_no = max(1, int(row.get("pp_partial_no") or 1))
            stage_no = int(stage_no)
        except (TypeError, ValueError):
            continue
        batch.append(
            (
                source_mps_no,
                pp_partial_no,
                stage_no,
                snapshot_date,
                when,
                _float(row.get("total_acc_qty_produced")),
                _float(row.get("total_rej_qty_produced")),
            )
        )

    if not batch:
        return 0

    execute_values(
        con,
        """
        INSERT INTO planner_erp_wo_qty_snapshot (
          source_mps_no, pp_partial_no, stage_no, snapshot_date, snapshot_at,
          acc_qty_produced, acc_rej_qty_produced
        ) VALUES %s
        ON CONFLICT (source_mps_no, pp_partial_no, stage_no, snapshot_date) DO UPDATE SET
          snapshot_at = EXCLUDED.snapshot_at,
          acc_qty_produced = EXCLUDED.acc_qty_produced,
          acc_rej_qty_produced = EXCLUDED.acc_rej_qty_produced
        """,
        batch,
        page_size=1000,
    )
    return len(batch)


def record_erp_wo_qty_snapshots_from_staging(con, synced_at=None) -> int:
    """Batch snapshot from mfg_wo_status after staging reload (deferred from step 8)."""
    staging_rows = rows(
        con.execute(
            """
            SELECT source_mps_no,
                   pp_partial_no,
                   stage_no,
                   total_acc_qty_produced,
                   total_rej_qty_produced
            FROM mfg_wo_status
            WHERE source_mps_no IS NOT NULL
              AND stage_no IS NOT NULL
            """
        )
    )
    return record_erp_wo_qty_snapshots(con, staging_rows, synced_at=synced_at)


def _snapshots_for_key(con, key):
    if not key:
        return []

    def _load():
        ensure_erp_snapshot_table(con)
        return rows(
            con.execute(
                """
                SELECT snapshot_date::text AS snapshot_date,
                       snapshot_at,
                       acc_qty_produced,
                       acc_rej_qty_produced
                FROM planner_erp_wo_qty_snapshot
                WHERE source_mps_no = %s
                  AND pp_partial_no = %s
                  AND stage_no = %s
                ORDER BY snapshot_date ASC, snapshot_at ASC
                """,
                (key["source_mps_no"], key["pp_partial_no"], key["stage_no"]),
            )
        )

    return planner_try_savepoint(con, "erp_snapshots", _load, default=[]) or []


def _daily_deltas_from_snapshots(snapshots):
    """Map snapshot_date -> {daily_produced, daily_reject, acc_produced, acc_reject, snapshot_at}."""
    daily = {}
    prev_acc = 0.0
    prev_rej = 0.0
    for row in snapshots:
        report_date = compact_text(row.get("snapshot_date"))
        if not report_date:
            continue
        acc = _float(row.get("acc_qty_produced"))
        rej = _float(row.get("acc_rej_qty_produced"))
        daily[report_date] = {
            "report_date": report_date,
            "erp_daily_qty": max(0.0, acc - prev_acc),
            "erp_daily_reject": max(0.0, rej - prev_rej),
            "erp_acc_qty": acc,
            "erp_acc_reject": rej,
            "erp_snapshot_at": compact_text(row.get("snapshot_at")),
        }
        prev_acc = acc
        prev_rej = rej
    return daily


def _current_erp_row(con, key):
    if not key:
        return None
    stage_no = int(key.get("stage_no") or 0)
    op_candidates = _op_no_candidates(key.get("op_no"), stage_no)
    live = one(
        con.execute(
            """
            SELECT total_acc_qty_produced AS acc_qty_produced,
                   total_rej_qty_produced AS acc_rej_qty_produced,
                   execution_status,
                   _loaded_at AS loaded_at
            FROM mfg_wo_status
            WHERE source_mps_no = %s
              AND pp_partial_no = %s
              AND stage_no = %s
            LIMIT 1
            """,
            (key["source_mps_no"], key["pp_partial_no"], stage_no),
        )
    )
    return live


def _erp_totals_from_voucher_cache(con, key):
    """Same source as process sheet: pp_vouchers_cache by ps + partial + stage/op."""
    if not key:
        return None
    stage_no = int(key.get("stage_no") or 0)
    op_candidates = _op_no_candidates(key.get("op_no"), stage_no)
    best = None
    for ps_id in _ps_id_candidates(key["source_mps_no"], key["pp_partial_no"]):
        if op_candidates:
            row = one(
                con.execute(
                    """
                    SELECT COALESCE(MAX(wo_qty_produced), 0) AS acc_qty_produced,
                           COALESCE(MAX(wo_qty_rejected), 0) AS acc_rej_qty_produced,
                           MAX(_synced_at) AS loaded_at
                    FROM pp_vouchers_cache
                    WHERE ps_id = %s
                      AND pp_partial_no = %s
                      AND (
                            (%s > 0 AND stage_no = %s)
                         OR COALESCE(op_no::text, '') = ANY(%s)
                      )
                    """,
                    (ps_id, key["pp_partial_no"], stage_no, stage_no, op_candidates),
                )
            )
        elif stage_no > 0:
            row = one(
                con.execute(
                    """
                    SELECT COALESCE(MAX(wo_qty_produced), 0) AS acc_qty_produced,
                           COALESCE(MAX(wo_qty_rejected), 0) AS acc_rej_qty_produced,
                           MAX(_synced_at) AS loaded_at
                    FROM pp_vouchers_cache
                    WHERE ps_id = %s
                      AND pp_partial_no = %s
                      AND stage_no = %s
                    """,
                    (ps_id, key["pp_partial_no"], stage_no),
                )
            )
        else:
            row = one(
                con.execute(
                    """
                    SELECT COALESCE(MAX(wo_qty_produced), 0) AS acc_qty_produced,
                           COALESCE(MAX(wo_qty_rejected), 0) AS acc_rej_qty_produced,
                           MAX(_synced_at) AS loaded_at
                    FROM pp_vouchers_cache
                    WHERE ps_id = %s
                      AND pp_partial_no = %s
                    """,
                    (ps_id, key["pp_partial_no"]),
                )
            )
        if not row:
            continue
        if _float(row.get("acc_qty_produced")) > 0 or _float(row.get("acc_rej_qty_produced")) > 0:
            return row
        if best is None:
            best = row
    return best


def _inject_live_erp_daily(daily_by_date, erp_acc, erp_reject, erp_sync_at, anchor_dates):
    """When WO snapshots are empty, expose cumulative ERP on the latest planned date."""
    erp_acc = _float(erp_acc)
    erp_reject = _float(erp_reject)
    if erp_acc <= 0 and erp_reject <= 0:
        return daily_by_date
    if daily_by_date:
        last_acc = 0.0
        for report_date in sorted(daily_by_date):
            last_acc = _float(daily_by_date[report_date].get("erp_acc_qty"))
        if last_acc >= erp_acc - 1e-9:
            return daily_by_date

    anchor_dates = [compact_text(value) for value in (anchor_dates or []) if compact_text(value)]
    report_date = max(anchor_dates) if anchor_dates else date.today().isoformat()
    daily_by_date = dict(daily_by_date or {})
    daily_by_date[report_date] = {
        "report_date": report_date,
        "erp_daily_qty": erp_acc,
        "erp_daily_reject": erp_reject,
        "erp_acc_qty": erp_acc,
        "erp_acc_reject": erp_reject,
        "erp_snapshot_at": compact_text(erp_sync_at),
        "erp_live_fallback": True,
    }
    return daily_by_date


def _qty_source(erp_value, shop_value):
    erp_value = _float(erp_value)
    shop_value = _float(shop_value)
    if shop_value > erp_value + 1e-9:
        return "shop"
    if erp_value > shop_value + 1e-9:
        return "erp"
    if erp_value > 0 or shop_value > 0:
        return "match"
    return "none"


def effective_actual_totals_for_block(con, block_row, recon=None):
    """ERP is source of truth; shop staging wins when strictly higher (manual override)."""
    from .actuals import actual_totals_for_block, allocate_qty_across_operation_splits, operation_split_siblings

    recon = recon if recon is not None else erp_reconciliation_for_block(con, block_row)
    block_id = int(block_row.get("block_id") or 0) if block_row else 0
    shop = actual_totals_for_block(con, block_id) if block_id else {
        "output_qty": 0.0,
        "reject_qty": 0.0,
        "good_qty": 0.0,
    }

    erp_output = _float(recon.get("erp_acc_qty"))
    erp_reject = _float(recon.get("erp_acc_reject"))
    shop_output = _float(shop.get("output_qty"))
    shop_reject = _float(shop.get("reject_qty"))
    shop_good = _float(shop.get("good_qty"))
    erp_good = max(0.0, erp_output - erp_reject)

    effective_output = max(erp_output, shop_output)
    effective_reject = max(erp_reject, shop_reject)
    effective_good = max(erp_good, shop_good)

    has_block_shop_actuals = shop_output > 0 or shop_reject > 0 or int(shop.get("output_reports") or 0) > 0
    if not has_block_shop_actuals and len(operation_split_siblings(con, block_row)) > 1:
        effective_good = allocate_qty_across_operation_splits(con, block_row, effective_good)
        effective_output = allocate_qty_across_operation_splits(con, block_row, effective_output)
        effective_reject = allocate_qty_across_operation_splits(con, block_row, effective_reject)

    return {
        "erp_output_qty": erp_output,
        "erp_reject_qty": erp_reject,
        "erp_good_qty": erp_good,
        "shop_output_qty": shop_output,
        "shop_reject_qty": shop_reject,
        "shop_good_qty": shop_good,
        "effective_output_qty": effective_output,
        "effective_reject_qty": effective_reject,
        "effective_good_qty": effective_good,
        "output_source": _qty_source(erp_output, shop_output),
        "reject_source": _qty_source(erp_reject, shop_reject),
        "good_source": _qty_source(erp_good, shop_good),
    }


def _planned_dates_for_block(con, block_row):
    block_id = int(block_row.get("block_id") or 0) if block_row else 0
    if not block_id:
        return []
    return [
        compact_text(row["segment_date"])
        for row in rows(
            con.execute(
                """
                SELECT segment_date::text AS segment_date
                FROM planner_run_block_segment
                WHERE block_id = %s
                  AND COALESCE(segment_type, '') = 'production'
                  AND segment_date IS NOT NULL
                ORDER BY segment_date
                """,
                (block_id,),
            )
        )
        if compact_text(row.get("segment_date"))
    ]


def erp_reconciliation_for_block(con, block_row, *, anchor_dates=None, shop_totals=None):
    key = erp_wo_key_for_block(con, block_row)
    if not key:
        return {
            "linked": False,
            "source_mps_no": compact_text(block_row.get("source_ps_id") if block_row else ""),
            "stage_no": None,
            "erp_acc_qty": 0.0,
            "erp_acc_reject": 0.0,
            "erp_last_sync_at": "",
            "shop_acc_good_qty": 0.0,
            "unallocated_erp_qty": 0.0,
            "daily_by_date": {},
        }

    snapshots = _snapshots_for_key(con, key)
    daily_by_date = _daily_deltas_from_snapshots(snapshots)
    live = _current_erp_row(con, key) or {}

    erp_acc = _float(live.get("acc_qty_produced"))
    if erp_acc <= 0 and snapshots:
        last = snapshots[-1]
        erp_acc = _float(last.get("acc_qty_produced"))

    erp_reject = _float(live.get("acc_rej_qty_produced"))
    if erp_reject <= 0 and snapshots:
        erp_reject = _float(snapshots[-1].get("acc_rej_qty_produced"))

    voucher = _erp_totals_from_voucher_cache(con, key) or {}
    if erp_acc <= 0 and _float(voucher.get("acc_qty_produced")) > 0:
        erp_acc = _float(voucher.get("acc_qty_produced"))
    if erp_reject <= 0 and _float(voucher.get("acc_rej_qty_produced")) > 0:
        erp_reject = _float(voucher.get("acc_rej_qty_produced"))

    block_id = int(block_row.get("block_id") or 0)
    if shop_totals is None:
        from .actuals import actual_totals_for_block

        shop_totals = actual_totals_for_block(con, block_id) if block_id else {}
    shop_output = _float(shop_totals.get("output_qty"))
    shop_reject = _float(shop_totals.get("reject_qty"))
    shop_good = _float(shop_totals.get("good_qty"))
    erp_good = max(0.0, erp_acc - erp_reject)
    effective_output = max(erp_acc, shop_output)
    effective_reject = max(erp_reject, shop_reject)
    effective_good = max(erp_good, shop_good)

    last_sync = ""
    if snapshots:
        last_sync = compact_text(snapshots[-1].get("snapshot_at"))
    if not last_sync:
        last_sync = compact_text(live.get("loaded_at"))
    if not last_sync:
        last_sync = compact_text(voucher.get("loaded_at"))

    erp_data_source = "mfg_wo_status"
    if _float(live.get("acc_qty_produced")) <= 0 and _float(voucher.get("acc_qty_produced")) > 0:
        erp_data_source = "pp_vouchers_cache"

    if anchor_dates is None:
        anchor_dates = _planned_dates_for_block(con, block_row)
    else:
        anchor_dates = [compact_text(value) for value in anchor_dates if compact_text(value)]
    daily_by_date = _inject_live_erp_daily(
        daily_by_date,
        erp_acc,
        erp_reject,
        last_sync,
        anchor_dates,
    )

    return {
        "linked": True,
        "source_mps_no": key["source_mps_no"],
        "pp_partial_no": key["pp_partial_no"],
        "stage_no": key["stage_no"],
        "erp_op_no": compact_text(key.get("op_no") or ""),
        "erp_acc_qty": erp_acc,
        "erp_acc_reject": erp_reject,
        "erp_last_sync_at": last_sync,
        "erp_data_source": erp_data_source,
        "shop_acc_output_qty": shop_output,
        "shop_acc_reject_qty": shop_reject,
        "shop_acc_good_qty": shop_good,
        "effective_output_qty": effective_output,
        "effective_reject_qty": effective_reject,
        "effective_good_qty": effective_good,
        "output_source": _qty_source(erp_acc, shop_output),
        "reject_source": _qty_source(erp_reject, shop_reject),
        "good_source": _qty_source(erp_good, shop_good),
        "unallocated_erp_qty": max(0.0, erp_acc - erp_reject - effective_good) if erp_acc > 0 else 0.0,
        "daily_by_date": daily_by_date,
    }


def _shop_qty_for_row(row):
    output = row.get("output_qty")
    reject = row.get("reject_qty")
    if output in ("", None) and reject in ("", None):
        return 0.0, 0.0, None
    output_qty = _float(output)
    reject_qty = _float(reject)
    return output_qty, reject_qty, max(0.0, output_qty - reject_qty)


def _shop_good_for_row(row):
    _, _, good = _shop_qty_for_row(row)
    return good


def _reconcile_status(shop_good, erp_daily):
    if erp_daily is None or erp_daily <= 0:
        if shop_good is not None and shop_good > 0:
            return "shop_only"
        return "no_data"
    if shop_good is None or shop_good <= 0:
        return "erp_only"
    if abs(shop_good - erp_daily) < 0.5:
        return "match"
    if shop_good > erp_daily:
        return "shop_ahead"
    return "erp_ahead"


def enrich_actual_daily_rows_with_erp(con, block_row, daily_rows, *, anchor_dates=None, shop_totals=None):
    if anchor_dates is None:
        anchor_dates = [
            compact_text(row.get("report_date"))
            for row in (daily_rows or [])
            if compact_text(row.get("report_date"))
        ]
    recon = erp_reconciliation_for_block(
        con,
        block_row,
        anchor_dates=anchor_dates,
        shop_totals=shop_totals,
    )
    daily_map = recon.get("daily_by_date") or {}
    enriched = []
    for row in daily_rows or []:
        item = dict(row)
        report_date = compact_text(item.get("report_date"))
        erp_day = daily_map.get(report_date) or {}
        shop_output, shop_reject, shop_good = _shop_qty_for_row(item)
        has_erp_day = bool(erp_day)
        erp_daily_output = _float(erp_day.get("erp_daily_qty")) if has_erp_day else 0.0
        erp_daily_reject = _float(erp_day.get("erp_daily_reject")) if has_erp_day else 0.0
        erp_daily = erp_daily_output if has_erp_day else None

        effective_output = max(erp_daily_output, shop_output)
        effective_reject = max(erp_daily_reject, shop_reject)
        effective_good = max(
            max(0.0, erp_daily_output - erp_daily_reject),
            shop_good if shop_good is not None else 0.0,
        )

        item["erp_daily_qty"] = erp_daily
        item["erp_daily_reject"] = erp_daily_reject if has_erp_day else None
        item["erp_acc_qty"] = _float(erp_day.get("erp_acc_qty")) if has_erp_day else None
        item["erp_snapshot_at"] = compact_text(erp_day.get("erp_snapshot_at")) if has_erp_day else ""
        item["shop_output_qty"] = shop_output
        item["shop_reject_qty"] = shop_reject
        item["shop_good_qty"] = shop_good
        item["display_output_qty"] = effective_output
        item["display_reject_qty"] = effective_reject
        item["display_good_qty"] = effective_good
        item["output_source"] = _qty_source(erp_daily_output, shop_output)
        item["reject_source"] = _qty_source(erp_daily_reject, shop_reject)
        item["good_source"] = _qty_source(
            max(0.0, erp_daily_output - erp_daily_reject),
            shop_good if shop_good is not None else 0.0,
        )
        item["reconcile_status"] = _reconcile_status(shop_good, erp_daily if has_erp_day else None)
        enriched.append(item)

    known_dates = {compact_text(row.get("report_date")) for row in enriched}
    for report_date, erp_day in daily_map.items():
        if not report_date or report_date in known_dates:
            continue
        erp_daily_output = _float(erp_day.get("erp_daily_qty"))
        erp_daily_reject = _float(erp_day.get("erp_daily_reject"))
        if erp_daily_output <= 0 and erp_daily_reject <= 0:
            continue
        enriched.append(
            {
                "report_date": report_date,
                "original_report_date": "",
                "target_qty": 0.0,
                "output_qty": str(int(erp_daily_output)) if erp_daily_output == int(erp_daily_output) else str(erp_daily_output),
                "reject_qty": str(int(erp_daily_reject)) if erp_daily_reject == int(erp_daily_reject) else str(erp_daily_reject),
                "remarks": "",
                "is_planned_row": False,
                "is_existing_actual": False,
                "actual_id": None,
                "locked_date": True,
                "erp_daily_qty": erp_daily_output,
                "erp_daily_reject": erp_daily_reject,
                "display_output_qty": erp_daily_output,
                "display_reject_qty": erp_daily_reject,
                "display_good_qty": max(0.0, erp_daily_output - erp_daily_reject),
                "output_source": "erp",
                "reject_source": "erp",
                "good_source": "erp",
                "reconcile_status": "erp_only",
            }
        )

    enriched.sort(key=lambda item: compact_text(item.get("report_date") or ""))
    return enriched, recon


def apply_effective_actuals_to_queue_state(con, block_row) -> bool:
    """Persist ERP/shop effective qty on planner_machine_queue_state for lite board reads."""
    block_id = int(block_row.get("block_id") or 0)
    if block_id <= 0:
        return False

    effective = effective_actual_totals_for_block(con, block_row)
    effective_output = _float(effective.get("effective_output_qty"))
    effective_reject = _float(effective.get("effective_reject_qty"))
    effective_good = _float(effective.get("effective_good_qty"))
    scheduled_qty = _float(block_row.get("scheduled_qty"))
    remaining_qty = max(0.0, scheduled_qty - effective_good)

    result = con.execute(
        """
        UPDATE planner_machine_queue_state
        SET output_qty = %s,
            reject_qty = %s,
            good_qty = %s,
            remaining_qty = %s,
            updated_at = NOW()
        WHERE block_id = %s
        """,
        (effective_output, effective_reject, effective_good, remaining_qty, block_id),
    )
    return bool(getattr(result, "rowcount", 0))


def reconcile_queue_states_after_erp_sync(con=None) -> dict:
    """
    After ERP staging sync, push reconciled ERP/shop output into machine queue state.

    Uses batched pp_vouchers_cache reads (just rebuilt on step 9) so post-sync does not
    hang the UI on hundreds of per-block reconciliation queries.
    """
    from .helpers import planner_db

    updated = 0
    skipped = 0
    errors = 0

    def _run(connection):
        nonlocal updated, skipped, errors
        block_rows = rows(
            connection.execute(
                """
                SELECT b.*, o.source_ps_id, o.source_op_no, o.source_op_seq_id
                FROM planner_run_block b
                JOIN planner_operation o ON o.operation_id = b.operation_id
                JOIN planner_machine_queue_state qs ON qs.block_id = b.block_id
                WHERE COALESCE(b.active, TRUE) = TRUE
                  AND COALESCE(b.machine_id, 0) > 0
                ORDER BY b.block_id
                """
            )
        )
        if not block_rows:
            return

        block_ids = [int(row["block_id"]) for row in block_rows]
        shop_by_block = {
            int(row["block_id"]): row
            for row in rows(
                connection.execute(
                    """
                    SELECT block_id, output_qty, reject_qty, good_qty
                    FROM planner_v_block_actual_totals
                    WHERE block_id = ANY(%s)
                    """,
                    (block_ids,),
                )
            )
        }

        ps_partials = set()
        for block_row in block_rows:
            raw_ps = compact_text(
                block_row.get("source_ps_id") or block_row.get("job_no")
            )
            source_mps_no, pp_partial_no = parse_planner_ps_id(raw_ps)
            if source_mps_no:
                ps_partials.add((source_mps_no, int(pp_partial_no)))

        voucher_rows = []
        if ps_partials:
            ps_ids = sorted({ps for ps, _partial in ps_partials})
            partials = sorted({partial for _ps, partial in ps_partials})
            voucher_rows = rows(
                connection.execute(
                    """
                    SELECT ps_id, pp_partial_no, stage_no, op_no::text AS op_no,
                           COALESCE(wo_qty_produced, 0) AS wo_qty_produced,
                           COALESCE(wo_qty_rejected, 0) AS wo_qty_rejected
                    FROM pp_vouchers_cache
                    WHERE ps_id = ANY(%s)
                      AND pp_partial_no = ANY(%s)
                    """,
                    (ps_ids, partials),
                )
            )

        voucher_index: dict[tuple[str, int], list[dict]] = {}
        for row in voucher_rows:
            ps_id = compact_text(row.get("ps_id"))
            partial_no = int(row.get("pp_partial_no") or 1)
            key = (ps_id, partial_no)
            voucher_index.setdefault(key, []).append(dict(row))
            base_ps, base_partial = parse_planner_ps_id(ps_id)
            if base_ps and base_ps != ps_id:
                voucher_index.setdefault((base_ps, base_partial), []).append(dict(row))

        def _erp_totals_for_block(block_row):
            raw_ps = compact_text(
                block_row.get("source_ps_id") or block_row.get("job_no")
            )
            source_mps_no, pp_partial_no = parse_planner_ps_id(raw_ps)
            if not source_mps_no:
                return 0.0, 0.0
            op_no = compact_text(block_row.get("source_op_no"))
            op_seq_id = int(block_row.get("source_op_seq_id") or 0)
            candidates = _op_no_candidates(op_no, op_seq_id if op_seq_id > 0 else 0)

            best_output = 0.0
            best_reject = 0.0
            for ps_id in _ps_id_candidates(source_mps_no, pp_partial_no):
                for cache_row in voucher_index.get((ps_id, int(pp_partial_no)), []):
                    cache_op = compact_text(cache_row.get("op_no"))
                    stage_no = int(cache_row.get("stage_no") or 0)
                    matched = False
                    if op_no and cache_op and op_no == cache_op:
                        matched = True
                    elif candidates and cache_op in candidates:
                        matched = True
                    elif op_seq_id > 0 and stage_no == op_seq_id:
                        matched = True
                    elif op_seq_id > 0 and cache_op.isdigit() and int(cache_op) == op_seq_id:
                        matched = True
                    if not matched:
                        continue
                    produced = _float(cache_row.get("wo_qty_produced"))
                    rejected = _float(cache_row.get("wo_qty_rejected"))
                    if produced > best_output:
                        best_output = produced
                    if rejected > best_reject:
                        best_reject = rejected
            return best_output, best_reject

        updates = []
        for block_row in block_rows:
            block_id = int(block_row.get("block_id") or 0)
            try:
                shop = shop_by_block.get(block_id) or {}
                shop_output = _float(shop.get("output_qty"))
                shop_reject = _float(shop.get("reject_qty"))
                shop_good = _float(shop.get("good_qty"))
                erp_output, erp_reject = _erp_totals_for_block(block_row)
                erp_good = max(0.0, erp_output - erp_reject)
                effective_output = max(erp_output, shop_output)
                effective_reject = max(erp_reject, shop_reject)
                effective_good = max(erp_good, shop_good)
                scheduled_qty = _float(block_row.get("scheduled_qty"))
                remaining_qty = max(0.0, scheduled_qty - effective_good)
                updates.append(
                    (
                        effective_output,
                        effective_reject,
                        effective_good,
                        remaining_qty,
                        block_id,
                    )
                )
            except Exception:
                errors += 1
                logger.exception(
                    "queue state ERP reconcile failed for block_id=%s",
                    block_id,
                )

        if updates:
            connection.executemany(
                """
                UPDATE planner_machine_queue_state
                SET output_qty = %s,
                    reject_qty = %s,
                    good_qty = %s,
                    remaining_qty = %s,
                    updated_at = NOW()
                WHERE block_id = %s
                """,
                updates,
            )
            updated = len(updates)

    if con is not None:
        _run(con)
    else:
        with planner_db() as connection:
            _run(connection)

    summary = {"updated": updated, "skipped": skipped, "errors": errors}
    logger.info("ERP queue reconcile after sync: %s", summary)
    return summary
