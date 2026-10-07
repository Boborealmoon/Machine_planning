"""KPI extracts from S/O management.

Material rows are process sheets whose material arrived after the need date.
Arrival is the S/O Material in date. Same-day and early arrivals are left out.
Exception rows are partials flagged on S/O management.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from planning.process_sheets import material_in_card_date
from planning.utils import compact_text, sheet_category

_ISSUE_ORDER = (
    "supply_chain",
    "process_engr",
    "qlty",
    "sales",
    "others",
)
_ISSUE_LABELS = {
    "supply_chain": "Supply Chain",
    "process_engr": "Process / Engr",
    "qlty": "Qlty",
    "sales": "Sales",
    "others": "Others",
}


def build_so_kpi(orders: list[dict[str, Any]] | None) -> dict[str, Any]:
    material_rows: list[dict[str, Any]] = []
    exception_rows: list[dict[str, Any]] = []
    for order in orders or []:
        if not isinstance(order, dict):
            continue
        for pp in order.get("pp_vouchers") or []:
            if not isinstance(pp, dict):
                continue
            gap = _material_gap_row(order, pp)
            if gap:
                material_rows.append(gap)
            exception_rows.extend(_exception_rows(order, pp))
    material_rows.sort(
        key=lambda row: (
            -int(row["day_gap"]),
            row["material_need_date"],
            row["process_sheet_no"],
        )
    )
    exception_rows.sort(
        key=lambda row: (
            row["due_date"] or "9999-99-99",
            row["process_sheet_no"],
            row["partial_no"],
        )
    )
    return {
        "ok": True,
        "material_rows": material_rows,
        "exception_rows": exception_rows,
        "material_summary": {
            "count": len(material_rows),
            "late": len(material_rows),
            "early": 0,
        },
        "exception_summary": {
            "count": len(exception_rows),
            "jobs": len({row["process_sheet_no"] for row in exception_rows}),
        },
    }


def _material_gap_row(order: dict[str, Any], pp: dict[str, Any]) -> dict[str, Any] | None:
    need = _as_date(pp.get("material_need_date"))
    arrival = _as_date(material_in_card_date(pp.get("material_subcon"), pp.get("material_in_date")))
    if not need or not arrival:
        return None
    day_gap = (arrival - need).days
    if day_gap <= 0:
        return None
    return {
        **_identity(order, pp),
        "material_need_date": need.isoformat(),
        "material_arrival_date": arrival.isoformat(),
        "day_gap": day_gap,
        "gap_label": _gap_label(day_gap),
        "due_date": _as_iso(pp.get("due_date")),
        "edd_date": _sheet_edd(pp),
        **_remarks(order, pp),
    }


def _exception_rows(order: dict[str, Any], pp: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for partial_no in _flagged_partials(pp):
        partial = _partial(pp, partial_no)
        rows.append(
            {
                **_identity(order, pp),
                "partial_no": partial_no,
                "partial_label": _partial_label(pp, partial_no),
                "posted_date": _as_iso(order.get("first_posted_datetime") or order.get("order_date")),
                "due_date": _as_iso(pp.get("due_date")),
                "edd_date": _edd_date(pp, partial),
                "exception_label": _exception_label(pp, partial_no),
                **_remarks(order, pp),
            }
        )
    return rows


def _identity(order: dict[str, Any], pp: dict[str, Any]) -> dict[str, str]:
    sheet = compact_text(pp.get("process_sheet_no")) or compact_text(pp.get("pp_voucher_no"))
    customer = (
        compact_text(order.get("customer_name"))
        or compact_text(order.get("customer_short_name"))
        or compact_text(order.get("customer_code"))
    )
    return {
        "sales_order_no": compact_text(order.get("sales_order_no")),
        "customer_name": customer,
        "process_sheet_no": sheet,
        "ps_type": sheet_category(sheet),
        "part_no": compact_text(pp.get("inventory_code")),
        "description": compact_text(pp.get("description")),
    }


def _remarks(order: dict[str, Any], pp: dict[str, Any]) -> dict[str, str]:
    del order
    return {
        "delivery_date": _as_iso(pp.get("delivery_date")),
        "mtl_part_order": compact_text(pp.get("mtl_part_order")),
        "quality_doc": compact_text(pp.get("quality_doc")),
        "ops_notes": compact_text(pp.get("ops_notes")),
        "sales_notes": compact_text(pp.get("sales_notes")),
    }


def _flagged_partials(pp: dict[str, Any]) -> list[int]:
    nums: list[int] = []
    for raw in pp.get("highlighted_partials") or []:
        number = _partial_number(raw)
        if number and number not in nums:
            nums.append(number)
    issues = pp.get("exception_issues") or {}
    if isinstance(issues, dict):
        for key, value in issues.items():
            if not value:
                continue
            number = _partial_number(key)
            if number and number not in nums:
                nums.append(number)
    if not nums and pp.get("ps_highlighted"):
        nums.append(1)
    return sorted(nums)


def _partial_number(raw: Any) -> int | None:
    try:
        number = int(raw)
    except (TypeError, ValueError):
        return None
    if number < 1:
        return None
    return number


def _partial(pp: dict[str, Any], partial_no: int) -> dict[str, Any] | None:
    for partial in pp.get("partials") or []:
        if not isinstance(partial, dict):
            continue
        if _partial_number(partial.get("pp_partial_no") or 1) == partial_no:
            return partial
    return None


def _partial_label(pp: dict[str, Any], partial_no: int) -> str:
    total = len(pp.get("partials") or []) or 1
    return f"{partial_no}/{max(total, partial_no)}"


def _sheet_edd(pp: dict[str, Any]) -> str:
    """Proposed EDD for a process sheet. Partials win; several dates stay listed."""
    dates: list[str] = []
    for partial in pp.get("partials") or []:
        if not isinstance(partial, dict):
            continue
        iso = _as_iso(partial.get("coway_proposed_edd"))
        if iso and iso not in dates:
            dates.append(iso)
    if not dates:
        return _as_iso(pp.get("coway_proposed_edd"))
    dates.sort()
    return ", ".join(dates)


def _edd_date(pp: dict[str, Any], partial: dict[str, Any] | None) -> str:
    if partial:
        edd = _as_iso(partial.get("coway_proposed_edd"))
        if edd:
            return edd
    return _as_iso(pp.get("coway_proposed_edd"))


def _exception_label(pp: dict[str, Any], partial_no: int) -> str:
    issues = pp.get("exception_issues") or {}
    raw = None
    if isinstance(issues, dict):
        raw = issues.get(partial_no)
        if raw is None:
            raw = issues.get(str(partial_no))
    selected: set[str] = set()
    values = raw if isinstance(raw, (list, tuple)) else [raw]
    for item in values:
        key = compact_text(item).lower().replace("-", "_").replace(" ", "_")
        if key in _ISSUE_LABELS:
            selected.add(key)
    ordered = [key for key in _ISSUE_ORDER if key in selected] or ["others"]
    return ", ".join(_ISSUE_LABELS[key] for key in ordered)


def _gap_label(day_gap: int) -> str:
    count = abs(day_gap)
    unit = "day" if count == 1 else "days"
    if day_gap > 0:
        return f"{count} {unit} late"
    return f"{count} {unit} early"


def _as_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = compact_text(value)
    if len(text) < 10:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _as_iso(value: Any) -> str:
    parsed = _as_date(value)
    return parsed.isoformat() if parsed else ""
