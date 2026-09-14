"""On-time delivery for process sheets - PO due date vs last delivery date.

One classified row per process sheet (PP voucher). Dates match Sales Orders:
PO due = SO required shipment date (fallback PP source RSD); delivery = last
shipment date on that SO line. On time = last delivery on or before PO due.
Month charts always follow the delivery date. Component child COMP sheets are
excluded. Incomplete SO lines are excluded until qty is fully shipped.
"""
from __future__ import annotations

import calendar
from datetime import date
from typing import Any, Iterable

from .assembly_classify import is_component_child_ps
from .sales_report_alloc import ps_type_from_process_sheet, so_line_key
from .sales_report_analytics import OTIF_BUCKETS, PP_TYPES, parse_date_value
from .utils import compact_text, shipped_quantity_completed

MONTH_LABELS = tuple(calendar.month_abbr[i] for i in range(1, 13))

STATUS_EARLY = "early"
STATUS_ON_TIME = "on_time"
STATUS_LATE = "late"
STATUS_UNCLASSIFIED = "unclassified"
ON_TIME_STATUSES = frozenset({STATUS_EARLY, STATUS_ON_TIME})
BLANK_SALESPERSON = "(blank)"
PPS_OVERVIEW_SALESPERSON = "alice"

OVERVIEW_SECTIONS = (
    {
        "id": "aps",
        "label": "APS",
        "pp_types": ("APS",),
        "sales_person_contains": None,
        "subtitle": "All sales people",
    },
    {
        "id": "nps",
        "label": "NPS",
        "pp_types": ("NPS",),
        "sales_person_contains": None,
        "subtitle": "All sales people",
    },
    {
        "id": "pps",
        "label": "PPS",
        "pp_types": ("PPS",),
        "sales_person_contains": PPS_OVERVIEW_SALESPERSON,
        "subtitle": "Alice only",
    },
)


def pp_type_label(pp_type: str | None) -> str:
    text = compact_text(pp_type)
    if text == "SR":
        return "[SR]"
    return text or "-"


def salesperson_key(row: dict[str, Any]) -> str:
    name = compact_text(row.get("sales_person_name"))
    if name:
        return name.lower()
    code = compact_text(row.get("sales_person_code"))
    if code:
        return code.lower()
    return BLANK_SALESPERSON


def salesperson_label(row: dict[str, Any]) -> str:
    name = compact_text(row.get("sales_person_name"))
    code = compact_text(row.get("sales_person_code"))
    if name and code and name != code:
        return f"{name} ({code})"
    return name or code or "(Blank)"


def salesperson_matches(row: dict[str, Any], needle: str | None) -> bool:
    text = compact_text(needle).lower()
    if not text:
        return True
    hay = " ".join(
        [
            compact_text(row.get("sales_person_name")),
            compact_text(row.get("sales_person_code")),
            salesperson_key(row),
        ]
    ).lower()
    return text in hay


def list_salespeople(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, str]] = {}
    for row in rows:
        key = salesperson_key(row)
        if key in seen:
            continue
        seen[key] = {
            "id": key,
            "code": compact_text(row.get("sales_person_code")),
            "name": compact_text(row.get("sales_person_name")),
            "label": salesperson_label(row),
        }
    return sorted(
        seen.values(),
        key=lambda item: (item["id"] == BLANK_SALESPERSON, item["label"].lower()),
    )


def _otif_bucket_id(days: int) -> str:
    for bucket_id, _label, lo, hi in OTIF_BUCKETS:
        if lo is not None and days < lo:
            continue
        if hi is not None and days > hi:
            continue
        return bucket_id
    return "ge_31"


def _float_field(row: dict[str, Any], *fields: str) -> float:
    for field in fields:
        if row.get(field) is None or row.get(field) == "":
            continue
        try:
            return float(row[field] or 0)
        except (TypeError, ValueError):
            continue
    return 0.0


def _po_due_date(row: dict[str, Any]) -> date | None:
    """SO required shipment date / PP source RSD - not PP production or EDD."""
    return (
        parse_date_value(row.get("po_due_date"))
        or parse_date_value(row.get("due_date"))
        or parse_date_value(row.get("so_due_date"))
        or parse_date_value(row.get("source_rsd"))
    )


