"""New-part deliveries on the on-time delivery page, frozen at month end.

A process sheet is NEW when that part has no other process sheet on a
different sales order. That is the same rule as the NEW badge on sales
orders. The label changes as soon as a repeat order is raised, so each
closed month is written once to Supabase and later reads use that copy.
"""
from __future__ import annotations

import calendar
import logging
import os
import sys
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any, Callable

from .helpers import one, planner_db, rows
from .on_time_delivery import classify_process_sheets
from .sales_report_analytics import parse_date_value
from .utils import compact_text

logger = logging.getLogger(__name__)

_HISTORY_TTL_SEC = 60
_history_cache: tuple[float, dict[str, list[dict[str, str]]]] | None = None
_snapshot_lock = threading.Lock()
_loop_started = False

_HISTORY_SQL = """
SELECT
    TRIM(COALESCE(ps.inventory_code, pp.inventory_code)) AS part_no,
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS ps_base,
    pp.pp_voucher_no AS pp_voucher_no,
    pp.source_voucher_no AS sales_order_no
FROM public.mfg_pp_vch pp
LEFT JOIN public.mfg_process_sheet_info_v1_view ps
       ON ps.pp_voucher_no = pp.pp_voucher_no
WHERE COALESCE(NULLIF(TRIM(COALESCE(ps.inventory_code, pp.inventory_code)), ''), '') <> ''
"""


def _ps_base(value: Any) -> str:
    return compact_text(value).split("::")[0]


def load_part_ps_history(*, refresh: bool = False) -> dict[str, list[dict[str, str]]]:
    """part number -> process sheets ever raised for it."""
    global _history_cache
    now = time.time()
    cached = _history_cache
    if not refresh and cached and now - cached[0] < _HISTORY_TTL_SEC:
        return cached[1]

    from .staged_erp import live_query

    grouped: dict[str, list[dict[str, str]]] = {}
    seen: dict[str, set[str]] = {}
    for raw in live_query(_HISTORY_SQL):
        part_no = compact_text(raw.get("part_no"))
        ps_base = _ps_base(raw.get("ps_base"))
        voucher = _ps_base(raw.get("pp_voucher_no"))
        sales_order_no = compact_text(raw.get("sales_order_no"))
        if not part_no or not (ps_base or voucher):
            continue
        key = voucher or ps_base
        part_seen = seen.setdefault(part_no, set())
        if key in part_seen:
            continue
        part_seen.add(key)
        grouped.setdefault(part_no, []).append(
            {
                "ps_base": ps_base,
                "pp_voucher_no": voucher,
                "sales_order_no": sales_order_no,
            }
        )
    _history_cache = (now, grouped)
    return grouped


def _same_sheet(entry: dict[str, str], voucher: str) -> bool:
    return bool(voucher) and voucher in {entry.get("ps_base"), entry.get("pp_voucher_no")}


def flag_new_process_sheets(
    sheet_rows: list[dict[str, Any]],
    *,
    history: dict[str, list[dict[str, str]]] | None = None,
    strict: bool = False,
) -> list[dict[str, Any]]:
    """Set ``is_new_part`` on each classified process sheet."""
    if history is None:
        try:
            history = load_part_ps_history()
        except Exception:
            if strict:
                raise
            logger.exception("new-part history lookup failed")
            for row in sheet_rows:
                row["is_new_part"] = False
            return sheet_rows

    for row in sheet_rows:
        part_no = compact_text(row.get("inventory_code"))
        voucher = _ps_base(row.get("pp_voucher_no") or row.get("process_sheet_no"))
        sales_order_no = compact_text(row.get("sales_order_no"))
        if not part_no or not voucher:
            row["is_new_part"] = False
            continue
        others = [
            entry
            for entry in history.get(part_no, [])
            if not _same_sheet(entry, voucher)
            and compact_text(entry.get("sales_order_no")) != sales_order_no
        ]
        row["is_new_part"] = not others
    return sheet_rows


def previous_closed_month(today: date) -> tuple[int, int]:
    last_day = today.replace(day=1) - timedelta(days=1)
    return last_day.year, last_day.month


def _delivery(row: dict[str, Any]) -> date | None:
    parsed = parse_date_value(row.get("delivery_date"))
    if isinstance(parsed, datetime):
        return parsed.date()
    return parsed if isinstance(parsed, date) else None


