"""Sales-coordination view - APS/NPS process-sheet lines for delivery follow-up.

The page is a compressed APS/NPS commitment sheet. Customer remarks, Coway
remarks, and the committed schedule are planner edits. ERP supplies the
process sheet, PO, inventory, due date, and order quantity.
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
_REMARK_LIMIT = 2000
_UPDATE_LIMIT = 400
_BLANK_DATE = {"", "-", "—", "–", "−", "n/a", "na", "none", "blank"}


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


def _po_date(order: dict[str, Any], pp: dict[str, Any]) -> str | None:
    """Customer PO / sales-order date, then the posted date when ERP has no order date."""
    return _iso_date(
        order.get("order_date")
        or pp.get("order_date")
        or order.get("first_posted_datetime")
        or pp.get("posted_date")
    )


def _order_qty(pp: dict[str, Any], fallback: float | int | None) -> float | int | None:
    if pp.get("so_det_qty") not in (None, ""):
        parsed = _qty_number(pp.get("so_det_qty"))
        if parsed is not None:
            return parsed
    return fallback


def _posted_date(order: dict[str, Any], pp: dict[str, Any]) -> str | None:
    """S/O posted date — first posted datetime, else process-sheet / header order date."""
    return _iso_date(
        order.get("first_posted_datetime")
        or pp.get("order_date")
        or order.get("order_date")
        or pp.get("posted_date")
    )


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
    """Read-only Material Tracking In / Need fields for one PP voucher.

    Assembly parents prefer the Assembly Parts Tracker child rollup when present.
    """
    from .anticipated_material_service import material_subcon_is_arrived, parse_material_subcon_date

    raw = _compact(pp.get("assembly_material_subcon") or pp.get("material_subcon"))
    need = _iso_date(pp.get("material_need_date"))
    status_overlay = _compact(pp.get("assembly_material_status"))
    if material_subcon_is_arrived(raw):
        embedded = parse_material_subcon_date(raw)
        return {
            "material_status": status_overlay or "Arrived",
            "material_in_date": embedded.isoformat() if embedded else _iso_date(
                pp.get("assembly_material_in_date") or pp.get("material_in_date")
            ),
            "material_need_date": need,
        }
    expected = _iso_date(raw)
    if expected:
        return {
            "material_status": status_overlay or "Expected",
            "material_in_date": expected,
            "material_need_date": need,
        }
    return {
        "material_status": status_overlay or raw or "",
        "material_in_date": _iso_date(pp.get("assembly_material_in_date")),
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
                erp_customer_remarks = _compact(order.get("external_remarks"))
                erp_coway_remarks = _compact(pp.get("remarks"))

                lines.append(
                    {
                        "row_id": row_id,
                        "sales_order_no": so_no,
                        "customer_name": customer,
                        "pp_voucher_no": pp_voucher,
                        "process_sheet_no": process_sheet_no,
                        "pp_partial_no": p_no or 1,
                        "ps_type": typed,
                        "part_no": part_no,
                        "part_desc": part_desc,
                        "bom_code": bom_code,
                        "line_item_no": _compact(pp.get("source_line_item_no")),
                        "customer_po_no": _customer_po(order, pp, partial),
                        "due_date": due,
                        "po_date": _po_date(order, pp),
                        "posted_date": _posted_date(order, pp),
                        "qty": qty,
                        "order_qty": _order_qty(pp, qty),
                        "partial_qty": partial_qty,
                        "erp_customer_remarks": erp_customer_remarks,
                        "erp_coway_remarks": erp_coway_remarks,
                        "customer_remarks": erp_customer_remarks,
                        "coway_remarks": erp_coway_remarks,
                        "committed_schedule": None,
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


def _parse_commit_date(value: Any) -> date | None:
    parsed = _parse_date(value)
    if parsed is not None:
        return parsed
    text = _compact(value)[:8]
    for fmt in ("%d/%m/%y", "%d-%m-%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _edit_key(pp_voucher_no: Any, pp_partial_no: Any) -> tuple[str, int]:
    try:
        partial = int(pp_partial_no or 1)
    except (TypeError, ValueError):
        partial = 1
    return _compact(pp_voucher_no), max(partial, 1)


def _iso_from_db(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return _iso_date(value)


def normalize_coordination_update(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate one pasted or typed sales-coordination edit."""
    if not isinstance(raw, dict):
        raise ValueError("Each update must be an object")
    pp_voucher_no, partial_no = _edit_key(raw.get("pp_voucher_no"), raw.get("pp_partial_no"))
    if not pp_voucher_no:
        raise ValueError("Process sheet is required")
    out: dict[str, Any] = {
        "pp_voucher_no": pp_voucher_no,
        "pp_partial_no": partial_no,
    }
    if "customer_remarks" in raw:
        out["customer_remarks"] = _compact(raw.get("customer_remarks"))[:_REMARK_LIMIT]
    if "coway_remarks" in raw:
        out["coway_remarks"] = _compact(raw.get("coway_remarks"))[:_REMARK_LIMIT]
    if "committed_schedule" in raw:
        text = _compact(raw.get("committed_schedule"))
        if text.lower() in _BLANK_DATE:
            out["committed_schedule"] = None
        else:
            parsed = _parse_commit_date(text)
            if parsed is None:
                raise ValueError(f'"{text}" is not a date (dd/mm/yyyy)')
            out["committed_schedule"] = parsed.isoformat()
    if "customer_remarks" not in out and "coway_remarks" not in out and "committed_schedule" not in out:
        raise ValueError("Nothing to save")
    return out


