"""Job ratio report — volume bucket mix by booked SO lines."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .sales_report_alloc import ps_type_from_process_sheet
from .utils import compact_text

BUCKET_TARGETS = {"proto": 20.0, "micro": 30.0, "low": 50.0}

BUCKET_LABELS = {
    "proto": "Proto-type (1–10 pcs)",
    "micro": "Micro-Batch",
    "low": "Low Volume",
}

# (min_inclusive, max_inclusive); None max = no upper bound
_VOLUME_BUCKETS: dict[int, tuple[tuple[str, int, int | None], ...]] = {
    2025: (
        ("proto", 1, 10),
        ("micro", 11, 50),
        ("low", 51, None),
    ),
    2026: (
        ("proto", 1, 10),
        ("micro", 11, 30),
        ("low", 31, None),
    ),
}

_DEFAULT_BUCKET_YEAR = 2026
_BUCKET_ORDER = ("proto", "micro", "low")


def volume_bucket_rules(year: int) -> tuple[tuple[str, int, int | None], ...]:
    if year in _VOLUME_BUCKETS:
        return _VOLUME_BUCKETS[year]
    return _VOLUME_BUCKETS[_DEFAULT_BUCKET_YEAR]


def bucket_label(bucket_id: str, year: int) -> str:
    rules = {bid: (lo, hi) for bid, lo, hi in volume_bucket_rules(year)}
    if bucket_id == "proto":
        lo, hi = rules["proto"]
        return f"Proto-type ({lo}–{hi} pcs)"
    if bucket_id == "micro":
        lo, hi = rules["micro"]
        return f"Micro-Batch ({lo}–{hi} pcs)"
    if bucket_id == "low":
        lo, _ = rules["low"]
        return f"Low Volume (Above {lo - 1} pcs)"
    return bucket_id


def classify_volume_bucket(qty: Any, year: int) -> str | None:
    try:
        value = float(qty)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    qty_int = int(round(value))
    for bucket_id, lo, hi in volume_bucket_rules(year):
        if qty_int < lo:
            continue
        if hi is None or qty_int <= hi:
            return bucket_id
    return None


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


def filter_rows_by_pp_types(
    rows: list[dict[str, Any]],
    pp_types: set[str] | frozenset[str],
    *,
    all_selected: bool = False,
    include_untyped: bool = True,
) -> list[dict[str, Any]]:
    if all_selected:
        return list(rows)
    if not pp_types:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        pp_type = row_pp_type(row)
        if pp_type is None:
            if include_untyped:
                out.append(row)
            continue
        if pp_type in pp_types:
            out.append(row)
    return out


def enrich_booked_row(row: dict[str, Any], year: int) -> dict[str, Any]:
    posted = parse_date_value(row.get("first_posted_datetime"))
    qty = row.get("qty")
    try:
        line_amount = float(row.get("line_amount") or 0)
    except (TypeError, ValueError):
        line_amount = 0.0
    bucket = classify_volume_bucket(qty, year)
    return {
        **row,
        "pp_type": row_pp_type(row),
        "volume_bucket": bucket,
        "booked_month": posted.month if posted else None,
        "booked_year": posted.year if posted else None,
        "booked_date": posted.isoformat() if posted else None,
        "line_amount": line_amount,
    }


def _empty_bucket_stats() -> dict[str, Any]:
    return {"count": 0, "value": 0.0, "count_pct": 0.0, "value_pct": 0.0}


def _bucket_stats(count: int, value: float, total_count: int, total_value: float) -> dict[str, Any]:
    count_pct = (count / total_count * 100.0) if total_count else 0.0
    value_pct = (value / total_value * 100.0) if total_value else 0.0
    return {
        "count": count,
        "value": value,
        "count_pct": round(count_pct, 1),
        "value_pct": round(value_pct, 1),
    }


def _apply_targets(bucket_stats: dict[str, dict[str, Any]]) -> None:
    for bucket_id, target in BUCKET_TARGETS.items():
        stats = bucket_stats.get(bucket_id) or _empty_bucket_stats()
        stats["count_target"] = target
        stats["value_target"] = target
        stats["count_ok"] = stats.get("count_pct", 0) >= target
        stats["value_ok"] = stats.get("value_pct", 0) >= target
        bucket_stats[bucket_id] = stats


def aggregate_month_bucket(rows: list[dict[str, Any]], year: int) -> dict[str, Any]:
    months: dict[int, dict[str, Any]] = {}
    ytd_counts = {bid: 0 for bid in _BUCKET_ORDER}
    ytd_values = {bid: 0.0 for bid in _BUCKET_ORDER}
    ytd_total_count = 0
    ytd_total_value = 0.0

    for month in range(1, 13):
        month_rows = [
            row for row in rows
            if row.get("booked_year") == year and row.get("booked_month") == month and row.get("volume_bucket")
        ]
        bucket_counts = {bid: 0 for bid in _BUCKET_ORDER}
        bucket_values = {bid: 0.0 for bid in _BUCKET_ORDER}
        for row in month_rows:
            bid = row["volume_bucket"]
            bucket_counts[bid] += 1
            bucket_values[bid] += float(row.get("line_amount") or 0)

        total_count = sum(bucket_counts.values())
        total_value = sum(bucket_values.values())
        buckets: dict[str, Any] = {}
        for bid in _BUCKET_ORDER:
            buckets[bid] = _bucket_stats(
                bucket_counts[bid],
                bucket_values[bid],
                total_count,
                total_value,
            )
            ytd_counts[bid] += bucket_counts[bid]
            ytd_values[bid] += bucket_values[bid]
        ytd_total_count += total_count
        ytd_total_value += total_value
        _apply_targets(buckets)
        months[month] = {
            "month": month,
            "label": date(year, month, 1).strftime("%b-%y"),
            "buckets": buckets,
            "total": {"count": total_count, "value": total_value},
        }

    ytd_buckets: dict[str, Any] = {}
    for bid in _BUCKET_ORDER:
        ytd_buckets[bid] = _bucket_stats(
            ytd_counts[bid],
            ytd_values[bid],
            ytd_total_count,
            ytd_total_value,
        )
    _apply_targets(ytd_buckets)

    return {
        "months": [months[m] for m in range(1, 13)],
        "ytd": {
            "buckets": ytd_buckets,
            "total": {"count": ytd_total_count, "value": ytd_total_value},
        },
    }


def aggregate_customer_rows(rows: list[dict[str, Any]], year: int) -> list[dict[str, Any]]:
    by_customer: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("booked_year") != year or not row.get("volume_bucket"):
            continue
        code = compact_text(row.get("customer_code")) or "—"
        name = compact_text(row.get("customer_name")) or code
        key = code
        entry = by_customer.setdefault(
            key,
            {
                "customer_code": code,
                "customer_name": name,
                "total_qty": 0.0,
                "bucket_counts": {bid: 0 for bid in _BUCKET_ORDER},
                "bucket_values": {bid: 0.0 for bid in _BUCKET_ORDER},
            },
        )
        bid = row["volume_bucket"]
        try:
            qty = float(row.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        entry["total_qty"] += qty
        entry["bucket_counts"][bid] += 1
        entry["bucket_values"][bid] += float(row.get("line_amount") or 0)

    out: list[dict[str, Any]] = []
    for entry in by_customer.values():
        total_count = sum(entry["bucket_counts"].values())
        total_value = sum(entry["bucket_values"].values())
        buckets: dict[str, Any] = {}
        for bid in _BUCKET_ORDER:
            buckets[bid] = _bucket_stats(
                entry["bucket_counts"][bid],
                entry["bucket_values"][bid],
                total_count,
                total_value,
            )
        _apply_targets(buckets)
        out.append(
            {
                "customer_code": entry["customer_code"],
                "customer_name": entry["customer_name"],
                "total_qty": round(entry["total_qty"], 2),
                "total_count": total_count,
                "total_value": total_value,
                "buckets": buckets,
            }
        )
    out.sort(key=lambda row: (-float(row.get("total_value") or 0), row.get("customer_name") or ""))
    return out


def filter_detail_rows(
    rows: list[dict[str, Any]],
    *,
    year: int,
    month: int | None = None,
    bucket: str | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        if row.get("booked_year") != year:
            continue
        if month is not None and row.get("booked_month") != month:
            continue
        if bucket is not None and row.get("volume_bucket") != bucket:
            continue
        out.append(row)
    out.sort(
        key=lambda row: (
            str(row.get("booked_date") or ""),
            str(row.get("sales_order_no") or ""),
            str(row.get("line_item_no") or ""),
        ),
        reverse=True,
    )
    return out
