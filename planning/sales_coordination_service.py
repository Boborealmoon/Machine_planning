"""Sales-coordination view - APS/NPS process-sheet lines for delivery follow-up.

Buyer is editable here. Material status / dates / material codes are read-only
mirrors of Material Tracking. Order status is the work-order stage from ERP.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

from .so_outstanding_balance_service import commitment_date, ps_type, stage_label

logger = logging.getLogger(__name__)

_WEEKDAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)

_PS_TYPE_ORDER = ("APS", "NPS", "MPS", "PPS", "CPS", "SR")


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


def _qty_number(value: Any) -> float | int | None:
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num.is_integer():
        return int(num)
    return num


def _iso_date(value: Any) -> str | None:
    parsed = _parse_date(value)
    return parsed.isoformat() if parsed else None


def parse_material_tracking_fields(pp: dict[str, Any]) -> dict[str, Any]:
    """Read-only Material Tracking In / Need fields for one PP voucher."""
    raw = _compact(pp.get("material_subcon"))
    need = _iso_date(pp.get("material_need_date"))
    if raw.upper() == "ARRIVED":
        return {
            "material_status": "Arrived",
            "material_in_date": _iso_date(pp.get("material_in_date")),
            "material_need_date": need,
        }
    expected = _iso_date(raw)
    if expected:
        return {
            "material_status": "Expected",
            "material_in_date": expected,
            "material_need_date": need,
        }
    return {
        "material_status": raw or "",
        "material_in_date": None,
        "material_need_date": need,
    }


def _stage_fields(pp: dict[str, Any], partial: dict[str, Any] | None) -> dict[str, Any]:
    src = partial if partial is not None else pp
    return {
        "order_status": stage_label(pp, partial),
        "current_stage_desc": _compact(src.get("current_stage_desc") or pp.get("current_stage_desc")),
        "current_stage_status": _compact(
            src.get("current_stage_status") or pp.get("current_stage_status")
        ),
        "erp_stage_mode": _compact(src.get("erp_stage_mode") or pp.get("erp_stage_mode"))
        or "unassigned",
    }


def _ps_type_rank(ps_type_value: str) -> int:
    try:
        return _PS_TYPE_ORDER.index(ps_type_value)
    except ValueError:
        return len(_PS_TYPE_ORDER)


def _attach_bom_materials(lines: list[dict[str, Any]]) -> None:
    if not lines:
        return
    try:
        from .helpers import planner_db
        from .materials import material_inventory_codes_map
    except Exception:
        return

    keys = [(row.get("part_no"), row.get("bom_code")) for row in lines]
    try:
        with planner_db() as con:
            code_map = material_inventory_codes_map(con, keys)
    except Exception as exc:
        logger.warning("sales coordination material lookup skipped: %s", exc)
        return

    for row in lines:
        key = (_compact(row.get("part_no")), _compact(row.get("bom_code")))
        entries = code_map.get(key) or []
        codes = [
            _compact(entry.get("material_inventory_code"))
            for entry in entries
            if _compact(entry.get("material_inventory_code"))
        ]
        row["material"] = ", ".join(codes)
        row["material_codes"] = codes


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
            qty = _qty_number(pp.get("pp_qty") if pp.get("pp_qty") not in (None, "") else pp.get("so_det_qty"))
            material_view = parse_material_tracking_fields(pp)
            buyer = _compact(pp.get("buyer"))
            bom_code = _compact(pp.get("bom_code"))

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
                partial_qty = _qty_number(
                    (partial or {}).get("partial_qty") if partial is not None else qty
                )
                typed = ps_type(process_sheet_no)

                lines.append(
                    {
                        "row_id": row_id,
                        "sales_order_no": so_no,
                        "customer_name": customer,
                        "pp_voucher_no": pp_voucher,
                        "process_sheet_no": process_sheet_no,
                        "pp_partial_no": p_no,
                        "ps_type": typed,
                        "part_no": part_no,
                        "part_desc": part_desc,
                        "bom_code": bom_code,
                        "customer_po_no": _customer_po(order, pp, partial),
                        "due_date": due,
                        "qty": qty,
                        "partial_qty": partial_qty,
                        "buyer": buyer,
                        "material": "",
                        "material_codes": [],
                        "proposed_edd": coway,
                        "commitment_date": commit.isoformat() if commit else None,
                        "week": week_label(commit),
                        "is_frame_agreement": is_fa,
                        "is_new_part": is_new,
                        **material_view,
                        **_stage_fields(pp, partial),
                    }
                )

    lines.sort(
        key=lambda row: (
            _ps_type_rank(_compact(row.get("ps_type"))),
            row.get("due_date") or "9999-12-31",
            row.get("sales_order_no") or "",
            row.get("process_sheet_no") or "",
            row.get("pp_partial_no") or 0,
        )
    )
    return lines


def build_sales_coordination(orders: list[dict[str, Any]]) -> dict[str, Any]:
    lines = expand_sales_coordination_lines(orders)
    _attach_bom_materials(lines)
    return {
        "ok": True,
        "line_count": len(lines),
        "lines": lines,
    }
