"""ERP work-order qty snapshots and daily reconciliation vs shop actuals."""
from __future__ import annotations

from datetime import date, datetime, timezone

from .helpers import one, rows
from .process_sheets import parse_planner_ps_id
from .utils import compact_text


def ensure_erp_snapshot_table(con) -> None:
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
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_erp_wo_qty_snapshot_lookup
            ON public.planner_erp_wo_qty_snapshot (source_mps_no, pp_partial_no, stage_no, snapshot_date DESC)
        """
    )


def _float(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def erp_wo_key_for_block(con, block_row):
    """Resolve ERP mfg_wo_status key (source_mps_no, pp_partial_no, stage_no) for a run block."""
    if not block_row:
        return None

    raw_ps = compact_text(block_row.get("source_ps_id") or block_row.get("job_no"))
    source_mps_no, pp_partial_no = parse_planner_ps_id(raw_ps)
    if not source_mps_no:
        return None

    stage_no = 0
    op_seq_id = int(block_row.get("source_op_seq_id") or 0)
    if op_seq_id > 0:
        seq = one(
            con.execute(
                """
                SELECT source_stage_no, op_no
                FROM planner_operation_seq
                WHERE op_seq_id = %s
                LIMIT 1
                """,
                (op_seq_id,),
            )
        )
        if seq and seq.get("source_stage_no") is not None:
            stage_no = int(seq["source_stage_no"] or 0)

    if stage_no <= 0:
        op_no = compact_text(block_row.get("source_op_no"))
        if op_no.isdigit():
            stage_no = int(op_no)
        elif op_no.upper().startswith("OP") and op_no[2:].isdigit():
            stage_no = int(op_no[2:])

    if stage_no <= 0:
        cache = one(
            con.execute(
                """
                SELECT stage_no
                FROM pp_vouchers_cache
                WHERE ps_id = %s
                  AND pp_partial_no = %s
                  AND NULLIF(TRIM(COALESCE(op_no, '')), '') = %s
                ORDER BY stage_no
                LIMIT 1
                """,
                (source_mps_no, int(pp_partial_no), compact_text(block_row.get("source_op_no"))),
            )
        )
        if cache:
            stage_no = int(cache.get("stage_no") or 0)

    if stage_no <= 0:
        return None

    return {
        "source_mps_no": source_mps_no,
        "pp_partial_no": int(pp_partial_no),
        "stage_no": int(stage_no),
    }


def record_erp_wo_qty_snapshots(con, mfg_rows, synced_at=None, columns=None) -> int:
    """Upsert one snapshot row per WO stage for the sync calendar day."""
    if not mfg_rows:
        return 0

    ensure_erp_snapshot_table(con)
    when = synced_at or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    snapshot_date = when.astimezone().date()

    saved = 0
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

        con.execute(
            """
            INSERT INTO planner_erp_wo_qty_snapshot (
              source_mps_no, pp_partial_no, stage_no, snapshot_date, snapshot_at,
              acc_qty_produced, acc_rej_qty_produced
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (source_mps_no, pp_partial_no, stage_no, snapshot_date) DO UPDATE SET
              snapshot_at = EXCLUDED.snapshot_at,
              acc_qty_produced = EXCLUDED.acc_qty_produced,
              acc_rej_qty_produced = EXCLUDED.acc_rej_qty_produced
            """,
            (
                source_mps_no,
                pp_partial_no,
                stage_no,
                snapshot_date,
                when,
                _float(row.get("total_acc_qty_produced")),
                _float(row.get("total_rej_qty_produced")),
            ),
        )
        saved += 1
    return saved


def _snapshots_for_key(con, key):
    if not key:
        return []
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
            (key["source_mps_no"], key["pp_partial_no"], key["stage_no"]),
        )
    )
    return live


def _erp_totals_from_voucher_cache(con, key):
    if not key:
        return None
    return one(
        con.execute(
            """
            SELECT COALESCE(MAX(wo_qty_produced), 0) AS acc_qty_produced,
                   COALESCE(MAX(wo_qty_rejected), 0) AS acc_rej_qty_produced,
                   MAX(_loaded_at) AS loaded_at
            FROM pp_vouchers_cache
            WHERE ps_id = %s
              AND pp_partial_no = %s
              AND stage_no = %s
            """,
            (key["source_mps_no"], key["pp_partial_no"], key["stage_no"]),
        )
    )


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
    from .actuals import actual_totals_for_block

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


def erp_reconciliation_for_block(con, block_row):
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

    from .actuals import actual_totals_for_block

    block_id = int(block_row.get("block_id") or 0)
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

    return {
        "linked": True,
        "source_mps_no": key["source_mps_no"],
        "pp_partial_no": key["pp_partial_no"],
        "stage_no": key["stage_no"],
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


def enrich_actual_daily_rows_with_erp(con, block_row, daily_rows):
    recon = erp_reconciliation_for_block(con, block_row)
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