def _delivery_date(row: dict[str, Any]) -> date | None:
    return parse_date_value(row.get("delivery_date")) or parse_date_value(
        row.get("last_shipment_date")
    )


def process_sheet_key(row: dict[str, Any]) -> str:
    voucher = compact_text(row.get("pp_voucher_no"))
    if voucher:
        return voucher
    ps = compact_text(row.get("process_sheet_no"))
    if ps:
        return ps
    so, line = so_line_key(row.get("sales_order_no"), row.get("line_item_no") or row.get("source_line_item_no"))
    if so:
        return f"{so}::{line}" if line else so
    return ""


def _row_pp_type(row: dict[str, Any]) -> str | None:
    explicit = compact_text(row.get("pp_type"))
    if explicit:
        return explicit
    return ps_type_from_process_sheet(row.get("process_sheet_no") or row.get("pp_voucher_no"))


def _status_from_days(days: int | None) -> str:
    if days is None:
        return STATUS_UNCLASSIFIED
    if days < 0:
        return STATUS_EARLY
    if days == 0:
        return STATUS_ON_TIME
    return STATUS_LATE


def _line_completed(row: dict[str, Any]) -> bool:
    total = row.get("so_det_qty")
    if total is None or total == "":
        total = row.get("so_qty")
    shipped = row.get("qty_shipped")
    if shipped is None or shipped == "":
        shipped = row.get("so_line_qty_shipped")
    if total is None or total == "":
        return bool(_delivery_date(row))
    return shipped_quantity_completed(total, shipped)


