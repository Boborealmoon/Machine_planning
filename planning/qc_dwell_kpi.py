"""Days a job stayed at QC, measured from the QAQC Pushed to QC stamp.

The stamp is planner_deburr_qc_push.pushed_at (Deburring qty increase).
The clock stops at the first Packing / Engraving & Packing scan after that
stamp. Jobs still in Final Inspection keep counting through now.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from planning.erp_wo_merge import (
    finishing_final_inspection_sql_match,
    finishing_pack_stage_sql_match,
    finishing_stage_bucket,
)
from planning.helpers import rows
from planning.utils import PLANNER_TZ, compact_text, planner_wall_datetime_to_api, sheet_category

QC_STATE_IN = "in_qc"
QC_STATE_LEFT = "left_qc"
QC_STATE_UNSTAMPED = "left_unstamped"
QC_STATE_BEFORE = "before_qc"

QC_STATE_LABELS = {
    QC_STATE_IN: "In QC",
    QC_STATE_LEFT: "Left QC",
    QC_STATE_UNSTAMPED: "Left QC (time not recorded)",
    QC_STATE_BEFORE: "Still at Deburring",
}

_STATUS_LABELS = {
    "I": "In Process",
    "IN_PROCESS": "In Process",
    "R": "Ready to Start",
    "READY_TO_START": "Ready to Start",
    "P": "Pending SI",
    "PENDING_SI": "Pending SI",
    "C": "Completed",
    "COMPLETED": "Completed",
}


def execution_status_label(code: Any) -> str:
    text = compact_text(code).upper()
    if not text:
        return ""
    return _STATUS_LABELS.get(text, text)


def _as_sg(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=PLANNER_TZ)
        return value.astimezone(PLANNER_TZ)
    text = planner_wall_datetime_to_api(value)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=PLANNER_TZ)
    except ValueError:
        return None


def _as_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return _as_sg(value).date()
    if isinstance(value, date):
        return value
    text = compact_text(value)
    if len(text) >= 10:
        try:
            return datetime.strptime(text[:10], "%Y-%m-%d").date()
        except ValueError:
            return None
    return None


def _json_number(value: Any) -> float | int | None:
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        value = float(value)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number.is_integer():
        return int(number)
    return round(number, 4)


def qc_elapsed(start: datetime, end: datetime) -> dict[str, Any]:
    """Elapsed stay. days_at_qc is decimal days (24h), rounded to 2 places."""
    seconds = max(0.0, (end - start).total_seconds())
    whole_days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    minutes = int((seconds % 3600) // 60)
    if whole_days > 0:
        label = f"{whole_days}d {hours}h"
    elif hours > 0:
        label = f"{hours}h {minutes}m"
    else:
        label = f"{minutes}m"
    return {
        "days_at_qc": round(seconds / 86400, 2),
        "elapsed_label": label,
    }


def classify_qc_stay(
    *,
    current_stage_desc: Any,
    pushed_at: datetime,
    left_at: datetime | None,
    now: datetime,
) -> dict[str, Any]:
    """How long this job has been, or was, at QC.

    Final Inspection is still in QC, so the clock runs to ``now`` even if a
    later pack scan was recorded. A pack scan ends the stay only after the
    job has left Final Inspection.
    """
    bucket = finishing_stage_bucket(compact_text(current_stage_desc))
    if bucket == "final_inspection":
        elapsed = qc_elapsed(pushed_at, now)
        return {
            "qc_state": QC_STATE_IN,
            "left_at": None,
            "left_stage_desc": "",
            **elapsed,
        }
    if bucket == "deburring":
        return {
            "qc_state": QC_STATE_BEFORE,
            "left_at": None,
            "left_stage_desc": "",
            "days_at_qc": None,
            "elapsed_label": "",
        }
    if left_at is not None and left_at >= pushed_at:
        elapsed = qc_elapsed(pushed_at, left_at)
        return {
            "qc_state": QC_STATE_LEFT,
            "left_at": left_at,
            "left_stage_desc": "",
            **elapsed,
        }
    return {
        "qc_state": QC_STATE_UNSTAMPED,
        "left_at": None,
        "left_stage_desc": "",
        "days_at_qc": None,
        "elapsed_label": "",
    }


def include_qc_dwell_row(
    pushed_at: datetime,
    qc_state: str,
    *,
    from_date: date | None,
    to_date: date | None,
    include_open: bool,
) -> bool:
    """Date window is on the Pushed to QC day (Singapore).

    Jobs still in Final Inspection stay in the result when include_open is
    set, even if the stamp is outside the window.
    """
    pushed_day = pushed_at.astimezone(PLANNER_TZ).date()
    in_window = True
    if from_date is not None and pushed_day < from_date:
        in_window = False
    if to_date is not None and pushed_day > to_date:
        in_window = False
    if in_window:
        return True
    return bool(include_open and qc_state == QC_STATE_IN)


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return round(ordered[mid], 2)
    return round((ordered[mid - 1] + ordered[mid]) / 2, 2)


def _matches_query(row: dict[str, Any], query: str) -> bool:
    needle = compact_text(query).casefold()
    if not needle:
        return True
    haystack = " ".join(
        compact_text(row.get(key))
        for key in (
            "ps_id",
            "part_no",
            "part_desc",
            "sales_order_no",
            "customer_name",
            "customer_code",
            "current_stage_desc",
            "inspector_name",
            "qc_state_label",
        )
    ).casefold()
    return needle in haystack


def summarize_qc_dwell(rows_in: list[dict[str, Any]]) -> dict[str, Any]:
    in_days = [
        float(row["days_at_qc"])
        for row in rows_in
        if row.get("qc_state") == QC_STATE_IN and row.get("days_at_qc") is not None
    ]
    left_days = [
        float(row["days_at_qc"])
        for row in rows_in
        if row.get("qc_state") == QC_STATE_LEFT and row.get("days_at_qc") is not None
    ]
    return {
        "job_count": len(rows_in),
        "in_qc": sum(1 for row in rows_in if row.get("qc_state") == QC_STATE_IN),
        "left_qc": sum(1 for row in rows_in if row.get("qc_state") == QC_STATE_LEFT),
        "left_unstamped": sum(1 for row in rows_in if row.get("qc_state") == QC_STATE_UNSTAMPED),
        "before_qc": sum(1 for row in rows_in if row.get("qc_state") == QC_STATE_BEFORE),
        "avg_days_in_qc": _mean(in_days),
        "avg_days_left": _mean(left_days),
        "median_days_left": _median(left_days),
        "in_qc_3d": sum(1 for days in in_days if days >= 3),
        "in_qc_7d": sum(1 for days in in_days if days >= 7),
    }


def _sort_rows(rows_in: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def _key(row: dict[str, Any]):
        days = row.get("days_at_qc")
        return (
            days is None,
            -(float(days) if days is not None else 0.0),
            0 if row.get("qc_state") == QC_STATE_IN else 1,
            compact_text(row.get("ps_id")),
        )

    return sorted(rows_in, key=_key)


def build_qc_dwell_report(
    raw_rows: list[dict[str, Any]],
    *,
    now: datetime | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    include_open: bool = True,
    status: str = "all",
    query: str = "",
    min_days: float | None = None,
) -> dict[str, Any]:
    clock = now or datetime.now(PLANNER_TZ)
    if clock.tzinfo is None:
        clock = clock.replace(tzinfo=PLANNER_TZ)
    else:
        clock = clock.astimezone(PLANNER_TZ)

    status_filter = compact_text(status).lower() or "all"
    built: list[dict[str, Any]] = []
    for raw in raw_rows or []:
        pushed = _as_sg(raw.get("pushed_at"))
        if pushed is None:
            continue
        left = _as_sg(raw.get("left_at"))
        stay = classify_qc_stay(
            current_stage_desc=raw.get("current_stage_desc"),
            pushed_at=pushed,
            left_at=left,
            now=clock,
        )
        if not include_qc_dwell_row(
            pushed,
            stay["qc_state"],
            from_date=from_date,
            to_date=to_date,
            include_open=include_open,
        ):
            continue
        if status_filter not in ("", "all") and stay["qc_state"] != status_filter:
            continue
        days = stay.get("days_at_qc")
        if min_days is not None and (days is None or float(days) < float(min_days)):
            continue
        left_stage = compact_text(raw.get("left_stage_desc")) if stay["qc_state"] == QC_STATE_LEFT else ""
        partial = raw.get("pp_partial_no")
        try:
            partial_no = int(partial or 1)
        except (TypeError, ValueError):
            partial_no = 1
        row = {
            "ps_id": compact_text(raw.get("ps_id")),
            "ps_type": sheet_category(raw.get("ps_id")),
            "pp_partial_no": partial_no,
            "part_no": compact_text(raw.get("part_no")),
            "part_desc": compact_text(raw.get("part_desc")),
            "sales_order_no": compact_text(raw.get("sales_order_no")),
            "customer_name": compact_text(raw.get("customer_name")),
            "customer_code": compact_text(raw.get("customer_code")),
            "qty": _json_number(raw.get("qty")),
            "due_date": _as_date(raw.get("due_date")).isoformat() if _as_date(raw.get("due_date")) else "",
            "current_stage_desc": compact_text(raw.get("current_stage_desc")),
            "current_stage_status": compact_text(raw.get("current_stage_status")),
            "stage_status_label": execution_status_label(raw.get("current_stage_status")),
            "pushed_at": planner_wall_datetime_to_api(pushed),
            "left_at": planner_wall_datetime_to_api(stay["left_at"]) if stay.get("left_at") else "",
            "left_stage_desc": left_stage,
            "qc_state": stay["qc_state"],
            "qc_state_label": QC_STATE_LABELS.get(stay["qc_state"], stay["qc_state"]),
            "days_at_qc": stay.get("days_at_qc"),
            "elapsed_label": stay.get("elapsed_label") or "",
            "inspector_name": compact_text(raw.get("inspector_name")),
            "qty_jump": _json_number(raw.get("qty_jump")),
        }
        if not _matches_query(row, query):
            continue
        built.append(row)

    ordered = _sort_rows(built)
    return {
        "ok": True,
        "generated_at": planner_wall_datetime_to_api(clock),
        "count": len(ordered),
        "summary": summarize_qc_dwell(ordered),
        "rows": ordered,
    }


def qc_dwell_sql() -> str:
    """One row per Deburring qty-jump stamp, with the first later pack scan."""
    pack_match = finishing_pack_stage_sql_match("j.stage_desc")
    final_insp = finishing_final_inspection_sql_match(
        "TRIM(COALESCE(cur.current_stage_desc, ''))"
    )
    return f"""
