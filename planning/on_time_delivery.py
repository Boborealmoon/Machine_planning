"""On-time delivery for process sheets - PO due date vs last delivery date.

One classified row per process sheet. On time = last delivery on or before the
original SO/PO due date (not the PP partial schedule date).
"""
from __future__ import annotations

import calendar
from datetime import date
from typing import Any, Iterable

from .sales_report_alloc import ps_type_from_process_sheet, so_line_key
from .sales_report_analytics import (
    OTIF_BUCKETS,
    PP_TYPES,
    parse_date_value,
    shipment_po_due,
)
from .utils import compact_text

MONTH_BASIS_DELIVERY = "delivery"
MONTH_BASIS_PO_DUE = "po_due"
MONTH_LABELS = tuple(calendar.month_abbr[i] for i in range(1, 13))

STATUS_EARLY = "early"
STATUS_ON_TIME = "on_time"
STATUS_LATE = "late"
STATUS_UNCLASSIFIED = "unclassified"
ON_TIME_STATUSES = frozenset({STATUS_EARLY, STATUS_ON_TIME})
BLANK_SALESPERSON = "(blank)"


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


def parse_month_basis(value: Any) -> str:
    text = compact_text(value).lower()
    if text in {MONTH_BASIS_PO_DUE, "po_due_date", "due"}:
        return MONTH_BASIS_PO_DUE
    return MONTH_BASIS_DELIVERY


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


def _shipment_date(row: dict[str, Any]) -> date | None:
    return parse_date_value(row.get("shipment_date") or row.get("shipment_datetime") or row.get("delivery_date"))


def process_sheet_key(row: dict[str, Any]) -> str:
    ps = compact_text(row.get("process_sheet_no"))
    if ps:
        return ps
    voucher = compact_text(row.get("pp_voucher_no"))
    if voucher:
        return voucher
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


def collapse_to_process_sheets(shipments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Last delivery vs original PO due, one row per process sheet."""
    grouped: dict[str, dict[str, Any]] = {}
    for row in shipments:
        key = process_sheet_key(row)
        if not key:
            continue
        po_due = shipment_po_due(row)
        delivery = _shipment_date(row)
        qty = _float_field(row, "qty_issued", "pp_qty")
        value = _float_field(row, "total_home_amt", "line_value_home")
        bucket = grouped.get(key)
        if bucket is None:
            so, line = so_line_key(
                row.get("sales_order_no"),
                row.get("line_item_no") or row.get("source_line_item_no"),
            )
            bucket = {
                "process_sheet_no": compact_text(row.get("process_sheet_no")) or key,
                "pp_voucher_no": compact_text(row.get("pp_voucher_no")),
                "pp_type": _row_pp_type(row),
                "sales_order_no": so,
                "line_item_no": line,
                "inventory_code": compact_text(row.get("inventory_code")),
                "description": compact_text(row.get("description")),
                "customer_code": compact_text(row.get("customer_code")),
                "customer_name": compact_text(row.get("customer_name")),
                "sales_person_code": compact_text(row.get("sales_person_code")),
                "sales_person_name": compact_text(row.get("sales_person_name")),
                "po_due_date": po_due,
                "delivery_date": delivery,
                "qty": 0.0,
                "value": 0.0,
                "shipment_count": 0,
            }
            grouped[key] = bucket
        else:
            if not bucket["pp_type"]:
                bucket["pp_type"] = _row_pp_type(row)
            if not bucket["sales_order_no"]:
                so, line = so_line_key(
                    row.get("sales_order_no"),
                    row.get("line_item_no") or row.get("source_line_item_no"),
                )
                bucket["sales_order_no"] = so
                bucket["line_item_no"] = line
            for field in (
                "inventory_code",
                "description",
                "customer_code",
                "customer_name",
                "pp_voucher_no",
                "sales_person_code",
                "sales_person_name",
            ):
                if not bucket[field]:
                    bucket[field] = compact_text(row.get(field))
        bucket["qty"] += qty
        bucket["value"] += value
        bucket["shipment_count"] += 1
        if po_due is not None and (bucket["po_due_date"] is None or po_due < bucket["po_due_date"]):
            bucket["po_due_date"] = po_due
        if delivery is not None and (bucket["delivery_date"] is None or delivery > bucket["delivery_date"]):
            bucket["delivery_date"] = delivery

    out: list[dict[str, Any]] = []
    for bucket in grouped.values():
        po_due = bucket["po_due_date"]
        delivery = bucket["delivery_date"]
        days = (delivery - po_due).days if po_due and delivery else None
        status = _status_from_days(days)
        out.append(
            {
                **bucket,
                "pp_type_label": pp_type_label(bucket["pp_type"]),
                "po_due_date": po_due.isoformat() if po_due else None,
                "delivery_date": delivery.isoformat() if delivery else None,
                "days": days,
                "status": status,
                "on_time": status in ON_TIME_STATUSES,
                "qty": round(bucket["qty"], 4),
                "value": round(bucket["value"], 2),
            }
        )
    out.sort(key=lambda item: (item.get("delivery_date") or "", item.get("process_sheet_no") or ""))
    return out


def _anchor_date(row: dict[str, Any], month_basis: str) -> date | None:
    if month_basis == MONTH_BASIS_PO_DUE:
        return parse_date_value(row.get("po_due_date"))
    return parse_date_value(row.get("delivery_date"))


def filter_process_sheets(
    rows: list[dict[str, Any]],
    *,
    year: int,
    pp_types: Iterable[str] | None,
    month_basis: str,
    sales_persons: Iterable[str] | None = None,
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
        anchor = _anchor_date(row, month_basis)
        if anchor is None or anchor.year != year:
            continue
        item = dict(row)
        item["month"] = anchor.month
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
    shipments: list[dict[str, Any]],
    *,
    year: int,
    pp_types: Iterable[str] | None,
    month_basis: str = MONTH_BASIS_DELIVERY,
    sales_persons: Iterable[str] | None = None,
    collapsed: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    basis = parse_month_basis(month_basis)
    source_rows = collapsed if collapsed is not None else collapse_to_process_sheets(shipments)
    sheets = filter_process_sheets(
        source_rows,
        year=year,
        pp_types=pp_types,
        month_basis=basis,
        sales_persons=sales_persons,
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

    return {
        "year": year,
        "month_basis": basis,
        "pp_types": selected,
        "sales_persons": [
            compact_text(item).lower() for item in (sales_persons or []) if compact_text(item)
        ],
        "salespeople": list_salespeople(source_rows),
        "source_rows": source_rows,
        "summary": summary,
        "by_month": months,
        "by_ps": [by_ps[pp_type] for pp_type in selected],
        "by_month_ps": month_ps,
        "histogram": days_histogram(sheets),
        "rows": sheets,
    }
