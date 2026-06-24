"""Sales report allocation — canonical grains to prevent double counting.

Grains (authoritative):
  so_line     : (sales_order_no, line_item_no) — one remaining $ total per SO line
  pp_job      : (pp_voucher_no) — may be many per SO line; $ allocated by pp_qty share
  shipment    : deduped lg_out_shm event — one row per physical DO/invoice line
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

from .utils import compact_text

_PP_TYPES = frozenset({"MPS", "APS", "NPS", "PPS", "CPS", "SR"})
_ALLOC_TOLERANCE = 0.02


def ps_type_from_process_sheet(process_sheet_no: Any) -> str | None:
    raw = compact_text(process_sheet_no).split("::")[0]
    if not raw:
        return None
    if re.search(r"\[sr\]", raw, re.I):
        return "SR"
    match = re.match(r"^([A-Z]+)", raw.upper())
    if not match:
        return None
    return match.group(1)


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


def so_line_key(sales_order_no: Any, line_item_no: Any) -> tuple[str, str]:
    so = compact_text(sales_order_no)
    line = re.sub(r"\.0+$", "", compact_text(line_item_no))
    return so, line


def shipment_dedupe_key(row: dict[str, Any]) -> tuple[str, ...]:
    return (
        compact_text(row.get("shipment_voucher_no")),
        compact_text(row.get("invoice_no")),
        compact_text(row.get("invoice_line_item_no")),
        compact_text(row.get("sales_order_no") or row.get("source_voucher_no")),
        re.sub(r"\.0+$", "", compact_text(row.get("line_item_no") or row.get("source_voucher_line_item_no"))),
        compact_text(row.get("inventory_code")),
    )


def dedupe_shipments(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse duplicate shipment rows caused by many-to-one joins."""
    out: dict[tuple[str, ...], dict[str, Any]] = {}
    for row in rows:
        key = shipment_dedupe_key(row)
        if not key[0]:
            continue
        existing = out.get(key)
        if existing is None:
            out[key] = dict(row)
            continue
        for field in ("qty_issued", "total_home_amt"):
            existing[field] = max(float(existing.get(field) or 0), float(row.get(field) or 0))
    return list(out.values())


def pp_job_due_date(job: dict[str, Any], so_line: dict[str, Any] | None = None) -> date | None:
    for candidate in (
        job.get("proposed_edd"),
        job.get("production_due_date"),
        job.get("so_due_date"),
        so_line.get("due_date") if so_line else None,
    ):
        parsed = parse_date_value(candidate)
        if parsed:
            return parsed
    return None


def so_line_due_date(job: dict[str, Any], so_line: dict[str, Any] | None = None) -> date | None:
    """Authoritative month-ownership anchor for sales report open value."""
    for candidate in (
        so_line.get("due_date") if so_line else None,
        job.get("so_due_date"),
    ):
        parsed = parse_date_value(candidate)
        if parsed:
            return parsed
    return None


