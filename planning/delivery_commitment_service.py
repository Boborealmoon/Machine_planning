"""Saved delivery-month assignments for outstanding S/O lines.

A line keeps its PO due and Coway EDD. The planner assigns quantity into
one or more calendar months. Amount uses the outstanding-balance unit
(selling price, else unit cost) times quantity times exchange rate.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any

from .helpers import one, rows
from .so_outstanding_balance_service import _money

logger = logging.getLogger(__name__)

QTY_TOLERANCE = 0.0001
_SCHEMA_READY = False
_MIGRATION_PATH = Path(__file__).resolve().parent.parent / "migrations" / "add_delivery_commitment.sql"

_LINE_FIELDS = (
    "row_id",
    "sales_order_no",
    "source_line_item_no",
    "pp_voucher_no",
    "process_sheet_no",
    "pp_partial_no",
    "ps_type",
    "part_no",
    "part_desc",
    "status",
    "due_date",
    "coway_edd",
    "week",
    "commitment_date",
    "material_need_date",
    "material_in_date",
)


class AllocationError(ValueError):
    """Qty would exceed the open leftover, or the request is not usable."""


def _compact(value: Any) -> str:
    return str(value or "").strip()


def _qty_text(value: float) -> str:
    number = float(value)
    if abs(number - round(number)) <= QTY_TOLERANCE:
        return str(int(round(number)))
    return f"{number:.4f}".rstrip("0").rstrip(".")


def _round_qty(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(number, 4)


def _rate(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 1.0
    return number if number > 0 else 1.0


def _unit(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _date_text(value: Any) -> str | None:
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    text = _compact(value)[:10]
    return text or None


def plan_month_date(value: Any) -> date:
    """First day of the month named by a date, YYYY-MM, or YYYY-MM-DD."""
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        found = value
    else:
        text = _compact(value)
        if len(text) == 7 and text[4] == "-":
            text = f"{text}-01"
        found = None
        if text:
            try:
                found = date.fromisoformat(text[:10])
            except ValueError:
                found = None
            if found is None:
                for fmt in ("%d/%m/%Y", "%Y/%m/%d", "%m/%Y"):
                    try:
                        found = datetime.strptime(text[:10], fmt).date()
                        break
                    except ValueError:
                        continue
        if found is None:
            raise AllocationError("Choose a delivery month.")
    if found.year < 2000 or found.year > 2100:
        raise AllocationError("Choose a delivery month.")
    return date(found.year, found.month, 1)


def plan_month_key(value: Any) -> str:
    found = plan_month_date(value)
    return f"{found.year:04d}-{found.month:02d}"


def plan_month_label(value: Any) -> str:
    found = plan_month_date(value)
    return found.strftime("%b %Y")


def _sql_statements(sql: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        buf.append(line)
        if line.strip().endswith(";"):
            statement = "\n".join(buf).strip().rstrip(";").strip()
            if statement:
                parts.append(statement)
            buf = []
    tail = "\n".join(buf).strip().rstrip(";").strip()
    if tail:
        parts.append(tail)
    return parts


def ensure_delivery_commitment_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    sql = _MIGRATION_PATH.read_text(encoding="utf-8")
    for statement in _sql_statements(sql):
        con.execute(statement)
    _SCHEMA_READY = True


def _line_label(line: dict[str, Any] | None) -> str:
    if not line:
        return "That line"
    so_no = _compact(line.get("sales_order_no"))
    sheet = _compact(line.get("process_sheet_no") or line.get("pp_voucher_no"))
    text = " ".join(part for part in (so_no, sheet) if part)
    return text or "That line"


def _fail(line: dict[str, Any] | None, message: str) -> None:
    raise AllocationError(f"{_line_label(line)}: {message}")


def allocated_qty(slices: list[dict[str, Any]]) -> float:
    return _round_qty(sum(_round_qty(item.get("qty")) for item in slices))


def slice_qty(slices: list[dict[str, Any]], month: str) -> float:
    return _round_qty(
        sum(_round_qty(item.get("qty")) for item in slices if item.get("plan_month") == month)
    )


def _check_total(
    line: dict[str, Any] | None,
    open_qty: float,
    old_total: float,
    new_total: float,
    month_qty: float,
) -> None:
    if new_total > float(open_qty) + QTY_TOLERANCE and new_total > old_total + QTY_TOLERANCE:
        _fail(
            line,
            f"quantity {_qty_text(month_qty)} exceeds open qty {_qty_text(open_qty)}.",
        )


def propose_add(
    open_qty: float,
    slices: list[dict[str, Any]],
    plan_month: Any,
    add_qty: float,
    *,
    line: dict[str, Any] | None = None,
) -> float:
    """Absolute qty for plan_month after adding add_qty onto that month."""
    add = _round_qty(add_qty)
    if add <= QTY_TOLERANCE:
        _fail(line, "quantity must be greater than zero.")
    month = plan_month_key(plan_month)
    existing = slice_qty(slices, month)
    new_qty = _round_qty(existing + add)
    old_total = allocated_qty(slices)
    new_total = _round_qty(old_total - existing + new_qty)
    _check_total(line, open_qty, old_total, new_total, new_qty)
    return new_qty


def propose_set(
    open_qty: float,
    slices: list[dict[str, Any]],
    plan_month: Any,
    qty: float,
    *,
    line: dict[str, Any] | None = None,
) -> float:
    """Absolute qty for plan_month. A lower qty is allowed while over-allocated."""
    new_qty = _round_qty(qty)
    if new_qty <= QTY_TOLERANCE:
        _fail(line, "quantity must be greater than zero.")
    month = plan_month_key(plan_month)
    existing = slice_qty(slices, month)
    old_total = allocated_qty(slices)
    new_total = _round_qty(old_total - existing + new_qty)
    _check_total(line, open_qty, old_total, new_total, new_qty)
    return new_qty


def _replace_month(
    slices: list[dict[str, Any]],
    month: str,
    qty: float,
    *,
    commitment_id: int | None = None,
) -> list[dict[str, Any]]:
    kept = [dict(item) for item in slices if item.get("plan_month") != month]
    row = {"plan_month": month, "qty": qty}
    if commitment_id is not None:
        row["commitment_id"] = commitment_id
    kept.append(row)
    kept.sort(key=lambda item: item.get("plan_month") or "")
    return kept


def prepare_adds(
    lines_by_id: dict[str, dict[str, Any]],
    commitments: list[dict[str, Any]],
    plan_month: Any,
    items: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], date, float]]:
    """Validate a batch. Each item qty is added onto that month (blank = left qty)."""
    if not items:
        raise AllocationError("Select at least one line.")
    month = plan_month_date(plan_month)
    month_key = plan_month_key(month)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in commitments:
        grouped.setdefault(_compact(item.get("row_id")), []).append(dict(item))
    finals: dict[str, tuple[dict[str, Any], date, float]] = {}
    for item in items:
        row_id = _compact(item.get("row_id"))
        if not row_id:
            raise AllocationError("Missing line.")
        line = lines_by_id.get(row_id)
        if line is None:
            raise AllocationError("That line is no longer open.")
        slices = grouped.get(row_id, [])
        raw_qty = item.get("qty")
        if raw_qty is None or raw_qty == "":
            add = _round_qty(float(line.get("remaining_qty") or 0) - allocated_qty(slices))
            if add <= QTY_TOLERANCE:
                _fail(line, "nothing left to assign.")
        else:
            try:
                add = float(raw_qty)
            except (TypeError, ValueError):
                _fail(line, "quantity must be a number.")
        new_qty = propose_add(
            float(line.get("remaining_qty") or 0),
            slices,
            month,
            add,
            line=line,
        )
        existing_id = next(
            (
                entry.get("commitment_id")
                for entry in slices
                if entry.get("plan_month") == month_key and entry.get("commitment_id") is not None
            ),
            None,
        )
        grouped[row_id] = _replace_month(slices, month_key, new_qty, commitment_id=existing_id)
        finals[row_id] = (line, month, new_qty)
    return list(finals.values())


def format_plan_months(slices: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in sorted(slices, key=lambda row: row.get("plan_month") or ""):
        parts.append(f"{plan_month_label(item.get('plan_month'))} ({_qty_text(item.get('qty') or 0)})")
    return " · ".join(parts)


def _public_slices(slices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in sorted(slices, key=lambda row: row.get("plan_month") or ""):
        row = {
            "plan_month": plan_month_key(item.get("plan_month")),
            "qty": _round_qty(item.get("qty")),
        }
        if item.get("commitment_id") is not None:
            row["commitment_id"] = int(item["commitment_id"])
        out.append(row)
    return out


def _joined_row(
    source: dict[str, Any],
    slices: list[dict[str, Any]],
    *,
    open_qty: float,
    no_longer_open: bool,
) -> dict[str, Any]:
    public = _public_slices(slices)
    allocated = allocated_qty(public)
    left = 0.0 if no_longer_open else _round_qty(max(0.0, float(open_qty) - allocated))
    unit = _unit(source.get("unit_cost"))
    if unit is None:
        unit = _unit(source.get("unit_selling_price"))
    exch = _rate(source.get("exch_rate"))
    amount_qty = allocated if public else float(open_qty)
    over = (not no_longer_open) and allocated > float(open_qty) + QTY_TOLERANCE
    row = {field: source.get(field) for field in _LINE_FIELDS}
    row.update(
        {
            "unit_cost": unit,
            "exch_rate": exch,
            "open_qty": _round_qty(open_qty),
            "allocated_qty": allocated,
            "left_qty": left,
            "amount": _money(unit, amount_qty, exch),
            "slices": public,
            "plan_months": [item["plan_month"] for item in public],
            "plan_month_label": format_plan_months(public),
            "over_allocated": over,
            "no_longer_open": no_longer_open,
        }
    )
    return row


def _snapshot_source(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "row_id": item.get("row_id"),
        "sales_order_no": item.get("sales_order_no") or "",
        "source_line_item_no": item.get("source_line_item_no") or "",
        "pp_voucher_no": item.get("pp_voucher_no") or "",
        "process_sheet_no": item.get("process_sheet_no") or "",
        "pp_partial_no": item.get("pp_partial_no") or None,
        "ps_type": item.get("ps_type") or "",
        "part_no": item.get("part_no") or "",
        "part_desc": item.get("part_desc") or "",
        "status": item.get("status") or "",
        "due_date": _date_text(item.get("due_date")),
        "coway_edd": _date_text(item.get("coway_edd")),
        "week": item.get("week") or item.get("week_label") or "",
        "commitment_date": _date_text(item.get("commitment_date")),
        "unit_cost": item.get("unit_cost"),
        "unit_selling_price": item.get("unit_selling_price"),
        "exch_rate": item.get("exch_rate"),
    }


def join_delivery_lines(
    lines: list[dict[str, Any]],
    commitments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach saved slices. Commitments whose line has left the report stay, flagged closed."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in commitments:
        row_id = _compact(item.get("row_id"))
        if not row_id:
            continue
        grouped.setdefault(row_id, []).append(item)

    seen: set[str] = set()
    joined: list[dict[str, Any]] = []
    for line in lines:
        row_id = _compact(line.get("row_id"))
        if not row_id:
            continue
        seen.add(row_id)
        joined.append(
            _joined_row(
                line,
                grouped.get(row_id, []),
                open_qty=float(line.get("remaining_qty") or 0),
                no_longer_open=False,
            )
        )

    for row_id, slices in grouped.items():
        if row_id in seen:
            continue
        source = _snapshot_source(slices[0])
        source["row_id"] = row_id
        joined.append(
            _joined_row(source, slices, open_qty=0.0, no_longer_open=True)
        )

    joined.sort(
        key=lambda row: (
            1 if row.get("no_longer_open") else 0,
            0 if row.get("over_allocated") else 1,
            row.get("due_date") or "9999-12-31",
            row.get("sales_order_no") or "",
            row.get("process_sheet_no") or "",
            row.get("pp_partial_no") or 0,
        )
    )
    return joined


def month_totals(lines: list[dict[str, Any]], focus: str | None) -> dict[str, Any]:
    """Totals for All, Unassigned, or one YYYY-MM chip.

    A month chip sums that month's slice only, so a split line is not
    counted in full on every month.
    """
    key = _compact(focus).lower()
    qty = 0.0
    amount = 0.0
    count = 0
    for line in lines:
        unit = _unit(line.get("unit_cost"))
        exch = line.get("exch_rate")
        if key in ("", "all"):
            count += 1
            if line.get("slices"):
                qty += float(line.get("allocated_qty") or 0)
            else:
                qty += float(line.get("open_qty") or 0)
            amount += float(line.get("amount") or 0)
            continue
        if key == "unassigned":
            if line.get("no_longer_open"):
                continue
            left = float(line.get("left_qty") or 0)
            if left <= QTY_TOLERANCE:
                continue
            count += 1
            qty += left
            amount += _money(unit, left, exch)
            continue
        month = plan_month_key(key)
        matched = next(
            (item for item in line.get("slices") or [] if item.get("plan_month") == month),
            None,
        )
        if matched is None:
            continue
        count += 1
        slice_amount_qty = float(matched.get("qty") or 0)
        qty += slice_amount_qty
        amount += _money(unit, slice_amount_qty, exch)
    return {
        "line_count": count,
        "qty": _round_qty(qty),
        "amount": round(amount, 2),
    }


def build_commitment_view(
    lines: list[dict[str, Any]],
    commitments: list[dict[str, Any]],
    *,
    year: int,
) -> dict[str, Any]:
    year = max(2000, min(2100, int(year)))
    joined = join_delivery_lines(lines, commitments)
    summary = month_totals(joined, None)
    summary["unassigned_count"] = month_totals(joined, "unassigned")["line_count"]
    summary["over_allocated_count"] = sum(1 for row in joined if row.get("over_allocated"))
    summary["closed_count"] = sum(1 for row in joined if row.get("no_longer_open"))
    return {
        "ok": True,
        "year": year,
        "commitment_rule": "planner_assigned_month",
        "currency_note": (
            "Assigned amount = unit x allocated qty x exchange rate. "
            "Unassigned amount = unit x open qty x exchange rate."
        ),
        "default_ps_types": ["APS", "NPS"],
        "lines": joined,
        "summary": summary,
    }


def _normalize_commitment(row: dict[str, Any]) -> dict[str, Any]:
    partial = int(row.get("pp_partial_no") or 0)
    return {
        "commitment_id": int(row["commitment_id"]),
        "row_id": _compact(row.get("row_id")),
        "plan_month": plan_month_key(row.get("plan_month")),
        "qty": _round_qty(row.get("qty")),
        "sales_order_no": row.get("sales_order_no") or "",
        "source_line_item_no": row.get("source_line_item_no") or "",
        "pp_voucher_no": row.get("pp_voucher_no") or "",
        "process_sheet_no": row.get("process_sheet_no") or "",
        "pp_partial_no": partial or None,
        "ps_type": row.get("ps_type") or "",
        "part_no": row.get("part_no") or "",
        "part_desc": row.get("part_desc") or "",
        "unit_cost": _unit(row.get("unit_cost")),
        "exch_rate": None if row.get("exch_rate") is None else _rate(row.get("exch_rate")),
        "status": row.get("status") or "",
        "due_date": _date_text(row.get("due_date")),
        "coway_edd": _date_text(row.get("coway_edd")),
        "week": row.get("week_label") or "",
    }


def load_commitments(con) -> list[dict[str, Any]]:
    ensure_delivery_commitment_schema(con)
    loaded = rows(
        con.execute(
            """
            SELECT commitment_id, row_id, sales_order_no, source_line_item_no,
                   pp_voucher_no, process_sheet_no, pp_partial_no, ps_type,
                   part_no, part_desc, unit_cost, exch_rate, status,
                   due_date, coway_edd, week_label, plan_month, qty
            FROM public.planner_delivery_commitment
            ORDER BY plan_month, row_id
            """
        )
    )
    return [_normalize_commitment(row) for row in loaded]


def _snapshot_params(source: dict[str, Any], plan_month: date, qty: float) -> tuple:
    unit = _unit(source.get("unit_cost"))
    if unit is None:
        unit = _unit(source.get("unit_selling_price"))
    exch = source.get("exch_rate")
    try:
        exch_value = None if exch is None or exch == "" else float(exch)
    except (TypeError, ValueError):
        exch_value = None
    partial = source.get("pp_partial_no")
    try:
        partial_no = int(partial or 0)
    except (TypeError, ValueError):
        partial_no = 0
    due = _date_text(source.get("due_date"))
    coway = _date_text(source.get("coway_edd"))
    return (
        _compact(source.get("row_id")),
        _compact(source.get("sales_order_no")),
        _compact(source.get("source_line_item_no")),
        _compact(source.get("pp_voucher_no")),
        _compact(source.get("process_sheet_no")),
        partial_no,
        _compact(source.get("ps_type")),
        _compact(source.get("part_no")),
        _compact(source.get("part_desc")),
        unit,
        exch_value,
        _compact(source.get("status")),
        date.fromisoformat(due) if due else None,
        date.fromisoformat(coway) if coway else None,
        _compact(source.get("week") or source.get("week_label")),
        plan_month,
        qty,
    )


def upsert_commitment(con, source: dict[str, Any], plan_month: date, qty: float) -> None:
    ensure_delivery_commitment_schema(con)
    con.execute(
        """
        INSERT INTO public.planner_delivery_commitment (
            row_id, sales_order_no, source_line_item_no, pp_voucher_no,
            process_sheet_no, pp_partial_no, ps_type, part_no, part_desc,
            unit_cost, exch_rate, status, due_date, coway_edd, week_label,
            plan_month, qty, updated_at
        ) VALUES (
            %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s, %s,
            %s, %s, NOW()
        )
        ON CONFLICT (row_id, plan_month) DO UPDATE SET
            sales_order_no = EXCLUDED.sales_order_no,
            source_line_item_no = EXCLUDED.source_line_item_no,
            pp_voucher_no = EXCLUDED.pp_voucher_no,
            process_sheet_no = EXCLUDED.process_sheet_no,
            pp_partial_no = EXCLUDED.pp_partial_no,
            ps_type = EXCLUDED.ps_type,
            part_no = EXCLUDED.part_no,
            part_desc = EXCLUDED.part_desc,
            unit_cost = EXCLUDED.unit_cost,
            exch_rate = EXCLUDED.exch_rate,
            status = EXCLUDED.status,
            due_date = EXCLUDED.due_date,
            coway_edd = EXCLUDED.coway_edd,
            week_label = EXCLUDED.week_label,
            qty = EXCLUDED.qty,
            updated_at = NOW()
        """,
        _snapshot_params(source, plan_month, qty),
    )


def delete_commitment(con, commitment_id: int) -> bool:
    ensure_delivery_commitment_schema(con)
    deleted = one(
        con.execute(
            """
            DELETE FROM public.planner_delivery_commitment
            WHERE commitment_id = %s
            RETURNING commitment_id
            """,
            (int(commitment_id),),
        )
    )
    return deleted is not None


def _find_commitment(commitments: list[dict[str, Any]], commitment_id: int) -> dict[str, Any]:
    found = next(
        (item for item in commitments if int(item.get("commitment_id") or 0) == int(commitment_id)),
        None,
    )
    if found is None:
        raise LookupError("That assignment is no longer saved.")
    return found


def _line_for_commitment(
    lines_by_id: dict[str, dict[str, Any]],
    commitment: dict[str, Any],
) -> tuple[dict[str, Any], float]:
    row_id = _compact(commitment.get("row_id"))
    live = lines_by_id.get(row_id)
    if live is not None:
        return live, float(live.get("remaining_qty") or 0)
    return _snapshot_source(commitment), 0.0


def plan_whole_month_assign(
    line: dict[str, Any],
    slices: list[dict[str, Any]],
    plan_month: Any,
) -> tuple[date, float, list[int]]:
    """Put the line's full open qty in one month and drop every other month."""
    month = plan_month_date(plan_month)
    month_key = plan_month_key(month)
    open_qty = _round_qty(line.get("remaining_qty") or 0)
    if open_qty <= QTY_TOLERANCE:
        _fail(line, "nothing left to assign.")
    drop = [
        int(item["commitment_id"])
        for item in slices
        if item.get("plan_month") != month_key and item.get("commitment_id") is not None
    ]
    return month, open_qty, drop


