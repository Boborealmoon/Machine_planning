"""SO outstanding balance - open (not fully shipped) S/O lines with pricing + delivery week."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any


_WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
OPEN_QTY_TOLERANCE = 0.0001
NOPP_PS_TYPE = "NOPP"


def _compact(value: Any) -> str:
    return str(value or "").strip()


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_date(value: Any) -> date | None:
    text = _compact(value)
    if not text:
        return None
    text = text[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _iso_week_no(value: date) -> int:
    return int(value.isocalendar()[1])


def week_label(commit: date | None) -> str | None:
    if commit is None:
        return None
    week_no = _iso_week_no(commit)
    weekday = _WEEKDAY_NAMES[commit.weekday()]
    return f"Week {week_no} - {weekday}"


def commitment_date(pp: dict[str, Any], partial: dict[str, Any] | None = None) -> date | None:
    """Coway EDD wins when set (partial first); otherwise PO due date."""
    coway = _compact((partial or {}).get("coway_proposed_edd")) or _compact(pp.get("coway_proposed_edd"))
    return _parse_date(coway) or _parse_date(pp.get("due_date"))


def ps_type(process_sheet_no: Any) -> str:
    text = _compact(process_sheet_no).upper()
    if text.startswith("[SR]") or text.startswith("SR"):
        return "SR"
    for prefix in ("MPS", "APS", "NPS", "PPS", "CPS"):
        if text.startswith(prefix):
            return prefix
    return ""


def _stage_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "desc": _compact(row.get("current_stage_desc")),
        "status": _compact(row.get("current_stage_status")),
        "no": row.get("current_stage_no"),
        "mode": _compact(row.get("erp_stage_mode")) or "unassigned",
        "last_desc": _compact(row.get("erp_last_stage_desc")),
        "last_status": _compact(row.get("erp_last_stage_status")),
        "wo_count": int(row.get("erp_wo_stage_count") or 0),
    }


def _execution_label(code: str) -> str:
    c = code.upper()
    if c == "I":
        return "In process"
    if c == "R":
        return "Released"
    if c == "P":
        return "Pending"
    return code


def stage_label(pp: dict[str, Any], partial: dict[str, Any] | None = None) -> str:
    """Prefer the given partial stage; else first open partial; else PP overlay."""
    candidates: list[dict[str, Any]] = []
    if partial is not None:
        candidates.append(partial)
    else:
        candidates.extend(pp.get("partials") or [])
    candidates.append(pp)

    best: dict[str, Any] | None = None
    for row in candidates:
        stage = _stage_from_row(row)
        if stage["desc"] or stage["status"]:
            best = stage
            break
        if best is None:
            best = stage
    if best is None:
        best = _stage_from_row(pp)

    if best["desc"] or best["status"]:
        parts: list[str] = []
        if best["desc"]:
            parts.append(best["desc"])
        if best["status"]:
            parts.append(_execution_label(best["status"]))
        return " - ".join(parts)
    if best["mode"] == "no_pp":
        return "No PP assigned"
    if best["mode"] == "unassigned":
        return "No WO assigned"
    if best["mode"] == "completed":
        if best["last_desc"]:
            return f"All stages complete - {best['last_desc']}"
        return "All stages complete"
    return ""


def _money(unit: float | None, qty: float, exch: float | None) -> float:
    if unit is None:
        return 0.0
    rate = exch if exch is not None and exch > 0 else 1.0
    return round(float(unit) * float(qty) * float(rate), 2)


def _partial_qty(pp: dict[str, Any], partial: dict[str, Any] | None) -> float:
    if partial is not None:
        qty = _to_float(partial.get("partial_qty"))
        if qty is not None:
            return qty
    qty = _to_float(pp.get("pp_qty"))
    if qty is not None:
        return qty
    return _to_float(pp.get("so_det_qty")) or 0.0


def _partial_no(partial: dict[str, Any] | None) -> int | None:
    if partial is None:
        return None
    try:
        value = int(partial.get("pp_partial_no") or 0)
    except (TypeError, ValueError):
        return None
    return value or None


def _so_line_pair(sales_order_no: Any, line_item_no: Any) -> tuple[str, str]:
    from planning.sales_report_alloc import so_line_key

    return so_line_key(sales_order_no, line_item_no)


def _iso_date_text(value: Any) -> str | None:
    text = _compact(value)
    return text[:10] or None


def _overlay_so_line_on_pp(pp: dict[str, Any], so_line: dict[str, Any]) -> dict[str, Any]:
    """Copy ERP open-line qty/price onto a PP without mutating the sales-order cache."""
    out = dict(pp)
    so_qty = _to_float(so_line.get("so_det_qty"))
    shipped = _to_float(so_line.get("qty_shipped"))
    if so_qty is not None:
        out["so_det_qty"] = so_qty
    if shipped is not None:
        out["qty_shipped"] = shipped
    fc = _to_float(so_line.get("unit_selling_price_fc"))
    if fc is not None:
        out["unit_selling_price"] = fc
    if not _compact(out.get("due_date")):
        due = _iso_date_text(so_line.get("due_date"))
        if due:
            out["due_date"] = due
    customer = _compact(so_line.get("customer_name"))
    if customer and not _compact(out.get("customer_name")):
        out["customer_name"] = customer
    part_desc = _compact(so_line.get("description"))
    if part_desc and not _compact(out.get("description") or out.get("part_desc")):
        out["description"] = part_desc
    out["shipped_completed"] = False
    return out


def _synthetic_nopp_order(so_line: dict[str, Any]) -> dict[str, Any]:
    remaining = _to_float(so_line.get("remaining_qty")) or 0.0
    so_qty = _to_float(so_line.get("so_det_qty"))
    if so_qty is None:
        so_qty = remaining
    shipped = _to_float(so_line.get("qty_shipped")) or 0.0
    return {
        "sales_order_no": _compact(so_line.get("sales_order_no")),
        "customer_name": _compact(so_line.get("customer_name")),
        "pp_vouchers": [
            {
                "pp_voucher_no": "",
                "process_sheet_no": "",
                "source_line_item_no": _compact(so_line.get("line_item_no")),
                "inventory_code": _compact(so_line.get("inventory_code") or so_line.get("part_no")),
                "description": _compact(so_line.get("description") or so_line.get("part_desc")),
                "so_det_qty": so_qty,
                "pp_qty": remaining,
                "qty_shipped": shipped,
                "unit_selling_price": _to_float(so_line.get("unit_selling_price_fc")),
                "shipped_completed": False,
                "due_date": _iso_date_text(so_line.get("due_date")),
                "erp_stage_mode": "no_pp",
                "partials": [],
            }
        ],
    }


def index_open_so_lines(so_lines: list[dict[str, Any]] | None) -> dict[tuple[str, str], dict[str, Any]]:
    indexed: dict[tuple[str, str], dict[str, Any]] = {}
    for row in so_lines or []:
        remaining = _to_float(row.get("remaining_qty"))
        if remaining is None:
            so_qty = _to_float(row.get("so_det_qty")) or 0.0
            shipped = _to_float(row.get("qty_shipped")) or 0.0
            remaining = max(0.0, so_qty - shipped)
        if remaining <= OPEN_QTY_TOLERANCE:
            continue
        key = _so_line_pair(
            row.get("sales_order_no"),
            row.get("line_item_no") or row.get("source_line_item_no"),
        )
        if not key[0] or not key[1]:
            continue
        indexed[key] = row
    return indexed


def restrict_orders_to_open_so_lines(
    orders: list[dict[str, Any]],
    open_so_lines: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Keep PPs whose S/O line is still open in ERP; add open lines that have no PP yet.

    `open_so_lines is None` leaves the PP list unchanged (tests / fetch fallback).
    """
    if open_so_lines is None:
        return orders

    open_map = index_open_so_lines(open_so_lines)
    matched: set[tuple[str, str]] = set()
    restricted: list[dict[str, Any]] = []

    for order in orders:
        so_no = _compact(order.get("sales_order_no"))
        kept: list[dict[str, Any]] = []
        for pp in order.get("pp_vouchers") or []:
            if pp.get("shipped_completed"):
                continue
            key = _so_line_pair(so_no, pp.get("source_line_item_no"))
            so_line = open_map.get(key)
            if so_line is None:
                continue
            matched.add(key)
            kept.append(_overlay_so_line_on_pp(pp, so_line))
        if not kept:
            continue
        out = dict(order)
        out["pp_vouchers"] = kept
        restricted.append(out)

    for key, so_line in open_map.items():
        if key in matched:
            continue
        restricted.append(_synthetic_nopp_order(so_line))
    return restricted