SELECT
    p.source_mps_no AS ps_id,
    p.pp_partial_no,
    p.pushed_at,
    p.qty_jump,
    cache.part_no,
    cache.part_desc,
    cache.sales_order_no,
    cache.due_date,
    cache.qty,
    COALESCE(soh.customer_name, '') AS customer_name,
    COALESCE(NULLIF(BTRIM(soh.customer_code), ''), NULLIF(BTRIM(hdr.customer_code), ''), '') AS customer_code,
    cur.current_stage_desc,
    cur.current_stage_status,
    exit_scan.left_at,
    exit_scan.left_stage_desc,
    insp.inspector_name
FROM planner_deburr_qc_push p
LEFT JOIN LATERAL (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.part_no,
        c.description AS part_desc,
        c.source_voucher_no AS sales_order_no,
        c.due_date,
        COALESCE(NULLIF(c.partial_qty, 0), c.total_qty) AS qty
    FROM pp_vouchers_cache c
    WHERE c.ps_id = p.source_mps_no
      AND c.pp_partial_no = p.pp_partial_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
) cache ON TRUE
LEFT JOIN so_order_header soh
       ON soh.sales_order_no = cache.sales_order_no
LEFT JOIN pp_voucher_hdr hdr
       ON hdr.pp_voucher_no = p.source_mps_no