def save_adds(
    con,
    lines_by_id: dict[str, dict[str, Any]],
    plan_month: Any,
    items: list[dict[str, Any]],
) -> None:
    commitments = load_commitments(con)
    planned = prepare_adds(lines_by_id, commitments, plan_month, items)
    for line, month, qty in planned:
        upsert_commitment(con, line, month, qty)


def save_assign_month(
    con,
    lines_by_id: dict[str, dict[str, Any]],
    plan_month: Any,
    items: list[dict[str, Any]],
) -> None:
    """Assign each line's full open qty to one month."""
    if not items:
        raise AllocationError("Select at least one line.")
    commitments = load_commitments(con)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in commitments:
        grouped.setdefault(_compact(item.get("row_id")), []).append(item)
    for item in items:
        row_id = _compact(item.get("row_id"))
        if not row_id:
            raise AllocationError("Missing line.")
        line = lines_by_id.get(row_id)
        if line is None:
            raise AllocationError("That line is no longer open.")
        month, qty, drop_ids = plan_whole_month_assign(
            line, grouped.get(row_id, []), plan_month
        )
        for commitment_id in drop_ids:
            delete_commitment(con, commitment_id)
        upsert_commitment(con, line, month, qty)


def save_qty(
    con,
    lines_by_id: dict[str, dict[str, Any]],
    commitment_id: int,
    qty: Any,
) -> None:
    commitments = load_commitments(con)
    current = _find_commitment(commitments, commitment_id)
    line, open_qty = _line_for_commitment(lines_by_id, current)
    siblings = [
        item for item in commitments if _compact(item.get("row_id")) == _compact(current.get("row_id"))
    ]
    try:
        number = float(qty)
    except (TypeError, ValueError):
        _fail(line, "quantity must be a number.")
    new_qty = propose_set(open_qty, siblings, current["plan_month"], number, line=line)
    upsert_commitment(con, line, plan_month_date(current["plan_month"]), new_qty)


def save_move(
    con,
    lines_by_id: dict[str, dict[str, Any]],
    commitment_id: int,
    plan_month: Any,
) -> None:
    commitments = load_commitments(con)
    current = _find_commitment(commitments, commitment_id)
    target = plan_month_date(plan_month)
    target_key = plan_month_key(target)
    if current.get("plan_month") == target_key:
        return
    line, _open_qty = _line_for_commitment(lines_by_id, current)
    siblings = [
        item for item in commitments if _compact(item.get("row_id")) == _compact(current.get("row_id"))
    ]
    existing = next(
        (item for item in siblings if item.get("plan_month") == target_key),
        None,
    )
    merged = _round_qty(
        float(current.get("qty") or 0) + (float(existing.get("qty") or 0) if existing else 0)
    )
    # Total qty is unchanged, so an over-allocated line can still be moved.
    upsert_commitment(con, line, target, merged)
    delete_commitment(con, int(commitment_id))
