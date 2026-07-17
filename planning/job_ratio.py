"""Job ratio report — volume bucket mix by booked SO lines."""
from __future__ import annotations

from datetime import date, datetime
from math import sqrt
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

MONTH_LENS_PO_DUE = "po_due"
MONTH_LENS_POSTED = "posted"
MONTH_LENSES = (MONTH_LENS_PO_DUE, MONTH_LENS_POSTED)

MONTH_LENS_LABELS = {
    MONTH_LENS_PO_DUE: "PO due date",
    MONTH_LENS_POSTED: "Posted date (SO / PS)",
}


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


def month_anchor_date(row: dict[str, Any], lens: str = MONTH_LENS_PO_DUE) -> date | None:
    """Month bucket — PO due uses SO required shipment date; posted uses PS order date or SO posted."""
    if lens == MONTH_LENS_POSTED:
        ps_dt = parse_date_value(row.get("ps_order_date"))
        so_dt = (
            parse_date_value(row.get("first_posted_datetime"))
            or parse_date_value(row.get("so_posted_date"))
            or parse_date_value(row.get("so_header_order_date"))
        )
        if compact_text(row.get("process_sheet_no")):
            return ps_dt or so_dt
        return so_dt or ps_dt
    return parse_date_value(row.get("so_due_date")) or parse_date_value(row.get("po_due_date"))


def compare_lens_months(
    rows: list[dict[str, Any]],
    year: int,
    *,
    pp_types: set[str],
    all_selected: bool = False,
) -> dict[str, Any]:
    """How often PO-due month differs from posted month (same selected year)."""
    filtered = filter_rows_by_pp_types(rows, pp_types, all_selected=all_selected)
    same = 0
    diff = 0
    po_only = 0
    posted_only = 0
    for row in filtered:
        po = month_anchor_date(row, MONTH_LENS_PO_DUE)
        post = month_anchor_date(row, MONTH_LENS_POSTED)
        po_in = po is not None and po.year == year
        post_in = post is not None and post.year == year
        if po_in and post_in:
            if po.month == post.month:
                same += 1
            else:
                diff += 1
        elif po_in:
            po_only += 1
        elif post_in:
            posted_only += 1
    return {
        "same_month": same,
        "different_month": diff,
        "po_due_only_in_year": po_only,
        "posted_only_in_year": posted_only,
    }


def report_anchor_date(row: dict[str, Any]) -> date | None:
    """Default month anchor (PO due) — kept for backwards compatibility."""
    return month_anchor_date(row, MONTH_LENS_PO_DUE)