def expand_outstanding_lines(
    orders: list[dict[str, Any]],
    pricing_by_key: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """One row per open PP partial (or PP when it has no partials).

    SO value (line_value_home) = unit x SO qty x exchange rate.
    Outstanding = unit x open qty x exchange rate, with SO remaining
    allocated across partials in order.
    """
    from planning.process_sheets import _so_line_pricing_key

    pricing = pricing_by_key or {}
    lines: list[dict[str, Any]] = []

    for order in orders:
        customer = _compact(order.get("customer_name") or order.get("customer_short_name"))
        so_no = _compact(order.get("sales_order_no"))
        for pp in order.get("pp_vouchers") or []:
            if pp.get("shipped_completed"):
                continue

            so_qty = _to_float(pp.get("so_det_qty"))
            if so_qty is None:
                so_qty = _to_float(pp.get("pp_qty")) or 0.0
            shipped = _to_float(pp.get("qty_shipped")) or 0.0
            remaining_pool = max(0.0, float(so_qty) - float(shipped))
            if remaining_pool <= OPEN_QTY_TOLERANCE:
                continue

            unit = _to_float(pp.get("unit_selling_price"))
            line_no = _compact(pp.get("source_line_item_no"))
            price_key = _so_line_pricing_key(so_no, line_no)
            price_row = pricing.get(price_key) or {}
            exch = _to_float(price_row.get("exch_rate"))
            if unit is None:
                unit = _to_float(price_row.get("unit_cost"))

            so_line_value = _money(unit, float(so_qty), exch)
            process_sheet_no = _compact(pp.get("process_sheet_no") or pp.get("pp_voucher_no"))
            due = _compact(pp.get("due_date"))[:10] or None
            part_no = _compact(pp.get("inventory_code") or pp.get("part_no"))
            part_desc = _compact(pp.get("description") or pp.get("part_desc"))
            stage_mode = _compact(pp.get("erp_stage_mode")) or "unassigned"
            ptype = ps_type(process_sheet_no)
            if not ptype and stage_mode == "no_pp":
                ptype = NOPP_PS_TYPE

            partials = list(pp.get("partials") or [])
            slots: list[dict[str, Any] | None] = partials if partials else [None]

            for partial in slots:
                pp_qty = _partial_qty(pp, partial)
                open_qty = min(float(pp_qty), remaining_pool)
                remaining_pool = max(0.0, remaining_pool - open_qty)
                if open_qty <= OPEN_QTY_TOLERANCE:
                    continue

                commit = commitment_date(pp, partial)
                coway = (
                    _compact((partial or {}).get("coway_proposed_edd"))
                    or _compact(pp.get("coway_proposed_edd"))
                )[:10] or None
                p_no = _partial_no(partial)
                pp_no = _compact(pp.get("pp_voucher_no"))
                row_id = f"{so_no}|{pp_no or process_sheet_no or NOPP_PS_TYPE}|{p_no or 1}|{line_no}"

                lines.append(
                    {
                        "row_id": row_id,
                        "sales_order_no": so_no,
                        "customer_name": customer,
                        "pp_voucher_no": pp_no,
                        "process_sheet_no": process_sheet_no,
                        "pp_partial_no": p_no,
                        "ps_type": ptype,
                        "source_line_item_no": line_no or None,
                        "part_no": part_no,
                        "part_desc": part_desc,
                        "unit_selling_price": unit,
                        "exch_rate": exch,
                        "so_qty": so_qty,
                        "pp_qty": pp_qty,
                        "qty_shipped": shipped,
                        "remaining_qty": open_qty,
                        "line_value_home": so_line_value,
                        "pp_value_home": _money(unit, float(pp_qty), exch),
                        "outstanding_balance_home": _money(unit, open_qty, exch),
                        "status": stage_label(pp, partial),
                        "erp_stage_mode": _compact(
                            (partial or {}).get("erp_stage_mode") or pp.get("erp_stage_mode")
                        )
                        or "unassigned",
                        "due_date": due,
                        "coway_edd": coway,
                        "commitment_date": commit.isoformat() if commit else None,
                        "week": week_label(commit),
                    }
                )

    lines.sort(
        key=lambda row: (
            row.get("commitment_date") or "9999-12-31",
            row.get("due_date") or "9999-12-31",
            row.get("sales_order_no") or "",
            row.get("process_sheet_no") or "",
            row.get("pp_partial_no") or 0,
        )
    )
    return lines


def _so_line_key(row: dict[str, Any]) -> tuple[str, str]:
    so_no = _compact(row.get("sales_order_no"))
    line_no = _compact(row.get("source_line_item_no")) or _compact(row.get("pp_voucher_no"))
    return _so_line_pair(so_no, line_no)


def sum_unique_so_line_values(lines: list[dict[str, Any]]) -> float:
    """Sum SO line totals once per SO line (partials share the same SO value)."""
    seen: set[tuple[str, str]] = set()
    total = 0.0
    for row in lines:
        key = _so_line_key(row)
        if not key[0] or key in seen:
            continue
        seen.add(key)
        total += float(row.get("line_value_home") or 0)
    return round(total, 2)


def summarize_by_customer(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate outstanding lines by customer name."""
    buckets: dict[str, dict[str, Any]] = {}
    seen_so_lines: dict[str, set[tuple[str, str]]] = {}
    for row in lines:
        name = _compact(row.get("customer_name")) or "(No customer)"
        bucket = buckets.get(name)
        if bucket is None:
            bucket = {
                "customer_name": name,
                "line_count": 0,
                "pp_qty": 0.0,
                "remaining_qty": 0.0,
                "line_value_home": 0.0,
                "outstanding_balance_home": 0.0,
            }
            buckets[name] = bucket
            seen_so_lines[name] = set()
        bucket["line_count"] += 1
        bucket["pp_qty"] = round(float(bucket["pp_qty"]) + float(row.get("pp_qty") or 0), 4)
        bucket["remaining_qty"] = round(
            float(bucket["remaining_qty"]) + float(row.get("remaining_qty") or 0),
            4,
        )
        so_key = _so_line_key(row)
        if so_key[0] and so_key not in seen_so_lines[name]:
            seen_so_lines[name].add(so_key)
            bucket["line_value_home"] = round(
                float(bucket["line_value_home"]) + float(row.get("line_value_home") or 0),
                2,
            )
        bucket["outstanding_balance_home"] = round(
            float(bucket["outstanding_balance_home"])
            + float(row.get("outstanding_balance_home") or 0),
            2,
        )

    out = list(buckets.values())
    out.sort(
        key=lambda row: (
            -float(row.get("outstanding_balance_home") or 0),
            -int(row.get("line_count") or 0),
            str(row.get("customer_name") or ""),
        )
    )
    return out


def build_outstanding_balance(
    orders: list[dict[str, Any]],
    pricing_by_key: dict[str, dict[str, Any]] | None = None,
    open_so_lines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    scoped = restrict_orders_to_open_so_lines(orders, open_so_lines)
    lines = expand_outstanding_lines(scoped, pricing_by_key)
    line_count = len(lines)
    total_pp_qty = round(sum(float(row.get("pp_qty") or 0) for row in lines), 4)
    total_remaining_qty = round(sum(float(row.get("remaining_qty") or 0) for row in lines), 4)
    total_line_value = sum_unique_so_line_values(lines)
    total_outstanding = round(
        sum(float(row.get("outstanding_balance_home") or 0) for row in lines),
        2,
    )
    undated_count = sum(1 for row in lines if not row.get("commitment_date"))
    by_customer = summarize_by_customer(lines)

    return {
        "ok": True,
        "commitment_rule": "coway_edd_or_po_due",
        "currency_note": (
            "Open qty = actual remaining balance; "
            "SO value = unit x SO qty x exch; "
            "Outstanding $ = unit x open qty x exch"
        ),
        "default_ps_types": ["APS", "NPS", "PPS", "NOPP"],
        "summary": {
            "line_count": line_count,
            "pp_qty": total_pp_qty,
            "remaining_qty": total_remaining_qty,
            "line_value_home": total_line_value,
            "outstanding_balance_home": total_outstanding,
            "undated_count": undated_count,
            "customer_count": len(by_customer),
        },
        "by_customer": by_customer,
        "lines": lines,
    }


def pricing_keys_from_orders(orders: list[dict[str, Any]]) -> list[tuple[str, str]]:
    keys: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for order in orders:
        so_no = _compact(order.get("sales_order_no"))
        for pp in order.get("pp_vouchers") or []:
            if pp.get("shipped_completed"):
                continue
            line_no = _compact(pp.get("source_line_item_no"))
            if not so_no or not line_no:
                continue
            pair = (so_no, line_no)
            if pair in seen:
                continue
            seen.add(pair)
            keys.append(pair)
    return keys
