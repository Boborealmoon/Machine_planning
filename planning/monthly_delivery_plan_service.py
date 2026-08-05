"""Monthly delivery plan - commitment-date revenue targets by month.

Commitment date = Coway proposed EDD if set, else PO due date
(same rule as Delivery Schedule / S/O Management).

Target amount (home $) = partial_qty x unit_cost x exch_rate.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .so_outstanding_balance_service import pricing_keys_from_orders, week_label


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


def commitment_date(pp: dict[str, Any], partial: dict[str, Any] | None = None) -> date | None:
    """Coway EDD wins when set; otherwise PO due date."""
    coway = _compact((partial or {}).get("coway_proposed_edd")) or _compact(pp.get("coway_proposed_edd"))
    return _parse_date(coway) or _parse_date(pp.get("due_date"))


def _coway_edd_raw(pp: dict[str, Any], partial: dict[str, Any] | None) -> str:
    return (
        _compact((partial or {}).get("coway_proposed_edd"))
        or _compact(pp.get("coway_proposed_edd"))
    )


def _ps_type(process_sheet_no: Any) -> str:
    text = _compact(process_sheet_no).upper()
    if text.startswith("[SR]") or text.startswith("SR"):
        return "SR"
    for prefix in ("MPS", "APS", "NPS", "PPS", "CPS"):
        if text.startswith(prefix):
            return prefix
    return ""


def _line_qty(pp: dict[str, Any], partial: dict[str, Any] | None) -> float:
    if partial is not None:
        qty = _to_float(partial.get("partial_qty"))
        if qty is not None:
            return qty
    qty = _to_float(pp.get("pp_qty"))
    if qty is not None:
        return qty
    return _to_float(pp.get("so_det_qty")) or 0.0


def _money(unit: float | None, qty: float, exch: float | None) -> float:
    if unit is None:
        return 0.0
    rate = exch if exch is not None and exch > 0 else 1.0
    return round(float(unit) * float(qty) * float(rate), 2)


def expand_delivery_lines(
    orders: list[dict[str, Any]],
    pricing_by_key: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """One row per open PP partial (or PP when it has no partials)."""
    from planning.process_sheets import _so_line_pricing_key

    pricing = pricing_by_key or {}
    lines: list[dict[str, Any]] = []
    for order in orders:
        customer = _compact(order.get("customer_name"))
        so_no = _compact(order.get("sales_order_no"))
        for pp in order.get("pp_vouchers") or []:
            if pp.get("shipped_completed"):
                continue
            line_no = _compact(pp.get("source_line_item_no"))
            price_key = _so_line_pricing_key(so_no, line_no)
            price_row = pricing.get(price_key) or {}
            unit = _to_float(price_row.get("unit_cost"))
            if unit is None:
                unit = _to_float(pp.get("unit_selling_price"))
            exch = _to_float(price_row.get("exch_rate"))

            partials = list(pp.get("partials") or [])
            slots: list[dict[str, Any] | None] = partials if partials else [None]
            for partial in slots:
                qty = _line_qty(pp, partial)
                commit = commitment_date(pp, partial)
                coway_raw = _coway_edd_raw(pp, partial)
                coway_date = _parse_date(coway_raw)
                amount = _money(unit, qty, exch)
                partial_no = None
                if partial is not None:
                    try:
                        partial_no = int(partial.get("pp_partial_no") or 0) or None
                    except (TypeError, ValueError):
                        partial_no = None
                lines.append(
                    {
                        "sales_order_no": so_no,
                        "customer_name": customer,
                        "pp_voucher_no": _compact(pp.get("pp_voucher_no")),
                        "process_sheet_no": _compact(pp.get("process_sheet_no") or pp.get("pp_voucher_no")),
                        "pp_partial_no": partial_no,
                        "ps_type": _ps_type(pp.get("process_sheet_no") or pp.get("pp_voucher_no")),
                        "part_no": _compact(pp.get("inventory_code") or pp.get("part_no")),
                        "part_desc": _compact(pp.get("description") or pp.get("part_desc")),
                        "so_qty": _to_float(pp.get("so_det_qty")),
                        "qty": qty,
                        "unit_cost": unit,
                        "exch_rate": exch if exch is not None else 1.0,
                        "unit_selling_price": _to_float(pp.get("unit_selling_price")),
                        "amount": amount,
                        "due_date": _compact(pp.get("due_date"))[:10] or None,
                        "coway_edd": coway_raw[:10] or None,
                        "week": week_label(coway_date) if coway_date else None,
                        "commitment_date": commit.isoformat() if commit else None,
                        "commitment_month": f"{commit.year:04d}-{commit.month:02d}" if commit else None,
                        "current_stage_desc": _compact(
                            (partial or {}).get("current_stage_desc") or pp.get("current_stage_desc")
                        ),
                    }
                )
    lines.sort(
        key=lambda row: (
            row.get("commitment_date") or "9999-12-31",
            row.get("due_date") or "9999-12-31",
            row.get("process_sheet_no") or "",
            row.get("pp_partial_no") or 0,
        )
    )
    return lines


def _empty_month(year: int, month: int) -> dict[str, Any]:
    return {
        "year": year,
        "month": month,
        "key": f"{year:04d}-{month:02d}",
        "label": date(year, month, 1).strftime("%b %Y"),
        "line_count": 0,
        "qty": 0.0,
        "target_revenue": 0.0,
        "lines": [],
    }


def build_monthly_delivery_plan(
    orders: list[dict[str, Any]],
    *,
    year: int,
    pricing_by_key: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Bucket open delivery lines by commitment month for one calendar year."""
    year = max(2000, min(2100, int(year)))
    lines = expand_delivery_lines(orders, pricing_by_key)
    months = [_empty_month(year, m) for m in range(1, 13)]
    by_key = {m["key"]: m for m in months}
    undated: list[dict[str, Any]] = []
    other_years: list[dict[str, Any]] = []

    for line in lines:
        key = line.get("commitment_month")
        if not key:
            undated.append(line)
            continue
        bucket = by_key.get(key)
        if bucket is None:
            other_years.append(line)
            continue
        bucket["lines"].append(line)
        bucket["line_count"] += 1
        bucket["qty"] = round(float(bucket["qty"]) + float(line.get("qty") or 0), 4)
        bucket["target_revenue"] = round(
            float(bucket["target_revenue"]) + float(line.get("amount") or 0),
            2,
        )

    year_target = round(sum(float(m["target_revenue"]) for m in months), 2)
    year_qty = round(sum(float(m["qty"]) for m in months), 4)
    year_lines = sum(int(m["line_count"]) for m in months)

    return {
        "ok": True,
        "year": year,
        "commitment_rule": "coway_edd_or_po_due",
        "currency_note": "partial qty x unit cost x exchange rate (home currency)",
        "default_ps_types": ["APS", "NPS"],
        "year_summary": {
            "line_count": year_lines,
            "qty": year_qty,
            "target_revenue": year_target,
            "undated_count": len(undated),
            "other_year_count": len(other_years),
        },
        "months": months,
        "undated": undated,
        "other_years": other_years,
    }


# Re-export for route convenience
__all__ = [
    "build_monthly_delivery_plan",
    "commitment_date",
    "expand_delivery_lines",
    "pricing_keys_from_orders",
    "week_label",
]