LEFT JOIN LATERAL (
    SELECT DISTINCT ON (ws.source_mps_no, ws.pp_partial_no)
        TRIM(COALESCE(ws.stage_desc, '')) AS current_stage_desc,
        ws.execution_status AS current_stage_status
    FROM mfg_wo_status ws
    WHERE ws.source_mps_no = p.source_mps_no
      AND ws.pp_partial_no = p.pp_partial_no
      AND ws.execution_status IS NOT NULL
      AND ws.execution_status <> ''
      AND ws.execution_status NOT IN ('C', 'Completed')
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
) cur ON TRUE
LEFT JOIN LATERAL (
    SELECT j.scanned_at AS left_at,
           TRIM(COALESCE(j.stage_desc, '')) AS left_stage_desc
    FROM planner_erp_qty_jump j
    WHERE j.source_mps_no = p.source_mps_no
      AND j.pp_partial_no = p.pp_partial_no
      AND j.scanned_at >= p.pushed_at
      AND {pack_match}
    ORDER BY j.scanned_at ASC
    LIMIT 1
) exit_scan ON TRUE
LEFT JOIN LATERAL (
    SELECT i.name AS inspector_name
    FROM planner_finishing_queue_overlay o
    LEFT JOIN planner_finishing_queue_inspector i
           ON i.inspector_id = o.inspector_id
    WHERE o.ps_id = p.source_mps_no
      AND o.pp_partial_no = p.pp_partial_no
    ORDER BY
        CASE
            WHEN TRIM(COALESCE(o.stage_desc, '')) ILIKE 'Final Insp%%'
              OR TRIM(COALESCE(o.stage_desc, '')) ILIKE 'Final Ispection%%'
            THEN 0 ELSE 1
        END,
        (i.name IS NULL OR BTRIM(i.name) = ''),
        o.updated_at DESC
    LIMIT 1
) insp ON TRUE
WHERE p.source = 'qty_jump'
  AND p.pushed_at IS NOT NULL
  AND (
        (
            (%s::date IS NULL OR (p.pushed_at AT TIME ZONE 'Asia/Singapore')::date >= %s::date)
            AND (%s::date IS NULL OR (p.pushed_at AT TIME ZONE 'Asia/Singapore')::date <= %s::date)
        )
        OR (
            %s::boolean
            AND ({final_insp})
        )
      )
ORDER BY p.pushed_at DESC
"""


def fetch_qc_dwell_rows(
    con,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    include_open: bool = True,
) -> list[dict[str, Any]]:
    params = (from_date, from_date, to_date, to_date, bool(include_open))
    return rows(con.execute(qc_dwell_sql(), params))