def _ensure_coordination_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_sales_coordination (
            pp_voucher_no       TEXT         NOT NULL,
            pp_partial_no       INTEGER      NOT NULL DEFAULT 1,
            customer_remarks    TEXT,
            coway_remarks       TEXT,
            committed_schedule  DATE,
            updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (pp_voucher_no, pp_partial_no)
        )
        """
    )


def _load_coordination_edits() -> dict[tuple[str, int], dict[str, Any]]:
    from .helpers import planner_db, rows

    with planner_db() as con:
        _ensure_coordination_table(con)
        fetched = rows(
            con.execute(
                """
                SELECT pp_voucher_no, pp_partial_no, customer_remarks,
                       coway_remarks, committed_schedule
                FROM planner_sales_coordination
                """
            )
        )
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in fetched:
        key = _edit_key(row.get("pp_voucher_no"), row.get("pp_partial_no"))
        if not key[0]:
            continue
        out[key] = {
            "customer_remarks": None if row.get("customer_remarks") is None else _compact(row.get("customer_remarks")),
            "coway_remarks": None if row.get("coway_remarks") is None else _compact(row.get("coway_remarks")),
            "committed_schedule": _iso_from_db(row.get("committed_schedule")),
        }
    return out


def _attach_coordination_edits(lines: list[dict[str, Any]]) -> None:
    if not lines:
        return
    try:
        saved = _load_coordination_edits()
    except Exception as exc:
        logger.warning("sales coordination edits skipped: %s", exc)
        return
    for row in lines:
        edit = saved.get(_edit_key(row.get("pp_voucher_no"), row.get("pp_partial_no")))
        if not edit:
            continue
        if edit.get("customer_remarks") is not None:
            row["customer_remarks"] = edit["customer_remarks"]
        if edit.get("coway_remarks") is not None:
            row["coway_remarks"] = edit["coway_remarks"]
        row["committed_schedule"] = edit.get("committed_schedule")


def _upsert_coordination_edit(con, edit: dict[str, Any]) -> dict[str, Any]:
    from .helpers import one

    has_customer = "customer_remarks" in edit
    has_coway = "coway_remarks" in edit
    has_schedule = "committed_schedule" in edit
    saved = one(
        con.execute(
            """
            INSERT INTO planner_sales_coordination AS t (
                pp_voucher_no, pp_partial_no, customer_remarks, coway_remarks,
                committed_schedule, updated_at
            ) VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT (pp_voucher_no, pp_partial_no) DO UPDATE SET
                customer_remarks = CASE WHEN %s THEN EXCLUDED.customer_remarks ELSE t.customer_remarks END,
                coway_remarks = CASE WHEN %s THEN EXCLUDED.coway_remarks ELSE t.coway_remarks END,
                committed_schedule = CASE WHEN %s THEN EXCLUDED.committed_schedule ELSE t.committed_schedule END,
                updated_at = NOW()
            RETURNING pp_voucher_no, pp_partial_no, customer_remarks, coway_remarks, committed_schedule
            """,
            (
                edit["pp_voucher_no"],
                edit["pp_partial_no"],
                edit.get("customer_remarks"),
                edit.get("coway_remarks"),
                edit.get("committed_schedule"),
                has_customer,
                has_coway,
                has_schedule,
            ),
        )
    )
    if not saved:
        raise RuntimeError("Could not save sales coordination edit")
    return {
        "pp_voucher_no": _compact(saved.get("pp_voucher_no")),
        "pp_partial_no": int(saved.get("pp_partial_no") or 1),
        "customer_remarks": None if saved.get("customer_remarks") is None else _compact(saved.get("customer_remarks")),
        "coway_remarks": None if saved.get("coway_remarks") is None else _compact(saved.get("coway_remarks")),
        "committed_schedule": _iso_from_db(saved.get("committed_schedule")),
    }


def save_sales_coordination_edits(updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(updates, list) or not updates:
        raise ValueError("No updates.")
    if len(updates) > _UPDATE_LIMIT:
        raise ValueError(f"Save at most {_UPDATE_LIMIT} cells at once")
    merged: dict[tuple[str, int], dict[str, Any]] = {}
    for raw in updates:
        edit = normalize_coordination_update(raw)
        key = (edit["pp_voucher_no"], edit["pp_partial_no"])
        current = merged.get(key) or {
            "pp_voucher_no": edit["pp_voucher_no"],
            "pp_partial_no": edit["pp_partial_no"],
        }
        current.update(edit)
        merged[key] = current

    from .helpers import planner_db

    with planner_db() as con:
        _ensure_coordination_table(con)
        return [_upsert_coordination_edit(con, edit) for edit in merged.values()]


def build_sales_coordination(orders: list[dict[str, Any]]) -> dict[str, Any]:
    lines = expand_sales_coordination_lines(orders)
    _attach_bom_materials(lines)
    _attach_coordination_edits(lines)
    return {
        "ok": True,
        "line_count": len(lines),
        "lines": lines,
    }
