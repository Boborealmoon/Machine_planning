"""Simple PS material calc: (per_unit + buffer) * order_qty = target."""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from .utils import compact_text, parse_number


def _num(value, default=0.0) -> float:
    return parse_number(value, default)


# Length-style units (issued as length)
_LENGTH_UOMS = frozenset({"MM", "M", "CM", "IN", "FT"})
# Count-style units (issued as pieces)
_PIECE_UOMS = frozenset(
    {
        "PCS",
        "PC",
        "PCE",
        "EA",
        "EACH",
        "PIECE",
        "PIECES",
        "SET",
        "SETS",
        "NOS",
        "NO",
        "UNIT",
        "UNITS",
    }
)


def normalize_uom(raw) -> str:
    """
    Canonical UOM label for UI/storage.
    Returns 'mm', 'pcs', 'kg', 'm', or the compact original lowercased token.
    """
    text = compact_text(raw).upper().replace(".", "")
    if not text:
        return "mm"
    if text in ("MM", "MILLIMETER", "MILLIMETRE"):
        return "mm"
    if text in ("M", "METER", "METRE"):
        return "m"
    if text in _PIECE_UOMS:
        return "pcs"
    if text in ("KG", "KGS", "KILOGRAM", "KILOGRAMS"):
        return "kg"
    if text in ("G", "GRAM", "GRAMS"):
        return "g"
    return text.lower()


def uom_kind(uom) -> str:
    """'length' | 'count' | 'mass' | 'other' - drives labels."""
    u = normalize_uom(uom)
    if u in ("mm", "m", "cm", "in", "ft") or u.upper() in _LENGTH_UOMS:
        return "length"
    if u == "pcs" or u.upper() in _PIECE_UOMS:
        return "count"
    if u in ("kg", "g"):
        return "mass"
    return "other"


def uom_label(uom) -> str:
    u = normalize_uom(uom)
    return {"mm": "mm", "m": "m", "pcs": "pcs", "kg": "kg", "g": "g"}.get(u, u)


def normalize_cnc_machines(raw) -> list[str]:
    """Accept list/tuple of machine codes, or comma-separated string."""
    out = []
    seen = set()
    items = raw
    if isinstance(raw, str):
        items = [p.strip() for p in raw.split(",")]
    if not isinstance(items, (list, tuple)):
        return out
    for item in items:
        code = compact_text(item)
        if not code:
            continue
        key = code.upper()
        if key in seen:
            continue
        seen.add(key)
        out.append(code)
    return out


def normalize_op_assignments(raw) -> list[dict]:
    """Accept list of {op_no, cnc, operator} rows for production slip fields."""
    import json

    items = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            items = json.loads(text)
        except Exception:
            return []
    if not isinstance(items, (list, tuple)):
        return []
    out: list[dict] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        op_no = item.get("op_no")
        if op_no is None or str(op_no).strip() == "":
            continue
        try:
            if isinstance(op_no, str) and op_no.strip().isdigit():
                op_no = int(op_no.strip())
            elif isinstance(op_no, float):
                op_no = int(op_no)
        except Exception:
            pass
        label = compact_text(item.get("operation_label"))
        if not label:
            label = f"Operation {op_no}"
        out.append(
            {
                "op_no": op_no,
                "operation_label": label,
                "stage_desc": compact_text(item.get("stage_desc")),
                "cnc": compact_text(item.get("cnc") or item.get("machine")),
                "operator": compact_text(item.get("operator")),
            }
        )
    return out


def cnc_machines_from_assignments(assignments: Sequence[Mapping] | None) -> list[str]:
    return normalize_cnc_machines(
        [compact_text(a.get("cnc")) for a in (assignments or []) if isinstance(a, Mapping)]
    )


def normalize_issued_batches(raw) -> list[dict]:
    """Accept list of {batch_no, length_mm|qty} or empty. Stores as length_mm column."""
    out = []
    if not isinstance(raw, (list, tuple)):
        return out
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        amount = item.get("length_mm")
        if amount is None or amount == "":
            amount = item.get("qty")
        length = max(0.0, _num(amount))
        batch_no = compact_text(item.get("batch_no"))
        if length <= 0 and not batch_no:
            continue
        out.append({"batch_no": batch_no, "length_mm": length})
    return out