def delivered_in_month(
    sheet_rows: list[dict[str, Any]],
    *,
    year: int,
    month: int,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in sheet_rows:
        delivery = _delivery(row)
        if delivery is not None and delivery.year == year and delivery.month == month:
            out.append(row)
    return out


def _sheet_record(row: dict[str, Any]) -> dict[str, Any]:
    delivery = _delivery(row)
    po_due = parse_date_value(row.get("po_due_date"))
    if isinstance(po_due, datetime):
        po_due = po_due.date()
    return {
        "process_sheet_no": compact_text(row.get("process_sheet_no") or row.get("pp_voucher_no")),
        "pp_type": compact_text(row.get("pp_type")),
        "sales_order_no": compact_text(row.get("sales_order_no")),
        "inventory_code": compact_text(row.get("inventory_code")),
        "description": compact_text(row.get("description")),
        "customer_name": compact_text(row.get("customer_name") or row.get("customer_code")),
        "sales_person_name": compact_text(row.get("sales_person_name") or row.get("sales_person_code")),
        "delivery_date": delivery.isoformat() if isinstance(delivery, date) else None,
        "po_due_date": po_due.isoformat() if isinstance(po_due, date) else None,
        "status": compact_text(row.get("status")),
    }


def build_month_snapshot(
    sheet_rows: list[dict[str, Any]],
    *,
    year: int,
    month: int,
) -> dict[str, Any]:
    delivered = delivered_in_month(sheet_rows, year=year, month=month)
    new_sheets = [_sheet_record(row) for row in delivered if row.get("is_new_part")]
    new_sheets.sort(key=lambda item: item["process_sheet_no"])
    return {
        "year": year,
        "month": month,
        "new_part_count": len(new_sheets),
        "delivered_count": len(delivered),
        "sheets": new_sheets,
    }


def ensure_snapshot_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_otd_new_part_month (
            year              INT         NOT NULL,
            month             INT         NOT NULL,
            new_part_count    INT         NOT NULL,
            delivered_count   INT         NOT NULL,
            snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (year, month)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_otd_new_part_snapshot (
            year               INT         NOT NULL,
            month              INT         NOT NULL,
            process_sheet_no   TEXT        NOT NULL,
            pp_type            TEXT        NOT NULL DEFAULT '',
            sales_order_no     TEXT        NOT NULL DEFAULT '',
            inventory_code     TEXT        NOT NULL DEFAULT '',
            description        TEXT        NOT NULL DEFAULT '',
            customer_name      TEXT        NOT NULL DEFAULT '',
            sales_person_name  TEXT        NOT NULL DEFAULT '',
            delivery_date      DATE,
            po_due_date        DATE,
            status             TEXT        NOT NULL DEFAULT '',
            snapshotted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (year, month, process_sheet_no)
        )
        """
    )


def month_snapshot_exists(con, year: int, month: int) -> bool:
    found = one(
        con.execute(
            """
            SELECT year
            FROM public.planner_otd_new_part_month
            WHERE year = %s AND month = %s
            """,
            (year, month),
        )
    )
    return found is not None


def save_month_snapshot(con, snapshot: dict[str, Any]) -> None:
    year = int(snapshot["year"])
    month = int(snapshot["month"])
    con.execute(
        """
        INSERT INTO public.planner_otd_new_part_month (
            year, month, new_part_count, delivered_count
        ) VALUES (%s, %s, %s, %s)
        """,
        (year, month, int(snapshot["new_part_count"]), int(snapshot["delivered_count"])),
    )
    sheets = snapshot.get("sheets") or []
    if not sheets:
        return
    con.execute_values(
        """
        INSERT INTO public.planner_otd_new_part_snapshot (
            year, month, process_sheet_no, pp_type, sales_order_no,
            inventory_code, description, customer_name, sales_person_name,
            delivery_date, po_due_date, status
        ) VALUES %s
        """,
        [
            (
                year,
                month,
                item["process_sheet_no"],
                item.get("pp_type") or "",
                item.get("sales_order_no") or "",
                item.get("inventory_code") or "",
                item.get("description") or "",
                item.get("customer_name") or "",
                item.get("sales_person_name") or "",
                item.get("delivery_date"),
                item.get("po_due_date"),
                item.get("status") or "",
            )
            for item in sheets
        ],
    )


def _default_fetch(year: int) -> list[dict[str, Any]]:
    from .on_time_delivery_route import _fetch_delivered_process_sheets

    raw_rows = _fetch_delivered_process_sheets(year, refresh=True)
    classified = classify_process_sheets(raw_rows)
    history = load_part_ps_history(refresh=True)
    if classified and not history:
        raise RuntimeError("new-part history lookup returned no process sheets")
    return flag_new_process_sheets(classified, history=history)


def snapshot_previous_month_if_due(
    *,
    today: date | None = None,
    fetch_classified: Callable[[int], list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Write the previous calendar month once. Skip it if a row already exists."""
    today = today or date.today()
    year, month = previous_closed_month(today)
    with _snapshot_lock:
        with planner_db() as con:
            ensure_snapshot_tables(con)
            if month_snapshot_exists(con, year, month):
                return {"ok": True, "skipped": True, "year": year, "month": month}
        fetch = fetch_classified or _default_fetch
        classified = fetch(year)
        snapshot = build_month_snapshot(classified, year=year, month=month)
        with planner_db() as con:
            ensure_snapshot_tables(con)
            if month_snapshot_exists(con, year, month):
                return {"ok": True, "skipped": True, "year": year, "month": month}
            save_month_snapshot(con, snapshot)
    logger.info(
        "on-time delivery new parts snapshotted %s-%02d: %s new of %s delivered",
        year,
        month,
        snapshot["new_part_count"],
        snapshot["delivered_count"],
    )
    return {"ok": True, "skipped": False, **snapshot}


def saved_late(year: int, month: int, snapshotted_at: datetime | date | None) -> bool:
    if snapshotted_at is None:
        return False
    saved = snapshotted_at.date() if isinstance(snapshotted_at, datetime) else snapshotted_at
    last = date(year, month, calendar.monthrange(year, month)[1])
    return (saved - last).days > 3


def list_new_part_history() -> list[dict[str, Any]]:
    with planner_db() as con:
        ensure_snapshot_tables(con)
        headers = rows(
            con.execute(
                """
                SELECT year, month, new_part_count, delivered_count, snapshotted_at
                FROM public.planner_otd_new_part_month
                ORDER BY year DESC, month DESC
                """
            )
        )
        lines = rows(
            con.execute(
                """
                SELECT
                    year, month, process_sheet_no, pp_type, sales_order_no,
                    inventory_code, description, customer_name, sales_person_name,
                    delivery_date, po_due_date, status
                FROM public.planner_otd_new_part_snapshot
                ORDER BY year DESC, month DESC, process_sheet_no
                """
            )
        )
    by_month: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for line in lines:
        delivery = line.get("delivery_date")
        po_due = line.get("po_due_date")
        by_month.setdefault((int(line["year"]), int(line["month"])), []).append(
            {
                "process_sheet_no": line.get("process_sheet_no") or "",
                "pp_type": line.get("pp_type") or "",
                "sales_order_no": line.get("sales_order_no") or "",
                "inventory_code": line.get("inventory_code") or "",
                "description": line.get("description") or "",
                "customer_name": line.get("customer_name") or "",
                "sales_person_name": line.get("sales_person_name") or "",
                "delivery_date": delivery.isoformat() if isinstance(delivery, date) else (delivery or ""),
                "po_due_date": po_due.isoformat() if isinstance(po_due, date) else (po_due or ""),
                "status": line.get("status") or "",
            }
        )
    out: list[dict[str, Any]] = []
    for header in headers:
        year = int(header["year"])
        month = int(header["month"])
        snapshotted_at = header.get("snapshotted_at")
        out.append(
            {
                "year": year,
                "month": month,
                "label": f"{calendar.month_abbr[month]} {year}",
                "new_part_count": int(header["new_part_count"] or 0),
                "delivered_count": int(header["delivered_count"] or 0),
                "snapshotted_at": snapshotted_at.isoformat() if isinstance(snapshotted_at, datetime) else None,
                "saved_late": saved_late(year, month, snapshotted_at),
                "sheets": by_month.get((year, month), []),
            }
        )
    return out


def _snapshot_loop() -> None:
    time.sleep(45)
    while True:
        try:
            snapshot_previous_month_if_due()
        except Exception:
            logger.exception("on-time delivery month-end snapshot failed")
        time.sleep(6 * 60 * 60)


def start_month_end_snapshot_loop() -> None:
    """Freeze the previous month while the web process is running."""
    global _loop_started
    if _loop_started:
        return
    if os.environ.get("WERKZEUG_RUN_MAIN") == "false":
        return
    if os.environ.get("OTD_DISABLE_SNAPSHOT_LOOP", "").strip().lower() in {"1", "true", "yes", "on"}:
        return
    if "pytest" in sys.modules or any("pytest" in arg for arg in sys.argv):
        return
    _loop_started = True
    threading.Thread(target=_snapshot_loop, daemon=True, name="otd-month-snapshot").start()