def dedupe_pp_vouchers_by_ps(vouchers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per process sheet — collapse PP partial duplicates, keep latest partial."""
    best: dict[str, dict[str, Any]] = {}
    order_key = lambda v: (
        int(v.get("pp_partial_no") or 0),
        int(v.get("stage_no") or 0),
    )
    for voucher in vouchers:
        ps_id = compact_text(voucher.get("ps_id"))
        if not ps_id:
            continue
        prev = best.get(ps_id)
        if prev is None or order_key(voucher) >= order_key(prev):
            best[ps_id] = voucher
    return list(best.values())


def _pp_job_qty(job: dict[str, Any]) -> float:
    try:
        qty = float(job.get("pp_qty") or 0)
    except (TypeError, ValueError):
        qty = 0.0
    return qty if qty > 0 else 0.0


def build_job_rows_from_booked(
    booked_lines: list[dict[str, Any]],
    pp_jobs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """One job per PP voucher on booked SO lines; home-$ split by pp_qty share."""
    from .sales_report_alloc import index_pp_jobs_by_so_line, ps_type_from_process_sheet, so_line_key

    jobs_by_line = index_pp_jobs_by_so_line(pp_jobs)
    rows: list[dict[str, Any]] = []

    for so_line in booked_lines:
        key = so_line_key(so_line.get("sales_order_no"), so_line.get("line_item_no"))
        if not key[0]:
            continue
        if not parse_date_value(so_line.get("due_date")):
            continue
        try:
            line_qty = float(so_line.get("qty") or 0)
            line_amount = float(so_line.get("line_amount") or 0)
        except (TypeError, ValueError):
            continue
        if line_qty <= 0:
            continue

        jobs = jobs_by_line.get(key, [])
        if not jobs:
            pp_type = row_pp_type(so_line)
            rows.append(
                {
                    **so_line,
                    "qty": line_qty,
                    "line_amount": line_amount,
                    "pp_type": pp_type,
                    "pp_types_on_line": [pp_type] if pp_type else [],
                    "process_sheets_on_line": [],
                    "pp_jobs_on_line": 0,
                    "pp_due_date": so_line.get("due_date"),
                    "so_due_date": so_line.get("due_date"),
                }
            )
            continue

        active_jobs = [job for job in jobs if _pp_job_qty(job) > 0]
        if not active_jobs:
            continue

        qty_total = sum(_pp_job_qty(job) for job in active_jobs)
        amount_left = line_amount

        ps_numbers: list[str] = []
        types_on_line: set[str] = set()
        for job in active_jobs:
            ps = compact_text(job.get("process_sheet_no"))
            if ps and ps not in ps_numbers:
                ps_numbers.append(ps)
            pt = ps_type_from_process_sheet(ps)
            if pt:
                types_on_line.add(pt)

        for idx, job in enumerate(active_jobs):
            pp_qty = _pp_job_qty(job)
            share = (pp_qty / qty_total) if qty_total > 0 else (1.0 / len(active_jobs))
            if idx == len(active_jobs) - 1:
                alloc_amount = amount_left
            else:
                alloc_amount = line_amount * share
                amount_left -= alloc_amount

            schedule_due = (
                parse_date_value(job.get("proposed_edd"))
                or parse_date_value(job.get("production_due_date"))
                or parse_date_value(job.get("so_due_date"))
            )
            ps_base = compact_text(job.get("process_sheet_no")).split("::")[0]
            pp_type = ps_type_from_process_sheet(ps_base)

            rows.append(
                {
                    **so_line,
                    "qty": pp_qty,
                    "line_amount": alloc_amount,
                    "process_sheet_no": ps_base,
                    "pp_voucher_no": job.get("pp_voucher_no"),
                    "pp_type": pp_type,
                    "pp_due_date": schedule_due.isoformat() if schedule_due else so_line.get("due_date"),
                    "due_date": so_line.get("due_date"),
                    "so_due_date": so_line.get("due_date"),
                    "pp_types_on_line": sorted(types_on_line),
                    "process_sheets_on_line": ps_numbers,
                    "pp_jobs_on_line": len(active_jobs),
                    "inventory_code": compact_text(job.get("inventory_code")) or so_line.get("inventory_code"),
                }
            )

    return rows


def _so_ps_qty(voucher: dict[str, Any], so_qty: float) -> float:
    """Sales-order qty allocated to this process sheet (pp_qty), capped to the SO line."""
    for field in ("pp_qty", "partial_qty"):
        try:
            qty = float(voucher.get(field) or 0)
        except (TypeError, ValueError):
            qty = 0.0
        if qty > 0:
            return min(qty, so_qty) if so_qty > 0 else qty
    return 0.0


def row_has_positive_qty(row: dict[str, Any]) -> bool:
    try:
        return float(row.get("qty") or 0) > 0
    except (TypeError, ValueError):
        return False


def build_job_rows_from_pp_vouchers(
    pp_vouchers: list[dict[str, Any]],
    so_lines_by_key: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """One job row per PP voucher; bucket qty = SO qty per PS (pp_qty); $ split by that qty share."""
    from collections import defaultdict

    from .sales_report_alloc import ps_type_from_process_sheet, so_line_key

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for voucher in pp_vouchers:
        so_no = compact_text(voucher.get("source_voucher_no"))
        line_no = compact_text(voucher.get("source_line_item_no"))
        ps_id = compact_text(voucher.get("ps_id"))
        if not ps_id or not so_no or not line_no:
            continue
        grouped[so_line_key(so_no, line_no)].append(voucher)

    rows: list[dict[str, Any]] = []
    for key, vouchers in grouped.items():
        so = so_lines_by_key.get(key)
        if not so:
            continue
        try:
            line_amount = float(so.get("line_amount") or 0)
            so_qty = float(so.get("qty") or 0)
        except (TypeError, ValueError):
            continue

        prepared: list[tuple[dict[str, Any], float, date | None, date | None]] = []
        so_due = parse_date_value(so.get("due_date"))
        so_posted = parse_date_value(so.get("first_posted_datetime")) or parse_date_value(
            so.get("so_posted_date")
        )
        for voucher in vouchers:
            ps_order = parse_date_value(voucher.get("order_date"))
            if not (so_due or ps_order or so_posted):
                continue
            qty = _so_ps_qty(voucher, so_qty)
            if qty <= 0:
                continue
            prepared.append((voucher, qty, so_due, ps_order))

        if not prepared:
            continue

        qty_total = sum(qty for _, qty, _, _ in prepared)
        if so_qty > 0 and qty_total > so_qty + 0.0001:
            scale = so_qty / qty_total
            prepared = [
                (voucher, qty * scale, po_due, ps_order)
                for voucher, qty, po_due, ps_order in prepared
            ]
            qty_total = so_qty
        amount_left = line_amount

        ps_numbers: list[str] = []
        types_on_line: set[str] = set()
        for voucher, _, _, _ in prepared:
            ps_base = compact_text(voucher.get("ps_id")).split("::")[0]
            if ps_base and ps_base not in ps_numbers:
                ps_numbers.append(ps_base)
            pt = ps_type_from_process_sheet(ps_base)
            if pt:
                types_on_line.add(pt)

        for idx, (voucher, qty, po_due, ps_order) in enumerate(prepared):
            share = (qty / qty_total) if qty_total > 0 else (1.0 / len(prepared))
            if idx == len(prepared) - 1:
                alloc_amount = amount_left
            else:
                alloc_amount = line_amount * share
                amount_left -= alloc_amount

            ps_base = compact_text(voucher.get("ps_id")).split("::")[0]
            pp_type = ps_type_from_process_sheet(ps_base)
            rows.append(
                {
                    **so,
                    "qty": qty,
                    "so_qty": so_qty,
                    "line_amount": alloc_amount,
                    "process_sheet_no": ps_base,
                    "pp_type": pp_type,
                    "po_due_date": po_due.isoformat() if po_due else None,
                    "pp_due_date": po_due.isoformat() if po_due else None,
                    "ps_order_date": ps_order.isoformat() if ps_order else None,
                    "so_due_date": so_due.isoformat() if so_due else so.get("due_date"),
                    "pp_types_on_line": sorted(types_on_line),
                    "process_sheets_on_line": ps_numbers,
                    "pp_jobs_on_line": len(prepared),
                    "inventory_code": compact_text(voucher.get("part_no")) or so.get("inventory_code"),
                    "description": compact_text(voucher.get("description")) or so.get("description"),
                }
            )
    return rows


def attach_pp_metadata(
    booked: list[dict[str, Any]],
    pp_jobs: list[dict[str, Any]],
    *,
    pp_types: set[str] | frozenset[str] | None = None,
) -> None:
    """Resolve process sheets and PP types per SO line (may be many PP vouchers per line)."""
    from .sales_report_alloc import index_pp_jobs_by_so_line, so_line_key

    jobs_by_line = index_pp_jobs_by_so_line(pp_jobs)
    preferred_types = set(pp_types or ())

    for row in booked:
        key = so_line_key(row.get("sales_order_no"), row.get("line_item_no"))
        jobs = jobs_by_line.get(key, [])

        ps_numbers: list[str] = []
        types_on_line: set[str] = set()
        for job in jobs:
            ps = compact_text(job.get("process_sheet_no"))
            if ps and ps not in ps_numbers:
                ps_numbers.append(ps)
            pt = ps_type_from_process_sheet(ps)
            if pt:
                types_on_line.add(pt)

        row["pp_jobs_on_line"] = len(jobs)
        row["pp_types_on_line"] = sorted(types_on_line)
        row["process_sheets_on_line"] = ps_numbers

        display_ps = compact_text(row.get("process_sheet_no"))
        if not display_ps:
            chosen = None
            if preferred_types:
                for job in jobs:
                    pt = ps_type_from_process_sheet(job.get("process_sheet_no"))
                    if pt in preferred_types:
                        chosen = compact_text(job.get("process_sheet_no"))
                        break
            if not chosen and jobs:
                chosen = compact_text(jobs[0].get("process_sheet_no"))
            if chosen:
                row["process_sheet_no"] = chosen
        row["pp_type"] = row_pp_type(row)


def filter_rows_by_pp_types(
    rows: list[dict[str, Any]],
    pp_types: set[str] | frozenset[str],
    *,
    all_selected: bool = False,
    include_untyped: bool = False,
) -> list[dict[str, Any]]:
    """Include SO line when any PP job on the line matches a selected PP type."""
    if all_selected:
        return list(rows)
    if not pp_types:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        types_on_line = row.get("pp_types_on_line")
        if types_on_line:
            if any(t in pp_types for t in types_on_line):
                out.append(row)
            continue
        pp_type = row_pp_type(row)
        if pp_type is None:
            if include_untyped:
                out.append(row)
            continue
        if pp_type in pp_types:
            out.append(row)
    return out


def enrich_booked_row(row: dict[str, Any], year: int, *, lens: str = MONTH_LENS_PO_DUE) -> dict[str, Any]:
    po_due = parse_date_value(row.get("po_due_date")) or parse_date_value(row.get("pp_due_date"))
    so_due = parse_date_value(row.get("so_due_date")) or parse_date_value(row.get("due_date"))
    ps_order = parse_date_value(row.get("ps_order_date"))
    posted = parse_date_value(row.get("first_posted_datetime"))
    report_dt = month_anchor_date(row, lens)
    qty = row.get("qty")
    try:
        line_amount = float(row.get("line_amount") or 0)
    except (TypeError, ValueError):
        line_amount = 0.0
    bucket = classify_volume_bucket(qty, year)
    return {
        **row,
        "month_lens": lens,
        "pp_type": row_pp_type(row),
        "volume_bucket": bucket,
        "report_month": report_dt.month if report_dt else None,
        "report_year": report_dt.year if report_dt else None,
        "report_date": report_dt.isoformat() if report_dt else None,
        "po_due_date": po_due.isoformat() if po_due else row.get("po_due_date"),
        "pp_due_date": po_due.isoformat() if po_due else row.get("pp_due_date"),
        "so_due_date": so_due.isoformat() if so_due else row.get("so_due_date"),
        "ps_order_date": ps_order.isoformat() if ps_order else row.get("ps_order_date"),
        "first_posted_date": posted.isoformat() if posted else None,
        "line_amount": line_amount,
    }


def build_portion_summary(
    base_rows: list[dict[str, Any]],
    year: int,
    pp_types: set[str],
    *,
    lens: str,
    all_selected: bool = False,
) -> dict[str, Any]:
    """Enrich, filter, and aggregate one month-basis portion."""
    enriched = [enrich_booked_row(row, year, lens=lens) for row in base_rows]
    filtered = filter_rows_by_pp_types(enriched, pp_types, all_selected=all_selected)
    filtered = [row for row in filtered if row_has_positive_qty(row)]
    classified = [row for row in filtered if row.get("volume_bucket")]
    unclassified = [row for row in filtered if not row.get("volume_bucket")]
    return {
        "lens": lens,
        "month_basis": MONTH_LENS_LABELS.get(lens, lens),
        "matrix": aggregate_month_bucket(filtered, year),
        "customers": aggregate_customer_rows(filtered, year),
        "line_count": len(filtered),
        "classified_line_count": len(classified),
        "unclassified_count": len(unclassified),
        "pp_excluded_count": len(enriched) - len(filtered),
        "booked_lines": filtered,
    }


def row_report_year(row: dict[str, Any]) -> int | None:
    year = row.get("report_year")
    return year if isinstance(year, int) else None


def row_report_month(row: dict[str, Any]) -> int | None:
    month = row.get("report_month")
    return month if isinstance(month, int) and 1 <= month <= 12 else None


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
            if row_report_year(row) == year and row_report_month(row) == month and row.get("volume_bucket")
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
        if row_report_year(row) != year or not row.get("volume_bucket"):
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
                "month_counts": {m: {bid: 0 for bid in _BUCKET_ORDER} for m in range(1, 13)},
                "month_values": {m: {bid: 0.0 for bid in _BUCKET_ORDER} for m in range(1, 13)},
            },
        )
        bid = row["volume_bucket"]
        month = row_report_month(row)
        try:
            qty = float(row.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        amount = float(row.get("line_amount") or 0)
        entry["total_qty"] += qty
        entry["bucket_counts"][bid] += 1
        entry["bucket_values"][bid] += amount
        if isinstance(month, int) and 1 <= month <= 12:
            entry["month_counts"][month][bid] += 1
            entry["month_values"][month][bid] += amount

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

        months: list[dict[str, Any]] = []
        for month in range(1, 13):
            m_counts = entry["month_counts"][month]
            m_values = entry["month_values"][month]
            m_total_count = sum(m_counts.values())
            m_total_value = sum(m_values.values())
            if not m_total_count:
                continue
            m_buckets: dict[str, Any] = {}
            for bid in _BUCKET_ORDER:
                m_buckets[bid] = _bucket_stats(
                    m_counts[bid],
                    m_values[bid],
                    m_total_count,
                    m_total_value,
                )
            _apply_targets(m_buckets)
            months.append(
                {
                    "month": month,
                    "label": date(year, month, 1).strftime("%b-%y"),
                    "buckets": m_buckets,
                    "total": {"count": m_total_count, "value": m_total_value},
                }
            )

        out.append(
            {
                "customer_code": entry["customer_code"],
                "customer_name": entry["customer_name"],
                "total_qty": round(entry["total_qty"], 2),
                "total_count": total_count,
                "total_value": total_value,
                "buckets": buckets,
                "months": months,
            }
        )
    out.sort(key=lambda row: (-float(row.get("total_value") or 0), row.get("customer_name") or ""))
    return out


def _percentile_scores(rows: list[dict[str, Any]], field: str) -> dict[int, float]:
    """Return non-zero percentile ranks, assigning tied values their average rank."""
    if not rows:
        return {}
    if len(rows) == 1:
        return {id(rows[0]): 100.0}

    ordered = sorted(
        ((float(row.get(field) or 0), index, row) for index, row in enumerate(rows)),
        key=lambda item: (item[0], item[1]),
    )
    scores: dict[int, float] = {}
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][0] == ordered[start][0]:
            end += 1
        average_rank = (start + end - 1) / 2.0
        score = (average_rank + 1.0) / len(ordered) * 100.0
        for _, _, row in ordered[start:end]:
            scores[id(row)] = round(score, 1)
        start = end
    return scores


def aggregate_ranked_parts(
    rows: list[dict[str, Any]],
    year: int,
    *,
    month: int | None = None,
    customer_code: str | None = None,
    min_qty: float = 0.0,
    min_value: float = 0.0,
    sort: str = "score",
    score_mode: str = "volume_value",
) -> list[dict[str, Any]]:
    """Aggregate booked PS jobs by customer + part and rank volume/value performance."""
    customer_key = compact_text(customer_code) if customer_code else None
    grouped: dict[tuple[str, str], dict[str, Any]] = {}

    for row in rows:
        if row_report_year(row) != year or not row_has_positive_qty(row):
            continue
        if month is not None and row_report_month(row) != month:
            continue

        code = compact_text(row.get("customer_code")) or "—"
        if customer_key is not None and code != customer_key:
            continue
        part_no = compact_text(row.get("inventory_code")) or "—"
        key = (code, part_no)
        entry = grouped.setdefault(
            key,
            {
                "customer_code": code,
                "customer_name": compact_text(row.get("customer_name")) or code,
                "part_no": part_no,
                "description": compact_text(row.get("description")),
                "total_qty": 0.0,
                "total_value": 0.0,
                "_process_sheets": set(),
                "_sales_orders": set(),
            },
        )
        if not entry["description"]:
            entry["description"] = compact_text(row.get("description"))
        entry["total_qty"] += _detail_row_qty(row)
        entry["total_value"] += _detail_row_amount(row)
        process_sheet = compact_text(row.get("process_sheet_no"))
        sales_order = compact_text(row.get("sales_order_no"))
        if process_sheet:
            entry["_process_sheets"].add(process_sheet)
        if sales_order:
            entry["_sales_orders"].add(sales_order)

    out: list[dict[str, Any]] = []
    for entry in grouped.values():
        total_qty = float(entry["total_qty"])
        total_value = float(entry["total_value"])
        if total_qty < min_qty or total_value < min_value:
            continue
        out.append(
            {
                "customer_code": entry["customer_code"],
                "customer_name": entry["customer_name"],
                "part_no": entry["part_no"],
                "description": entry["description"],
                "total_qty": round(total_qty, 2),
                "total_value": round(total_value, 2),
                "process_sheet_count": len(entry["_process_sheets"]),
                "order_count": len(entry["_sales_orders"]),
                "average_unit_value": round(total_value / total_qty, 2) if total_qty else 0.0,
            }
        )

    volume_scores = _percentile_scores(out, "total_qty")
    value_scores = _percentile_scores(out, "total_value")
    order_scores = _percentile_scores(out, "order_count")
    for row in out:
        row["volume_percentile"] = volume_scores[id(row)]
        row["value_percentile"] = value_scores[id(row)]
        row["order_percentile"] = order_scores[id(row)]
        row["volume_value_score"] = round(
            sqrt(row["volume_percentile"] * row["value_percentile"]),
            1,
        )
        row["repeat_demand_score"] = round(
            (row["volume_percentile"] ** 0.30)
            * (row["value_percentile"] ** 0.40)
            * (row["order_percentile"] ** 0.30),
            1,
        )
        row["score"] = (
            row["repeat_demand_score"]
            if score_mode == "repeat_demand"
            else row["volume_value_score"]
        )

    def text_key(row: dict[str, Any]) -> tuple[str, str, str]:
        return (
            str(row.get("customer_name") or "").casefold(),
            str(row.get("customer_code") or "").casefold(),
            str(row.get("part_no") or "").casefold(),
        )

    if sort == "volume":
        out.sort(key=lambda row: (-float(row["total_qty"]), -float(row["total_value"]), text_key(row)))
    elif sort == "value":
        out.sort(key=lambda row: (-float(row["total_value"]), -float(row["total_qty"]), text_key(row)))
    elif sort == "orders":
        out.sort(key=lambda row: (-int(row["order_count"]), -float(row["score"]), text_key(row)))
    elif sort == "part":
        out.sort(key=lambda row: (str(row["part_no"]).casefold(), text_key(row)))
    else:
        out.sort(
            key=lambda row: (
                -float(row["score"]),
                -float(row["total_value"]),
                -float(row["total_qty"]),
                text_key(row),
            )
        )

    for rank, row in enumerate(out, start=1):
        row["rank"] = rank
    return out


def bucket_sort_index(bucket_id: str | None) -> int:
    try:
        return _BUCKET_ORDER.index(bucket_id)  # type: ignore[arg-type]
    except ValueError:
        return len(_BUCKET_ORDER)


def _detail_row_qty(row: dict[str, Any]) -> float:
    try:
        return float(row.get("qty") or 0)
    except (TypeError, ValueError):
        return 0.0


def _detail_row_amount(row: dict[str, Any]) -> float:
    try:
        return float(row.get("line_amount") or 0)
    except (TypeError, ValueError):
        return 0.0


def sort_detail_rows(
    rows: list[dict[str, Any]],
    *,
    sort: str = "volume",
) -> list[dict[str, Any]]:
    """Sort job detail rows — default groups by month then volume bucket, highest qty first."""
    if sort == "date":
        return sorted(
            rows,
            key=lambda row: (
                str(row.get("report_date") or ""),
                str(row.get("sales_order_no") or ""),
                str(row.get("line_item_no") or ""),
            ),
            reverse=True,
        )
    if sort == "value":
        return sorted(
            rows,
            key=lambda row: (
                row_report_month(row) or 0,
                bucket_sort_index(row.get("volume_bucket")),
                -_detail_row_amount(row),
                -_detail_row_qty(row),
                str(row.get("sales_order_no") or ""),
                str(row.get("line_item_no") or ""),
            ),
        )
    # volume (default): month → bucket → qty desc → value desc
    return sorted(
        rows,
        key=lambda row: (
            row_report_month(row) or 0,
            bucket_sort_index(row.get("volume_bucket")),
            -_detail_row_qty(row),
            -_detail_row_amount(row),
            str(row.get("sales_order_no") or ""),
            str(row.get("line_item_no") or ""),
        ),
    )


def filter_detail_rows(
    rows: list[dict[str, Any]],
    *,
    year: int,
    month: int | None = None,
    bucket: str | None = None,
    customer_code: str | None = None,
    classified_only: bool = True,
    sort: str = "volume",
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    customer_key = compact_text(customer_code) if customer_code else None
    for row in rows:
        if row_report_year(row) != year:
            continue
        if classified_only and not row.get("volume_bucket"):
            continue
        if not row_has_positive_qty(row):
            continue
        if month is not None and row_report_month(row) != month:
            continue
        if bucket is not None and row.get("volume_bucket") != bucket:
            continue
        if customer_key is not None:
            code = compact_text(row.get("customer_code")) or "—"
            if code != customer_key:
                continue
        out.append(row)
    return sort_detail_rows(out, sort=sort)