def index_so_lines(so_lines: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    indexed: dict[tuple[str, str], dict[str, Any]] = {}
    for row in so_lines:
        key = so_line_key(row.get("sales_order_no"), row.get("line_item_no"))
        if not key[0]:
            continue
        indexed[key] = row
    return indexed


def index_pp_jobs_by_so_line(pp_jobs: list[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for job in pp_jobs:
        key = so_line_key(job.get("sales_order_no"), job.get("line_item_no"))
        if not key[0]:
            continue
        grouped.setdefault(key, []).append(job)
    for jobs in grouped.values():
        jobs.sort(key=lambda row: compact_text(row.get("pp_voucher_no")))
    return grouped


def _job_qty(job: dict[str, Any]) -> float:
    try:
        qty = float(job.get("pp_qty") or 0)
    except (TypeError, ValueError):
        qty = 0.0
    return qty if qty > 0 else 0.0


def index_pp_partials(pp_partials: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in pp_partials:
        key = compact_text(row.get("pp_voucher_no"))
        if not key:
            continue
        grouped.setdefault(key, []).append(row)
    for partials in grouped.values():
        partials.sort(key=lambda row: int(row.get("pp_partial_no") or 1))
    return grouped


def _partial_qty(partial: dict[str, Any]) -> float:
    try:
        qty = float(partial.get("partial_qty") or 0)
    except (TypeError, ValueError):
        qty = 0.0
    return qty if qty > 0 else 0.0


def pp_partial_due_date(partial: dict[str, Any]) -> date | None:
    return (
        parse_date_value(partial.get("proposed_edd"))
        or parse_date_value(partial.get("production_due_date"))
    )


def _shipment_qty(row: dict[str, Any]) -> float:
    try:
        qty = float(row.get("qty_issued") or 0)
    except (TypeError, ValueError):
        qty = 0.0
    return qty if qty > 0 else 0.0


def _shipment_order_key(row: dict[str, Any]) -> tuple:
    ship_dt = parse_date_value(row.get("shipment_date") or row.get("shipment_datetime"))
    return (
        ship_dt or date.max,
        compact_text(row.get("shipment_voucher_no")),
        compact_text(row.get("invoice_no")),
        compact_text(row.get("invoice_line_item_no")),
    )


def _pick_partial_for_shipment(
    partials: list[dict[str, Any]],
    remaining: dict[int, float],
    ship_qty: float,
    *,
    qty_tol: float = 0.0001,
) -> dict[str, Any] | None:
    """Prefer exact qty match, then FIFO partial with enough remaining."""
    for partial in partials:
        partial_no = int(partial.get("pp_partial_no") or 1)
        rem = remaining.get(partial_no, 0.0)
        if rem > qty_tol and abs(rem - ship_qty) <= qty_tol:
            return partial

    for partial in partials:
        partial_no = int(partial.get("pp_partial_no") or 1)
        if remaining.get(partial_no, 0.0) + qty_tol >= ship_qty:
            return partial

    for partial in partials:
        partial_no = int(partial.get("pp_partial_no") or 1)
        if remaining.get(partial_no, 0.0) > qty_tol:
            return partial

    if len(partials) == 1:
        return partials[0]
    return None


def assign_shipment_partials(
    shipments: list[dict[str, Any]],
    partials_by_voucher: dict[str, list[dict[str, Any]]] | None,
) -> list[dict[str, Any]]:
    """Match DO qty to PP partials (FIFO). Partial schedule drives backlog/on-time/early."""
    if not partials_by_voucher:
        return shipments

    indices_by_voucher: dict[str, list[int]] = {}
    for idx, row in enumerate(shipments):
        voucher = compact_text(row.get("pp_voucher_no"))
        if voucher:
            indices_by_voucher.setdefault(voucher, []).append(idx)

    out = [dict(row) for row in shipments]
    qty_tol = 0.0001

    for voucher, idxs in indices_by_voucher.items():
        partials = partials_by_voucher.get(voucher) or []
        if not partials:
            continue

        partials = sorted(partials, key=lambda p: int(p.get("pp_partial_no") or 1))
        remaining = {
            int(p.get("pp_partial_no") or 1): _partial_qty(p) for p in partials
        }
        active_idxs = [i for i in idxs if _shipment_qty(out[i]) > qty_tol]
        sole_partial_due = pp_partial_due_date(partials[0]) if len(partials) == 1 else None
        first_ship_dates = [
            parse_date_value(out[i].get("shipment_date") or out[i].get("shipment_datetime"))
            for i in active_idxs
        ]
        first_ship_date = min((d for d in first_ship_dates if d), default=None)
        tranche_by_ship_date = (
            len(partials) == 1
            and len(active_idxs) > 1
            and sole_partial_due is not None
            and first_ship_date is not None
            and sole_partial_due < first_ship_date
        )

        for idx in sorted(idxs, key=lambda i: _shipment_order_key(out[i])):
            row = out[idx]
            ship_qty = _shipment_qty(row)
            if ship_qty <= qty_tol:
                continue

            matched = _pick_partial_for_shipment(partials, remaining, ship_qty, qty_tol=qty_tol)
            if not matched:
                continue

            partial_no = int(matched.get("pp_partial_no") or 1)
            remaining[partial_no] = max(0.0, remaining.get(partial_no, 0.0) - ship_qty)

            partial_due = pp_partial_due_date(matched)
            if row.get("due_date") and not row.get("so_due_date"):
                row["so_due_date"] = row.get("due_date")
            row["pp_partial_no"] = matched.get("pp_partial_no")
            # Stale single partial + split DOs: tranche month follows each shipment date.
            ship_due = parse_date_value(row.get("shipment_date") or row.get("shipment_datetime"))
            if tranche_by_ship_date and ship_due:
                row["due_date"] = ship_due.isoformat()
                if partial_due:
                    row["partial_due_date"] = partial_due.isoformat()
                method = compact_text(row.get("attribution_method"))
                row["attribution_method"] = (
                    f"{method}+ship_date_tranche" if method else "ship_date_tranche"
                )
            elif partial_due:
                row["due_date"] = partial_due.isoformat()
                row["partial_due_date"] = partial_due.isoformat()
                method = compact_text(row.get("attribution_method"))
                row["attribution_method"] = f"{method}+partial_fifo" if method else "partial_fifo"

    return out


def _expand_job_by_partials(
    job_row: dict[str, Any],
    partials: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Split one PP job allocation across partials by partial_qty (same $ total)."""
    if len(partials) <= 1:
        if partials:
            job_row = dict(job_row)
            job_row["pp_partial_no"] = partials[0].get("pp_partial_no")
        return [job_row]

    qty_total = sum(_partial_qty(p) for p in partials)
    alloc_qty = float(job_row.get("allocated_remaining_qty") or 0)
    alloc_value = float(job_row.get("allocated_remaining_value") or 0)
    qty_left = alloc_qty
    value_left = alloc_value
    expanded: list[dict[str, Any]] = []

    for idx, partial in enumerate(partials):
        share = (_partial_qty(partial) / qty_total) if qty_total > 0 else (1.0 / len(partials))
        if idx == len(partials) - 1:
            part_qty = qty_left
            part_value = value_left
        else:
            part_qty = alloc_qty * share
            part_value = alloc_value * share
            qty_left -= part_qty
            value_left -= part_value
        partial_due = (
            parse_date_value(partial.get("proposed_edd"))
            or parse_date_value(partial.get("production_due_date"))
            or parse_date_value(job_row.get("schedule_due_date"))
        )
        expanded.append({
            **job_row,
            "pp_partial_no": partial.get("pp_partial_no"),
            "partial_qty": _partial_qty(partial),
            "allocation_share": float(job_row.get("allocation_share") or 0) * share,
            "allocated_remaining_qty": part_qty,
            "allocated_remaining_value": part_value,
            "allocation_method": "pp_partial_qty_share",
            "schedule_due_date": partial_due.isoformat() if partial_due else job_row.get("schedule_due_date"),
        })
    return expanded


def allocate_so_line_remaining(
    so_line: dict[str, Any],
    pp_jobs_on_line: list[dict[str, Any]],
    *,
    partials_by_voucher: dict[str, list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Split SO-line remaining $ across PP jobs by pp_qty — never duplicate the full line."""
    remaining_qty = float(so_line.get("remaining_qty") or 0)
    remaining_value = float(so_line.get("remaining_value") or 0)
    unit_price = float(so_line.get("unit_selling_price") or 0)
    so_key = so_line_key(so_line.get("sales_order_no"), so_line.get("line_item_no"))

    partials_by_voucher = partials_by_voucher or {}

    if not pp_jobs_on_line:
        return [{
            **so_line,
            "pp_voucher_no": None,
            "process_sheet_no": so_line.get("process_sheet_no"),
            "pp_type": ps_type_from_process_sheet(so_line.get("process_sheet_no")),
            "pp_qty": remaining_qty,
            "allocation_share": 1.0,
            "allocated_remaining_qty": remaining_qty,
            "allocated_remaining_value": remaining_value,
            "due_date": so_line.get("due_date"),
            "allocation_method": "so_line_only",
            "so_line_key": so_key,
        }]

    qty_total = sum(_job_qty(job) for job in pp_jobs_on_line)
    allocated: list[dict[str, Any]] = []
    qty_left = remaining_qty
    value_left = remaining_value

    for idx, job in enumerate(pp_jobs_on_line):
        share = (_job_qty(job) / qty_total) if qty_total > 0 else (1.0 / len(pp_jobs_on_line))
        if idx == len(pp_jobs_on_line) - 1:
            alloc_qty = qty_left
            alloc_value = value_left
        else:
            alloc_qty = remaining_qty * share
            alloc_value = remaining_value * share
            qty_left -= alloc_qty
            value_left -= alloc_value

        owner_due = so_line_due_date(job, so_line)
        schedule_due = pp_job_due_date(job, so_line)
        job_row = {
            **so_line,
            "pp_voucher_no": job.get("pp_voucher_no"),
            "process_sheet_no": job.get("process_sheet_no"),
            "pp_type": ps_type_from_process_sheet(job.get("process_sheet_no")),
            "inventory_code": job.get("inventory_code") or so_line.get("inventory_code"),
            "pp_qty": _job_qty(job),
            "allocation_share": share,
            "allocated_remaining_qty": alloc_qty,
            "allocated_remaining_value": alloc_value,
            # Report ownership always follows the original SO/PO due month.
            "due_date": owner_due.isoformat() if owner_due else so_line.get("due_date"),
            "schedule_due_date": schedule_due.isoformat() if schedule_due else None,
            "allocation_method": "pp_qty_share",
            "so_line_key": so_key,
        }
        voucher = compact_text(job.get("pp_voucher_no"))
        partials = partials_by_voucher.get(voucher, [])
        allocated.extend(_expand_job_by_partials(job_row, partials))
    return allocated


def match_pp_job_for_shipment(
    shipment: dict[str, Any],
    pp_jobs_on_line: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not pp_jobs_on_line:
        return None
    ship_inv = compact_text(shipment.get("inventory_code")).upper()
    if ship_inv:
        for job in pp_jobs_on_line:
            if compact_text(job.get("inventory_code")).upper() == ship_inv:
                return job
    if len(pp_jobs_on_line) == 1:
        return pp_jobs_on_line[0]
    return None


def attribute_shipments(
    shipments: list[dict[str, Any]],
    pp_jobs_by_line: dict[tuple[str, str], list[dict[str, Any]]],
    so_lines_by_key: dict[tuple[str, str], dict[str, Any]],
    *,
    partials_by_voucher: dict[str, list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    deduped = dedupe_shipments(shipments)
    out: list[dict[str, Any]] = []
    for row in deduped:
        key = so_line_key(row.get("sales_order_no"), row.get("line_item_no"))
        jobs = pp_jobs_by_line.get(key, [])
        so_line = so_lines_by_key.get(key)
        matched = match_pp_job_for_shipment(row, jobs)
        pp_type = ps_type_from_process_sheet(
            matched.get("process_sheet_no") if matched else row.get("process_sheet_no")
        )
        due = parse_date_value(row.get("due_date"))
        if due is None and matched:
            due = pp_job_due_date(matched, so_line)
        if due is None and so_line:
            due = parse_date_value(so_line.get("due_date"))

        attributed = dict(row)
        attributed["pp_voucher_no"] = matched.get("pp_voucher_no") if matched else None
        attributed["process_sheet_no"] = (
            matched.get("process_sheet_no") if matched else row.get("process_sheet_no")
        )
        attributed["pp_type"] = pp_type
        so_due = parse_date_value(so_line.get("due_date")) if so_line else None
        if so_due is None:
            so_due = due
        attributed["due_date"] = due.isoformat() if due else row.get("due_date")
        attributed["so_due_date"] = so_due.isoformat() if so_due else row.get("due_date")
        attributed["attribution_method"] = (
            "inventory_match" if matched and compact_text(row.get("inventory_code")) else
            ("single_pp_job" if matched else "unmatched")
        )
        attributed["so_line_key"] = key
        out.append(attributed)
    return assign_shipment_partials(out, partials_by_voucher)


def build_allocated_open_lines(
    so_lines: list[dict[str, Any]],
    pp_jobs: list[dict[str, Any]],
    pp_partials: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    jobs_by_line = index_pp_jobs_by_so_line(pp_jobs)
    partials_by_voucher = index_pp_partials(pp_partials or [])
    allocated: list[dict[str, Any]] = []
    for so_line in so_lines:
        key = so_line_key(so_line.get("sales_order_no"), so_line.get("line_item_no"))
        allocated.extend(
            allocate_so_line_remaining(
                so_line,
                jobs_by_line.get(key, []),
                partials_by_voucher=partials_by_voucher,
            )
        )
    return allocated


def integrity_check(
    so_lines: list[dict[str, Any]],
    allocated_open: list[dict[str, Any]],
    shipments_raw: list[dict[str, Any]],
    shipments_attributed: list[dict[str, Any]],
) -> dict[str, Any]:
    so_remaining = sum(float(r.get("remaining_value") or 0) for r in so_lines)
    alloc_remaining = sum(float(r.get("allocated_remaining_value") or 0) for r in allocated_open)
    raw_shipped = sum(float(r.get("total_home_amt") or 0) for r in shipments_raw)
    dedup_shipped = sum(float(r.get("total_home_amt") or 0) for r in shipments_attributed)
    return {
        "so_line_remaining_total": so_remaining,
        "pp_allocated_remaining_total": alloc_remaining,
        "remaining_allocation_gap": abs(so_remaining - alloc_remaining),
        "shipment_rows_raw": len(shipments_raw),
        "shipment_rows_deduped": len(shipments_attributed),
        "shipment_amt_raw": raw_shipped,
        "shipment_amt_deduped": dedup_shipped,
        "shipment_dedup_savings": raw_shipped - dedup_shipped,
        "ok": (
            abs(so_remaining - alloc_remaining) <= _ALLOC_TOLERANCE
            and abs(raw_shipped - dedup_shipped) <= _ALLOC_TOLERANCE
        ),
    }


def sum_field(rows: list[dict[str, Any]], field: str) -> float:
    total = 0.0
    for row in rows:
        try:
            total += float(row.get(field) or 0)
        except (TypeError, ValueError):
            continue
    return total


def filter_rows_by_pp_types(
    rows: list[dict[str, Any]],
    pp_types: set[str] | frozenset[str],
    *,
    all_selected: bool = False,
) -> list[dict[str, Any]]:
    if all_selected:
        return list(rows)
    if not pp_types:
        return []
    out = []
    for row in rows:
        pp_type = row.get("pp_type") or ps_type_from_process_sheet(row.get("process_sheet_no"))
        if not pp_type:
            continue
        if pp_type in pp_types:
            out.append(row)
    return out
