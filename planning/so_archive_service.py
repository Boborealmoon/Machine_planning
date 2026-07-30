"""SO Line Archive - shape New Orders grain into Power Query column order + PS buckets."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .sales_report_alloc import ps_type_from_process_sheet
from .utils import compact_text

# Matches the Power Query Table.ReorderColumns list (snake_case keys).
ARCHIVE_COLUMNS: tuple[str, ...] = (
    "source_voucher_no",
    "source_voucher_line_item_no",
    "process_sheet_no",
    "inventory_code",
    "main_desc",
    "po_due_date",
    "qty",
    "customer_po_no",
    "customer_po_line_item_no",
    "status",
    "qty_issued",
    "invoice_no",
    "invoice_line_item_no",
    "shipment_voucher_no",
    "unit_selling_price",
    "line_item_description",
    "arrival_date",
    "exch_rate",
    "do_no",
    "do_generation_datetime",
    "proposed_edd",
    "reference_no",
    "sales_order_date",
    "customer_code",
    "total_home_amt",
)

_KNOWN_PS = frozenset({"MPS", "APS", "NPS", "PPS", "CPS", "SR"})
PS_BUCKETS = ("APS", "NPS", "OTHER")


def resolve_process_sheet_no(row: dict[str, Any]) -> str:
    """Prefer process_sheet_no, then pp_voucher_no (new-orders alias)."""
    return compact_text(
        row.get("process_sheet_no")
        or row.get("pp_voucher_no")
        or ""
    )


def ps_bucket(process_sheet_no: Any) -> str:
    """Map a process sheet to APS, NPS, or OTHER (MPS/PPS/CPS/SR/blank)."""
    ps_type = ps_type_from_process_sheet(process_sheet_no)
    if ps_type == "APS":
        return "APS"
    if ps_type == "NPS":
        return "NPS"
    return "OTHER"


def row_ps_bucket(row: dict[str, Any]) -> str:
    return ps_bucket(resolve_process_sheet_no(row))


def _iso_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = compact_text(value)
    if not text:
        return None
    return text[:10] if len(text) >= 10 and text[4] == "-" else text


def shape_archive_row(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize a new-orders-style row into the archive column set."""
    process_sheet = resolve_process_sheet_no(row)
    main_desc = compact_text(row.get("main_desc") or row.get("part_desc"))
    sales_order_date = (
        _iso_date(row.get("sales_order_date"))
        or _iso_date(row.get("order_date"))
        or _iso_date(row.get("first_posted_datetime"))
    )
    bucket = ps_bucket(process_sheet)
    shaped = {
        "source_voucher_no": compact_text(row.get("source_voucher_no")),
        "source_voucher_line_item_no": compact_text(row.get("source_voucher_line_item_no")),
        "process_sheet_no": process_sheet,
        "inventory_code": compact_text(row.get("inventory_code")),
        "main_desc": main_desc,
        "po_due_date": _iso_date(row.get("po_due_date") or row.get("due_date")),
        "qty": row.get("qty"),
        "customer_po_no": compact_text(row.get("customer_po_no")),
        "customer_po_line_item_no": compact_text(row.get("customer_po_line_item_no")),
        "status": compact_text(row.get("status")) or "Open",
        "qty_issued": row.get("qty_issued") if row.get("qty_issued") is not None else 0,
        "invoice_no": compact_text(row.get("invoice_no")),
        "invoice_line_item_no": compact_text(row.get("invoice_line_item_no")),
        "shipment_voucher_no": compact_text(row.get("shipment_voucher_no")),
        "unit_selling_price": row.get("unit_selling_price"),
        "line_item_description": compact_text(row.get("line_item_description")),
        "arrival_date": _iso_date(row.get("arrival_date")),
        "exch_rate": row.get("exch_rate"),
        "do_no": compact_text(row.get("do_no")),
        "do_generation_datetime": compact_text(row.get("do_generation_datetime")),
        "proposed_edd": _iso_date(row.get("proposed_edd")),
        "reference_no": compact_text(row.get("reference_no")),
        "sales_order_date": sales_order_date,
        "customer_code": compact_text(row.get("customer_code")),
        "total_home_amt": row.get("total_home_amt"),
        "ps_type": ps_type_from_process_sheet(process_sheet),
        "ps_bucket": bucket,
        "first_posted_datetime": compact_text(row.get("first_posted_datetime")),
    }
    return shaped


def shape_archive_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [shape_archive_row(row) for row in rows if compact_text(row.get("source_voucher_no"))]


def filter_by_bucket(rows: list[dict[str, Any]], bucket: str | None) -> list[dict[str, Any]]:
    key = compact_text(bucket).upper()
    if not key or key == "ALL":
        return list(rows)
    if key not in PS_BUCKETS:
        return list(rows)
    return [row for row in rows if row_ps_bucket(row) == key]