def classify_process_sheets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One OTD row per process sheet using PO due vs last delivery columns."""
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = process_sheet_key(row)
        if not key:
            continue
        display_ps = compact_text(row.get("process_sheet_no")) or key
        if is_component_child_ps(display_ps) or is_component_child_ps(key):
            continue
        if not _line_completed(row):
            continue
        po_due = _po_due_date(row)
        delivery = _delivery_date(row)
        if po_due is None or delivery is None:
            continue
        so, line = so_line_key(
            row.get("sales_order_no") or row.get("source_voucher_no"),
            row.get("line_item_no") or row.get("source_line_item_no"),
        )
        grouped[key] = {
            "process_sheet_no": display_ps,
            "pp_voucher_no": compact_text(row.get("pp_voucher_no")) or key,
            "pp_type": _row_pp_type(row),
            "sales_order_no": so,
            "line_item_no": line,
            "inventory_code": compact_text(row.get("inventory_code")),
            "description": compact_text(row.get("description") or row.get("part_desc")),
            "customer_code": compact_text(row.get("customer_code")),
            "customer_name": compact_text(row.get("customer_name")),
            "sales_person_code": compact_text(row.get("sales_person_code")),
            "sales_person_name": compact_text(row.get("sales_person_name")),
            "po_due_date": po_due,
            "delivery_date": delivery,
            "qty": _float_field(row, "pp_qty", "qty", "qty_issued"),
            "value": _float_field(row, "amount", "value", "total_home_amt", "line_value_home"),
            "shipment_count": 1,
        }

    out: list[dict[str, Any]] = []
    for bucket in grouped.values():
        po_due = bucket["po_due_date"]
        delivery = bucket["delivery_date"]
        days = (delivery - po_due).days
        status = _status_from_days(days)
        out.append(
            {
                **bucket,
                "pp_type_label": pp_type_label(bucket["pp_type"]),
                "po_due_date": po_due.isoformat(),
                "delivery_date": delivery.isoformat(),
                "days": days,
                "status": status,
                "on_time": status in ON_TIME_STATUSES,
                "qty": round(bucket["qty"], 4),
                "value": round(bucket["value"], 2),
            }
        )
    out.sort(key=lambda item: (item.get("delivery_date") or "", item.get("process_sheet_no") or ""))
    return out


# Older name kept for imports that still collapse shipment events into sheets.
collapse_to_process_sheets = classify_process_sheets


def filter_process_sheets(
    rows: list[dict[str, Any]],
    *,
    year: int,
    pp_types: Iterable[str] | None,
    sales_persons: Iterable[str] | None = None,
    sales_person_contains: str | None = None,
) -> list[dict[str, Any]]:
    selected = {compact_text(item) for item in (pp_types or []) if compact_text(item)}
    all_selected = not selected or selected.issuperset(PP_TYPES)
    selected_people = {
        compact_text(item).lower() for item in (sales_persons or []) if compact_text(item)
    }
    out: list[dict[str, Any]] = []
    for row in rows:
        pp_type = compact_text(row.get("pp_type"))
        if not all_selected and (not pp_type or pp_type not in selected):
            continue
        if selected_people and salesperson_key(row) not in selected_people:
            continue
        if not salesperson_matches(row, sales_person_contains):
            continue
        delivery = parse_date_value(row.get("delivery_date"))
        if delivery is None or delivery.year != year:
            continue
        item = dict(row)
        item["month"] = delivery.month
        item["sales_person_label"] = salesperson_label(row)
        out.append(item)
    return out


def _empty_month_row(month: int) -> dict[str, Any]:
    return {
        "month": month,
        "label": MONTH_LABELS[month - 1],
        "early": 0,
        "on_time": 0,
        "late": 0,
        "unclassified": 0,
        "classified": 0,
        "on_time_rate": 0.0,
        "avg_days": None,
        "avg_late_days": None,
    }


def _empty_ps_row(pp_type: str) -> dict[str, Any]:
    return {
        "id": pp_type,
        "label": pp_type_label(pp_type),
        "early": 0,
        "on_time": 0,
        "late": 0,
        "unclassified": 0,
        "classified": 0,
        "on_time_rate": 0.0,
        "avg_days": None,
    }


def _apply_status_count(target: dict[str, Any], status: str) -> None:
    if status == STATUS_EARLY:
        target["early"] = int(target.get("early") or 0) + 1
        target["classified"] = int(target.get("classified") or 0) + 1
    elif status == STATUS_ON_TIME:
        target["on_time"] = int(target.get("on_time") or 0) + 1
        target["classified"] = int(target.get("classified") or 0) + 1
    elif status == STATUS_LATE:
        target["late"] = int(target.get("late") or 0) + 1
        target["classified"] = int(target.get("classified") or 0) + 1
    else:
        target["unclassified"] = int(target.get("unclassified") or 0) + 1


def _finalize_counts(target: dict[str, Any], days_values: list[int], late_days: list[int]) -> None:
    classified = int(target.get("classified") or 0)
    on_time = int(target.get("early") or 0) + int(target.get("on_time") or 0)
    target["on_time_rate"] = round(on_time / classified, 4) if classified else 0.0
    if days_values:
        target["avg_days"] = round(sum(days_values) / len(days_values), 1)
    if late_days:
        target["avg_late_days"] = round(sum(late_days) / len(late_days), 1)


def days_histogram(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {bucket_id: 0 for bucket_id, _label, _lo, _hi in OTIF_BUCKETS}
    skipped = 0
    on_time = 0
    for row in rows:
        days = row.get("days")
        if days is None:
            skipped += 1
            continue
        try:
            day_count = int(days)
        except (TypeError, ValueError):
            skipped += 1
            continue
        counts[_otif_bucket_id(day_count)] += 1
        if day_count <= 0:
            on_time += 1
    classified = sum(counts.values())
    return {
        "buckets": [
            {"id": bucket_id, "label": label, "count": counts[bucket_id]}
            for bucket_id, label, _lo, _hi in OTIF_BUCKETS
        ],
        "classified": classified,
        "skipped": skipped,
        "on_time": on_time,
        "on_time_rate": round(on_time / classified, 4) if classified else 0.0,
    }


def aggregate_on_time_delivery(
    rows: list[dict[str, Any]],
    *,
    year: int,
    pp_types: Iterable[str] | None,
    sales_persons: Iterable[str] | None = None,
    sales_person_contains: str | None = None,
    collapsed: list[dict[str, Any]] | None = None,
    include_source_rows: bool = True,
) -> dict[str, Any]:
    source_rows = collapsed if collapsed is not None else classify_process_sheets(rows)
    sheets = filter_process_sheets(
        source_rows,
        year=year,
        pp_types=pp_types,
        sales_persons=sales_persons,
        sales_person_contains=sales_person_contains,
    )
    selected = [compact_text(item) for item in (pp_types or PP_TYPES) if compact_text(item)]
    if not selected or set(selected).issuperset(PP_TYPES):
        selected = list(PP_TYPES)

    months = [_empty_month_row(month) for month in range(1, 13)]
    month_days: list[list[int]] = [[] for _ in range(12)]
    month_late_days: list[list[int]] = [[] for _ in range(12)]
    by_ps = {pp_type: _empty_ps_row(pp_type) for pp_type in selected}
    ps_days: dict[str, list[int]] = {pp_type: [] for pp_type in selected}
    month_ps = [
        {
            "month": month,
            "label": MONTH_LABELS[month - 1],
            "series": {
                pp_type: {"early": 0, "on_time": 0, "late": 0, "classified": 0, "on_time_rate": 0.0}
                for pp_type in selected
            },
        }
        for month in range(1, 13)
    ]

    summary = {
        "early": 0,
        "on_time": 0,
        "late": 0,
        "unclassified": 0,
        "classified": 0,
        "on_time_rate": 0.0,
        "avg_days": None,
        "avg_late_days": None,
        "qty": 0.0,
        "value": 0.0,
        "process_sheet_count": len(sheets),
    }
    all_days: list[int] = []
    late_days: list[int] = []

    for row in sheets:
        status = compact_text(row.get("status")) or STATUS_UNCLASSIFIED
        month = int(row.get("month") or 0)
        pp_type = compact_text(row.get("pp_type"))
        days = row.get("days")
        _apply_status_count(summary, status)
        summary["qty"] += float(row.get("qty") or 0)
        summary["value"] += float(row.get("value") or 0)
        if isinstance(days, int):
            all_days.append(days)
            if days > 0:
                late_days.append(days)
        if 1 <= month <= 12:
            month_row = months[month - 1]
            _apply_status_count(month_row, status)
            if isinstance(days, int):
                month_days[month - 1].append(days)
                if days > 0:
                    month_late_days[month - 1].append(days)
            if pp_type in month_ps[month - 1]["series"]:
                series = month_ps[month - 1]["series"][pp_type]
                _apply_status_count(series, status)
        if pp_type in by_ps:
            _apply_status_count(by_ps[pp_type], status)
            if isinstance(days, int):
                ps_days[pp_type].append(days)

    _finalize_counts(summary, all_days, late_days)
    summary["qty"] = round(summary["qty"], 4)
    summary["value"] = round(summary["value"], 2)
    for idx, month_row in enumerate(months):
        _finalize_counts(month_row, month_days[idx], month_late_days[idx])
    for pp_type, ps_row in by_ps.items():
        _finalize_counts(ps_row, ps_days[pp_type], [])
    for month_block in month_ps:
        for series in month_block["series"].values():
            classified = int(series.get("classified") or 0)
            on_time = int(series.get("early") or 0) + int(series.get("on_time") or 0)
            series["on_time_rate"] = round(on_time / classified, 4) if classified else 0.0

    payload = {
        "year": year,
        "pp_types": selected,
        "sales_persons": [
            compact_text(item).lower() for item in (sales_persons or []) if compact_text(item)
        ],
        "sales_person_contains": compact_text(sales_person_contains).lower() or None,
        "salespeople": list_salespeople(source_rows),
        "summary": summary,
        "by_month": months,
        "by_ps": [by_ps[pp_type] for pp_type in selected],
        "by_month_ps": month_ps,
        "histogram": days_histogram(sheets),
        "rows": sheets,
    }
    if include_source_rows:
        payload["source_rows"] = source_rows
    return payload


def build_overview_sections(
    classified: list[dict[str, Any]],
    *,
    year: int,
) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for spec in OVERVIEW_SECTIONS:
        payload = aggregate_on_time_delivery(
            [],
            year=year,
            pp_types=spec["pp_types"],
            sales_person_contains=spec["sales_person_contains"],
            collapsed=classified,
            include_source_rows=False,
        )
        sections.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "subtitle": spec["subtitle"],
                "pp_types": list(spec["pp_types"]),
                "sales_person_contains": spec["sales_person_contains"],
                "summary": payload["summary"],
                "by_month": payload["by_month"],
                "by_ps": payload["by_ps"],
                "by_month_ps": payload["by_month_ps"],
                "histogram": payload["histogram"],
                "rows": payload["rows"],
            }
        )
    return sections