def compute_calc(inputs: Mapping[str, Any], issued_batches: Sequence[Mapping] | None = None) -> dict:
    """
    material_per_unit + buffer = amount per order unit
    target = order_qty * amount_per_unit
    returnable = sum(issued) - target
    Unit is informational (mm / pcs / kg); math is the same.
    """
    per_unit = max(0.0, _num(inputs.get("material_per_unit_mm") or inputs.get("finished_part_length_mm")))
    buffer_mm = max(0.0, _num(inputs.get("buffer_length_mm") or inputs.get("clamp_length_op1_mm")))
    order_qty = max(0.0, _num(inputs.get("order_qty")))
    uom = normalize_uom(inputs.get("material_uom"))

    length_per_piece = per_unit + buffer_mm
    target_mm = order_qty * length_per_piece

    batches = normalize_issued_batches(
        issued_batches if issued_batches is not None else inputs.get("issued_batches")
    )
    issued_total = sum(b["length_mm"] for b in batches)
    if not batches:
        issued_total = max(0.0, _num(inputs.get("issued_length_mm")))

    returnable = issued_total - target_mm

    return {
        "material_uom": uom,
        "material_per_unit_mm": round(per_unit, 4),
        "buffer_length_mm": round(buffer_mm, 4),
        "order_qty": order_qty,
        "length_per_piece_mm": round(length_per_piece, 4),
        "target_total_mm": round(target_mm, 4),
        "issued_total_mm": round(issued_total, 4),
        "returnable_mm": round(returnable, 4),
        "issued_batches": batches,
    }


def row_to_payload(row: Mapping[str, Any] | None, issued_batches=None) -> dict | None:
    if not row:
        return None
    batches = issued_batches if issued_batches is not None else []
    merged = dict(row)
    if "material_per_unit_mm" not in merged or merged.get("material_per_unit_mm") is None:
        merged["material_per_unit_mm"] = row.get("finished_part_length_mm")
    if "buffer_length_mm" not in merged or merged.get("buffer_length_mm") is None:
        merged["buffer_length_mm"] = row.get("clamp_length_op1_mm")
    if not compact_text(merged.get("material_uom")):
        merged["material_uom"] = "mm"
    merged["issued_batches"] = batches
    computed = compute_calc(merged, batches)
    uom = computed["material_uom"]
    slip_raw = row.get("slip_date")
    if hasattr(slip_raw, "isoformat"):
        slip_date = slip_raw.isoformat()[:10]
    else:
        slip_date = compact_text(slip_raw)[:10] if slip_raw else ""
    return {
        "calc_id": row.get("calc_id"),
        "planner_ps_id": compact_text(row.get("planner_ps_id")),
        "part_no": compact_text(row.get("part_no")),
        "material_type_grade": compact_text(row.get("material_type_grade")),
        "material_uom": uom,
        "uom_kind": uom_kind(uom),
        "uom_label": uom_label(uom),
        "slip_date": slip_date,
        "order_qty": computed["order_qty"],
        "material_per_unit_mm": computed["material_per_unit_mm"],
        "buffer_length_mm": computed["buffer_length_mm"],
        "length_per_piece_mm": computed["length_per_piece_mm"],
        "target_total_mm": computed["target_total_mm"],
        "issued_total_mm": computed["issued_total_mm"],
        "returnable_mm": computed["returnable_mm"],
        "issued_batches": batches,
        "cnc_machines": normalize_cnc_machines(row.get("cnc_machines")),
        "op_assignments": normalize_op_assignments(row.get("op_assignments")),
        "stock_in_operator": compact_text(row.get("stock_in_operator")),
        "stock_out_operator": compact_text(row.get("stock_out_operator")),
        "remarks": compact_text(row.get("remarks")),
        "created_at": compact_text(row.get("created_at")),
        "updated_at": compact_text(row.get("updated_at")),
    }