def filter_by_buckets(
    rows: list[dict[str, Any]],
    buckets: set[str] | list[str] | None,
) -> list[dict[str, Any]]:
    """Keep rows whose resolved PS prefix bucket is in buckets.

    Empty / missing process sheets are OTHER (never APS/NPS).
    MPS / PPS / CPS / SR always map to OTHER.
    """
    if not buckets:
        return list(rows)
    wanted = {compact_text(b).upper() for b in buckets if compact_text(b)}
    wanted.discard("")
    if not wanted or wanted >= set(PS_BUCKETS):
        return list(rows)
    return [row for row in rows if row_ps_bucket(row) in wanted]


def group_rows_by_sales_order(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group archive lines by sales order, newest first."""
    order: list[str] = []
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        so_no = compact_text(row.get("source_voucher_no"))
        if not so_no:
            continue
        if so_no not in groups:
            order.append(so_no)
            groups[so_no] = {
                "source_voucher_no": so_no,
                "customer_code": compact_text(row.get("customer_code")),
                "customer_po_no": compact_text(row.get("customer_po_no")),
                "reference_no": compact_text(row.get("reference_no")),
                "sales_order_date": row.get("sales_order_date"),
                "first_posted_datetime": row.get("first_posted_datetime"),
                "line_count": 0,
                "open_count": 0,
                "buckets": set(),
                "lines": [],
            }
        group = groups[so_no]
        group["lines"].append(row)
        group["line_count"] += 1
        status = compact_text(row.get("status")).lower()
        if status in ("", "open"):
            group["open_count"] += 1
        bucket = compact_text(row.get("ps_bucket")).upper() or "OTHER"
        group["buckets"].add(bucket)
        if not group.get("customer_code") and row.get("customer_code"):
            group["customer_code"] = compact_text(row.get("customer_code"))
        if not group.get("customer_po_no") and row.get("customer_po_no"):
            group["customer_po_no"] = compact_text(row.get("customer_po_no"))
        if not group.get("reference_no") and row.get("reference_no"):
            group["reference_no"] = compact_text(row.get("reference_no"))
        posted = compact_text(row.get("first_posted_datetime"))
        if posted and (
            not group.get("first_posted_datetime")
            or posted > compact_text(group.get("first_posted_datetime"))
        ):
            group["first_posted_datetime"] = posted

    result: list[dict[str, Any]] = []
    for so_no in order:
        group = groups[so_no]
        buckets = sorted(group.pop("buckets"))
        group["buckets"] = buckets
        group["ps_bucket"] = buckets[0] if len(buckets) == 1 else "MIXED"
        result.append(group)

    result.sort(
        key=lambda g: (
            compact_text(g.get("first_posted_datetime")) or "",
            compact_text(g.get("source_voucher_no")),
        ),
        reverse=True,
    )
    return result


def build_recent_notifications(
    rows: list[dict[str, Any]],
    *,
    bucket: str | None = None,
    buckets: set[str] | list[str] | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Last N newly posted sales orders for the active PS bucket filter."""
    if buckets is not None:
        wanted = {compact_text(b).upper() for b in buckets if compact_text(b)}
        filtered = filter_by_buckets(rows, buckets)
    else:
        wanted = {compact_text(bucket).upper()} if compact_text(bucket) else set()
        filtered = filter_by_bucket(rows, bucket)
    groups = group_rows_by_sales_order(filtered)
    notifications: list[dict[str, Any]] = []
    for group in groups[: max(0, int(limit))]:
        sample = {}
        for line in group.get("lines") or []:
            ps = resolve_process_sheet_no(line)
            if not ps:
                continue
            if wanted and wanted < set(PS_BUCKETS) and row_ps_bucket(line) not in wanted:
                continue
            sample = line
            break
        if not sample:
            continue
        notifications.append(
            {
                "source_voucher_no": group["source_voucher_no"],
                "process_sheet_no": resolve_process_sheet_no(sample),
                "inventory_code": compact_text(sample.get("inventory_code")),
                "main_desc": compact_text(sample.get("main_desc")),
                "ps_bucket": row_ps_bucket(sample),
                "sample_part": compact_text(sample.get("inventory_code")),
                "sample_desc": compact_text(sample.get("main_desc")),
            }
        )
    return notifications


def bucket_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {key: 0 for key in PS_BUCKETS}
    counts["ALL"] = len(rows)
    for row in rows:
        key = compact_text(row.get("ps_bucket")).upper() or "OTHER"
        if key not in counts:
            key = "OTHER"
        counts[key] = counts.get(key, 0) + 1
    return counts
