"""Client-side sales-report chart aggregations (no extra ERP queries).

Used by Archive visual-analytics tests; the page JS mirrors these formulas
against GET /api/sales-report/ytd.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable

from .sales_report_alloc import ps_type_from_process_sheet
from .utils import compact_text

PP_TYPES = ("MPS", "APS", "NPS", "PPS", "CPS", "SR")

OTIF_BUCKETS: tuple[tuple[str, str, int | None, int | None], ...] = (
    ("le_neg_14", "<=-14", None, -14),
    ("neg_13_1", "-13 to -1", -13, -1),
    ("on_time", "0", 0, 0),
    ("d1_7", "1-7", 1, 7),
    ("d8_14", "8-14", 8, 14),
    ("d15_30", "15-30", 15, 30),
    ("ge_31", "31+", 31, None),
)

PARETO_TOP_N = 8


def parse_date_value(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = compact_text(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")[:19]).date()
    except ValueError:
        pass
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def row_pp_type(row: dict[str, Any]) -> str | None:
    explicit = compact_text(row.get("pp_type"))
    if explicit:
        return explicit
    return ps_type_from_process_sheet(row.get("process_sheet_no"))


def open_value(row: dict[str, Any]) -> float:
    try:
        if row.get("allocated_remaining_value") is not None:
            return float(row["allocated_remaining_value"] or 0)
        return float(row.get("remaining_value") or 0)
    except (TypeError, ValueError):
        return 0.0


def money_field(row: dict[str, Any], field: str) -> float:
    try:
        return float(row.get(field) or 0)
    except (TypeError, ValueError):
        return 0.0


def passes_pp_filter(row: dict[str, Any], pp_types: Iterable[str] | None) -> bool:
    selected = {compact_text(item) for item in (pp_types or []) if compact_text(item)}
    if not selected:
        return False
    if selected.issuperset(PP_TYPES):
        return True
    pp_type = row_pp_type(row)
    return bool(pp_type) and pp_type in selected


def _sum_selected_grid_rows(grid: dict[str, Any], pp_types: Iterable[str] | None) -> list[dict[str, Any]]:
    selected = {compact_text(item) for item in (pp_types or []) if compact_text(item)}
    rows = [row for row in (grid.get("rows") or []) if compact_text(row.get("id")) in selected]
    months = grid.get("months") or []
    if not rows:
        return [{"month": meta.get("month"), "mode": meta.get("mode")} for meta in months]
    merged: list[dict[str, Any]] = []
    for idx, meta in enumerate(months):
        cell: dict[str, Any] = {"month": meta.get("month"), "mode": meta.get("mode")}
        keys = (
            "sales",
            "backlog_delivered",
            "delivered",
            "early_delivered",
            "backlog",
            "on_hand",
            "due_this_month",
        )
        for key in keys:
            total = 0.0
            for row in rows:
                cells = row.get("cells") or []
                piece = cells[idx] if idx < len(cells) else {}
                total += money_field(piece, key)
            cell[key] = total
        merged.append(cell)
    return merged


def composition_from_grid(
    grid: dict[str, Any],
    pp_types: Iterable[str] | None,
    *,
    posted_basis: bool = False,
) -> list[dict[str, Any]]:
    """One stack per month from YTD grid cells for the selected PP types."""
    months = grid.get("months") or []
    cells = _sum_selected_grid_rows(grid, pp_types)
    out: list[dict[str, Any]] = []
    for meta, cell in zip(months, cells):
        mode = compact_text(meta.get("mode") or cell.get("mode"))
        label = compact_text(meta.get("label")) or f"M{meta.get('month')}"
        if mode == "past":
            if posted_basis:
                sales = money_field(cell, "sales")
                if sales == 0:
                    sales = (
                        money_field(cell, "backlog_delivered")
                        + money_field(cell, "delivered")
                        + money_field(cell, "early_delivered")
                    )
                series = {"sales": sales}
            else:
                series = {
                    "backlog_delivered": money_field(cell, "backlog_delivered"),
                    "delivered": money_field(cell, "delivered"),
                    "early_delivered": money_field(cell, "early_delivered"),
                }
        elif meta.get("is_current") and not posted_basis:
            series = {
                "backlog": money_field(cell, "backlog"),
                "on_hand": money_field(cell, "on_hand") or money_field(cell, "due_this_month"),
            }
        else:
            series = {
                "due_this_month": money_field(cell, "due_this_month") or money_field(cell, "on_hand"),
            }
        out.append(
            {
                "month": int(meta.get("month") or 0),
                "label": label,
                "mode": mode,
                "is_current": bool(meta.get("is_current")),
                "series": series,
                "total": round(sum(series.values()), 2),
            }
        )
    return out


def mix_by_pp_type(open_lines: list[dict[str, Any]], pp_types: Iterable[str] | None) -> list[dict[str, Any]]:
    totals: dict[str, float] = {pp_type: 0.0 for pp_type in PP_TYPES}
    for row in open_lines:
        if not passes_pp_filter(row, pp_types):
            continue
        pp_type = row_pp_type(row)
        if pp_type in totals:
            totals[pp_type] += open_value(row)
    grand = sum(totals.values())
    return [
        {
            "id": pp_type,
            "label": "[SR]" if pp_type == "SR" else pp_type,
            "value": round(totals[pp_type], 2),
            "share": round(totals[pp_type] / grand, 4) if grand else 0.0,
        }
        for pp_type in PP_TYPES
        if totals[pp_type] > 0.009
    ]


def _customer_key(row: dict[str, Any]) -> str:
    return compact_text(row.get("customer_code")).lower() or compact_text(row.get("customer_name")).lower() or "__blank__"


def _customer_label(row: dict[str, Any]) -> str:
    name = compact_text(row.get("customer_name"))
    code = compact_text(row.get("customer_code"))
    if name and code and name != code:
        return f"{name} ({code})"
    return name or code or "(Blank)"


def customer_pareto(
    open_lines: list[dict[str, Any]],
    pp_types: Iterable[str] | None,
    *,
    top_n: int = PARETO_TOP_N,
) -> dict[str, Any]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in open_lines:
        if not passes_pp_filter(row, pp_types):
            continue
        key = _customer_key(row)
        bucket = grouped.get(key)
        if bucket is None:
            bucket = {"key": key, "label": _customer_label(row), "value": 0.0}
            grouped[key] = bucket
        bucket["value"] += open_value(row)
    ranked = sorted(grouped.values(), key=lambda item: item["value"], reverse=True)
    grand = sum(item["value"] for item in ranked)
    head = ranked[:top_n]
    tail = ranked[top_n:]
    items: list[dict[str, Any]] = [
        {**item, "value": round(item["value"], 2)} for item in head
    ]
    if tail:
        items.append(
            {
                "key": "__other__",
                "label": f"Other ({len(tail)})",
                "value": round(sum(item["value"] for item in tail), 2),
            }
        )
    running = 0.0
    for item in items:
        running += item["value"]
        item["share"] = round(item["value"] / grand, 4) if grand else 0.0
        item["cumulative"] = round(running / grand, 4) if grand else 0.0
    return {"total": round(grand, 2), "items": items, "customer_count": len(ranked)}


def _otif_bucket_id(days: int) -> str:
    for bucket_id, _label, lo, hi in OTIF_BUCKETS:
        if lo is not None and days < lo:
            continue
        if hi is not None and days > hi:
            continue
        return bucket_id
    return "ge_31"


def shipment_po_due(row: dict[str, Any]) -> date | None:
    """Original SO/PO due, not the PP partial schedule date."""
    return parse_date_value(row.get("so_due_date")) or parse_date_value(row.get("due_date"))


def otif_histogram(
    shipments: list[dict[str, Any]],
    pp_types: Iterable[str] | None,
) -> dict[str, Any]:
    counts = {bucket_id: 0 for bucket_id, _label, _lo, _hi in OTIF_BUCKETS}
    skipped = 0
    on_time = 0
    for row in shipments:
        if not passes_pp_filter(row, pp_types):
            continue
        ship = parse_date_value(row.get("shipment_date") or row.get("shipment_datetime"))
        due = shipment_po_due(row)
        if ship is None or due is None:
            skipped += 1
            continue
        days = (ship - due).days
        bucket_id = _otif_bucket_id(days)
        counts[bucket_id] += 1
        if days <= 0:
            on_time += 1
    classified = sum(counts.values())
    buckets = [
        {
            "id": bucket_id,
            "label": label,
            "count": counts[bucket_id],
        }
        for bucket_id, label, _lo, _hi in OTIF_BUCKETS
    ]
    return {
        "buckets": buckets,
        "classified": classified,
        "skipped": skipped,
        "on_time": on_time,
        "on_time_rate": round(on_time / classified, 4) if classified else 0.0,
    }
