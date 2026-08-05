"""Sales-coordination view - read-only process-sheet delivery commitment lines.

Columns mirror S/O Management commitment fields: process sheet, SO, part,
description, customer P/O, due date, Prop. EDD (Coway), and week.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .so_outstanding_balance_service import commitment_date, ps_type


_WEEKDAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)


def _compact(value: Any) -> str:
    return str(value or "").strip()


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


def week_label(commit: date | None) -> str | None:
    """ISO week + full weekday - matches S/O Management / screenshot format."""
    if commit is None:
        return None
    week_no = int(commit.isocalendar()[1])
    weekday = _WEEKDAY_NAMES[commit.weekday()]
    return f"Week {week_no} - {weekday}"


def _partial_no(partial: dict[str, Any] | None) -> int | None:
    if partial is None:
        return None
    try:
        value = int(partial.get("pp_partial_no") or 0)
    except (TypeError, ValueError):
        return None
    return value or None


def _coway_edd(pp: dict[str, Any], partial: dict[str, Any] | None) -> str | None:
    raw = (
        _compact((partial or {}).get("coway_proposed_edd"))
        or _compact(pp.get("coway_proposed_edd"))
    )[:10]
    return raw or None


def _customer_po(
    order: dict[str, Any],
    pp: dict[str, Any],
    partial: dict[str, Any] | None,
) -> str:
    return (
        _compact((partial or {}).get("customer_po_no"))
        or _compact(pp.get("customer_po_no"))
        or _compact(order.get("customer_po_no"))
    )


def expand_sales_coordination_lines(orders: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per open PP partial (or PP when it has no partials)."""
    lines: list[dict[str, Any]] = []

    for order in orders:
        so_no = _compact(order.get("sales_order_no"))
        customer = _compact(order.get("customer_name") or order.get("customer_short_name"))
        for pp in order.get("pp_vouchers") or []:
            if pp.get("shipped_completed"):
                continue

            process_sheet_no = _compact(pp.get("process_sheet_no") or pp.get("pp_voucher_no"))
            due = _compact(pp.get("due_date"))[:10] or None
            part_no = _compact(pp.get("inventory_code") or pp.get("part_no"))
            part_desc = _compact(pp.get("description") or pp.get("part_desc"))
            is_fa = bool(pp.get("is_frame_agreement"))
            is_new = bool(pp.get("is_new_part"))

            partials = list(pp.get("partials") or [])
            slots: list[dict[str, Any] | None] = partials if partials else [None]

            for partial in slots:
                if partial is not None and partial.get("is_frame_agreement"):
                    is_fa = True
                p_no = _partial_no(partial)
                coway = _coway_edd(pp, partial)
                commit = commitment_date(pp, partial)
                pp_voucher = _compact(pp.get("pp_voucher_no"))
                row_id = f"{pp_voucher}|{p_no or 1}"

                lines.append(
                    {
                        "row_id": row_id,
                        "sales_order_no": so_no,
                        "customer_name": customer,
                        "pp_voucher_no": pp_voucher,
                        "process_sheet_no": process_sheet_no,
                        "pp_partial_no": p_no,
                        "ps_type": ps_type(process_sheet_no),
                        "part_no": part_no,
                        "part_desc": part_desc,
                        "customer_po_no": _customer_po(order, pp, partial),
                        "due_date": due,
                        "proposed_edd": coway,
                        "commitment_date": commit.isoformat() if commit else None,
                        "week": week_label(commit),
                        "is_frame_agreement": is_fa,
                        "is_new_part": is_new,
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


def build_sales_coordination(orders: list[dict[str, Any]]) -> dict[str, Any]:
    lines = expand_sales_coordination_lines(orders)
    return {
        "ok": True,
        "line_count": len(lines),
        "lines": lines,
    }
