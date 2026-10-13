"""Trace a process sheet from its pushed BOM to allocated batch / heat numbers.

Live COMAIN path:

* ``mfg_pp_vch`` is the process sheet.
* ``mfg_pp_partial_bom_stage_mat`` is the BOM pushed onto that sheet.
  The finished-good rows are the line items. On a special BOM each line is a
  sub-part, and that sub-part has its own pushed material rows on the same
  voucher (``inventory_code`` = the sub-part).
* ``ic_stk_alloc_vch`` holds the MRP allocation, joined through
  ``mfg_mps_vch.source_pp_no``. ``mfg_mps_vch.own_inventory_code`` is the
  sub-part that job belongs to, so a shared material is not copied onto
  every line.
* The batch is the reference snapshotted on ``ic_stk_issue_mat_lot`` when the
  lot was issued to that job. Inventory lot references are only a fallback
  for material that is allocated and not yet issued.
"""
from __future__ import annotations

from typing import Any

from .staged_erp import live_query
from .utils import compact_text, parse_number

_QUERY_TIMEOUT_MS = 30000


def _key(value: Any) -> str:
    return compact_text(value).upper()


def _qty(value: Any) -> float | int | None:
    if value is None or value == "":
        return None
    number = parse_number(value, 0)
    if abs(number - round(number)) < 1e-9:
        return int(round(number))
    return round(number, 4)


def _line_no(value: Any) -> str:
    number = _qty(value)
    if number is None:
        return ""
    return str(number)


def _in_house(value: Any) -> bool:
    return _key(value) == "Y"


def lot_identity(rows: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Pick the batch/heat reference that still holds the allocation."""

    def rank(row: dict[str, Any]) -> tuple[int, str]:
        ref = compact_text(row.get("reference_no"))
        allocated = parse_number(row.get("allocation_qty"), 0)
        remaining = parse_number(row.get("remaining_qty"), 0)
        if ref and allocated > 0:
            return (0, ref)
        if ref and remaining > 0:
            return (1, ref)
        if ref:
            return (2, ref)
        return (3, "")

    ordered = sorted(rows or [], key=rank)
    refs: list[str] = []
    seen: set[str] = set()
    for row in ordered:
        ref = compact_text(row.get("reference_no"))
        if not ref or ref in seen:
            continue
        seen.add(ref)
        refs.append(ref)
    return {
        "batch_no": refs[0] if refs else "",
        "other_refs": refs[1:],
    }


def _dedupe_allocations(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()
    for row in rows or []:
        lot_no = int(parse_number(row.get("lot_no"), 0))
        key = (compact_text(row.get("alloc_voucher_no")), _key(row.get("inventory_code")), lot_no)
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _lots_by_material(rows: list[dict[str, Any]] | None) -> dict[tuple[str, int], list[dict[str, Any]]]:
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for row in rows or []:
        lot_no = int(parse_number(row.get("lot_no"), 0))
        grouped.setdefault((_key(row.get("inventory_code")), lot_no), []).append(row)
    return grouped


def _issued_indexes(
    rows: list[dict[str, Any]] | None,
) -> tuple[dict[tuple[str, str, int, str], str], dict[tuple[str, str, int], set[str]]]:
    """Batch reference written onto the job at issue time."""
    exact: dict[tuple[str, str, int, str], str] = {}
    loose: dict[tuple[str, str, int], set[str]] = {}
    for row in rows or []:
        ref = compact_text(row.get("reference_no"))
        if not ref:
            continue
        own = _key(row.get("own_inventory_code"))
        code = _key(row.get("inventory_code"))
        lot_no = int(parse_number(row.get("lot_no"), 0))
        mps = compact_text(row.get("mps_voucher_no"))
        exact.setdefault((own, code, lot_no, mps), ref)
        loose.setdefault((own, code, lot_no), set()).add(ref)
    return exact, loose


def _issued_batch(
    row: dict[str, Any],
    exact: dict[tuple[str, str, int, str], str],
    loose: dict[tuple[str, str, int], set[str]],
) -> str:
    own = _key(row.get("own_inventory_code"))
    code = _key(row.get("inventory_code"))
    lot_no = int(parse_number(row.get("lot_no"), 0))
    mps = compact_text(row.get("alloc_to_voucher_no") or row.get("mps_voucher_no"))
    snapped = exact.get((own, code, lot_no, mps))
    if snapped:
        return snapped
    refs = loose.get((own, code, lot_no)) or set()
    if len(refs) == 1:
        return next(iter(refs))
    return ""


def _alloc_payload(
    row: dict[str, Any],
    lots: dict[tuple[str, int], list[dict[str, Any]]],
    exact: dict[tuple[str, str, int, str], str],
    loose: dict[tuple[str, str, int], set[str]],
) -> dict[str, Any]:
    lot_no = int(parse_number(row.get("lot_no"), 0))
    issued_batch = _issued_batch(row, exact, loose)
    identity = lot_identity(lots.get((_key(row.get("inventory_code")), lot_no), []))
    return {
        "alloc_voucher_no": compact_text(row.get("alloc_voucher_no")),
        "mps_voucher_no": compact_text(row.get("alloc_to_voucher_no")),
        "work_order_no": compact_text(row.get("wo_voucher_no")),
        "lot_no": lot_no,
        "batch_no": issued_batch or identity["batch_no"],
        "other_refs": [],
        "alloc_qty": _qty(row.get("alloc_qty")),
        "remain_qty": _qty(row.get("remain_alloc_qty")),
        "issued_qty": _qty(row.get("issued_alloc_qty")),
    }


def _allocations_for_job(
    allocations: list[dict[str, Any]],
    material_code: str,
    job_part: str,
    fg_key: str,
) -> tuple[list[dict[str, Any]], bool]:
    """Keep the lots assigned to this sub-part's job.

    Returns (rows, shared). ``shared`` is true only when the same material
    lots could not be tied to one job and are repeated across lines.
    """
    code = _key(material_code)
    candidates = [row for row in allocations if _key(row.get("inventory_code")) == code]
    if not job_part:
        return candidates, False
    owned = [row for row in candidates if _key(row.get("own_inventory_code")) == _key(job_part)]
    if owned:
        return owned, False
    unassigned = [
        row
        for row in candidates
        if not _key(row.get("own_inventory_code")) or _key(row.get("own_inventory_code")) == fg_key
    ]
    return unassigned, bool(unassigned)


def _material_payload(
    row: dict[str, Any],
    allocations: list[dict[str, Any]],
    lots: dict[tuple[str, int], list[dict[str, Any]]],
    descriptions: dict[str, str],
    exact: dict[tuple[str, str, int, str], str],
    loose: dict[tuple[str, str, int], set[str]],
    *,
    job_part: str,
    fg_key: str,
    material_on_other_lines: bool,
) -> dict[str, Any]:
    code = compact_text(row.get("material_inventory_code"))
    matched_rows, fell_back = _allocations_for_job(allocations, code, job_part, fg_key)
    matched = [_alloc_payload(item, lots, exact, loose) for item in matched_rows]
    matched.sort(key=lambda item: (item["lot_no"], item["alloc_voucher_no"]))
    return {
        "inventory_code": code,
        "description": descriptions.get(_key(code), ""),
        "bom_code": compact_text(row.get("bom_code")),
        "qty": _qty(row.get("qty")),
        "shared": fell_back and material_on_other_lines,
        "allocations": matched,
    }


def build_trace(
    header: dict[str, Any] | None,
    materials: list[dict[str, Any]] | None,
    components: list[dict[str, Any]] | None,
    allocations: list[dict[str, Any]] | None,
    lots: list[dict[str, Any]] | None,
    descriptions: dict[str, str] | None = None,
    bom_desc_by_part: dict[str, str] | None = None,
    issued_lots: list[dict[str, Any]] | None = None,
    *,
    query: str = "",
    focus_process_sheet: str = "",
) -> dict[str, Any]:
    """Assemble one process-sheet trace from already-fetched ERP rows."""
    if not header:
        return {"found": False, "query": compact_text(query), "lines": []}

    descriptions = {_key(key): compact_text(value) for key, value in (descriptions or {}).items()}
    bom_desc_by_part = {_key(key): compact_text(value) for key, value in (bom_desc_by_part or {}).items()}
    fg = compact_text(header.get("inventory_code"))
    fg_key = _key(fg)
    alloc_rows = _dedupe_allocations(allocations)
    lot_groups = _lots_by_material(lots)
    issued_exact, issued_loose = _issued_indexes(issued_lots)

    component_by_line: dict[str, dict[str, Any]] = {}
    component_by_part: dict[str, dict[str, Any]] = {}
    for row in components or []:
        if _key(row.get("type")) == "FG":
            continue
        info = {
            "process_sheet_no": compact_text(row.get("process_sheet_no")),
            "qty": _qty(row.get("total_qty")),
            "description": compact_text(row.get("inventory_main_desc") or row.get("inventory_short_desc")),
        }
        line = _line_no(row.get("component_line_item_no"))
        part = _key(row.get("inventory_code"))
        if line and line not in component_by_line:
            component_by_line[line] = info
        if part and part not in component_by_part:
            component_by_part[part] = info

    parent_rows = [row for row in (materials or []) if _key(row.get("inventory_code")) == fg_key]
    nested: dict[str, list[dict[str, Any]]] = {}
    for row in materials or []:
        owner = _key(row.get("inventory_code"))
        if not owner or owner == fg_key:
            continue
        nested.setdefault(owner, []).append(row)

    if not parent_rows:
        parent_rows = [row for row in (materials or []) if _key(row.get("inventory_code")) != fg_key]

    use_counts: dict[str, int] = {}
    planned: list[tuple[dict[str, Any], list[dict[str, Any]], bool]] = []
    for row in parent_rows:
        sub_key = _key(row.get("material_inventory_code"))
        children = nested.get(sub_key) or []
        is_sub_part = bool(children) or sub_key in component_by_part
        traced = children if children else [row]
        planned.append((row, traced, is_sub_part and bool(children or component_by_part.get(sub_key))))
        for material in traced:
            code = _key(material.get("material_inventory_code"))
            if code:
                use_counts[code] = use_counts.get(code, 0) + 1

    lines: list[dict[str, Any]] = []
    for row, traced, is_sub_part in planned:
        line_no = _line_no(row.get("line_item_no"))
        sub_part = compact_text(row.get("material_inventory_code")) if is_sub_part else ""
        component = component_by_line.get(line_no) or component_by_part.get(_key(sub_part)) or {}
        material_rows = [
            _material_payload(
                material,
                alloc_rows,
                lot_groups,
                descriptions,
                issued_exact,
                issued_loose,
                job_part=sub_part,
                fg_key=fg_key,
                material_on_other_lines=use_counts.get(_key(material.get("material_inventory_code")), 0) > 1,
            )
            for material in traced
        ]
        lines.append(
            {
                "line_no": line_no,
                "partial_no": _qty(row.get("pp_partial_no")) or 1,
                "process_sheet_no": component.get("process_sheet_no") or "",
                "sub_part": sub_part,
                "sub_part_desc": descriptions.get(_key(sub_part), "") or component.get("description") or "",
                "sub_part_qty": _qty(row.get("qty")) if is_sub_part else None,
                "in_house": _in_house(row.get("in_house_production")) if is_sub_part else False,
                "materials": material_rows,
            }
        )

    focus = compact_text(focus_process_sheet)
    if focus:
        focus_key = _key(focus)
        focused = [
            line
            for line in lines
            if _key(line.get("process_sheet_no")) == focus_key
        ]
        if focused:
            lines = focused

    lines.sort(key=lambda line: (parse_number(line.get("line_no"), 0), line.get("sub_part") or ""))
    special = any(compact_text(line.get("sub_part")) for line in lines) or len(lines) > 1
    bom_desc = compact_text(header.get("bom_desc")) or bom_desc_by_part.get(fg_key, "")
    return {
        "found": True,
        "query": compact_text(query) or compact_text(header.get("pp_voucher_no")),
        "focus_process_sheet": focus if focus and any(
            _key(line.get("process_sheet_no")) == _key(focus) for line in lines
        ) else "",
        "special": special,
        "header": {
            "process_sheet_no": compact_text(header.get("pp_voucher_no")),
            "part_no": fg,
            "part_desc": descriptions.get(fg_key, ""),
            "bom_code": compact_text(header.get("bom_code")),
            "bom_desc": bom_desc,
            "qty": _qty(header.get("pp_qty")),
            "status": compact_text(header.get("status")),
            "sales_order_no": compact_text(header.get("source_voucher_no")),
            "sales_order_line": _line_no(header.get("source_line_item_no")),
            "customer_code": compact_text(header.get("customer_code")),
        },
        "lines": lines,
    }


_RESOLVE_SQL = """
SELECT pp_voucher_no, process_sheet_no, inventory_code, component_line_item_no, type
FROM public.mfg_process_sheet_info_v1_view
WHERE UPPER(BTRIM(process_sheet_no)) = %s
   OR UPPER(BTRIM(pp_voucher_no)) = %s
"""

_HEADER_SQL = """
SELECT pp_voucher_no, inventory_code, bom_code, bom_desc, pp_qty, status,
       source_voucher_no, source_line_item_no, customer_code
FROM public.mfg_pp_vch
WHERE UPPER(BTRIM(pp_voucher_no)) = %s
"""

_MATERIALS_SQL = """
SELECT pp_partial_no, inventory_code, bom_code, line_item_no,
       material_inventory_code, qty, in_house_production, selected_bom_code
FROM public.mfg_pp_partial_bom_stage_mat
WHERE UPPER(BTRIM(pp_voucher_no)) = %s
ORDER BY inventory_code, line_item_no, material_inventory_code
"""

_COMPONENTS_SQL = """
SELECT process_sheet_no, inventory_code, component_line_item_no, parent_inventory_code,
       total_qty, type, inventory_main_desc, inventory_short_desc
FROM public.mfg_process_sheet_info_v1_view
WHERE UPPER(BTRIM(pp_voucher_no)) = %s
ORDER BY component_seq_no NULLS FIRST, process_sheet_no
"""

_ALLOC_SQL = """
SELECT DISTINCT ON (a.alloc_voucher_no, a.inventory_code, a.lot_no)
       a.alloc_voucher_no,
       a.inventory_code,
       a.lot_no,
       a.alloc_qty,
       a.remain_alloc_qty,
       a.issued_alloc_qty,
       a.alloc_to_voucher_no,
       COALESCE(
           NULLIF(BTRIM(mps.own_inventory_code), ''),
           NULLIF(BTRIM(w.own_inventory_code), '')
       ) AS own_inventory_code,
       COALESCE(NULLIF(BTRIM(mps.wo_voucher_no), ''), w.voucher_no) AS wo_voucher_no
FROM public.mfg_mps_vch mps
JOIN public.ic_stk_alloc_vch a
  ON a.alloc_to_voucher_no = mps.mps_voucher_no
LEFT JOIN public.mfg_wo_vch w
  ON w.voucher_no = mps.wo_voucher_no
WHERE UPPER(BTRIM(mps.source_pp_no)) = %s
ORDER BY
    a.alloc_voucher_no,
    a.inventory_code,
    a.lot_no,
    CASE
        WHEN BTRIM(COALESCE(mps.own_inventory_code, w.own_inventory_code, '')) <> '' THEN 0
        ELSE 1
    END
"""

_ISSUED_SQL = """
SELECT
    COALESCE(
        NULLIF(BTRIM(mps.own_inventory_code), ''),
        NULLIF(BTRIM(w.own_inventory_code), '')
    ) AS own_inventory_code,
    mps.mps_voucher_no,
    mps.wo_voucher_no,
    mat.inventory_code,
    mat_lot.lot_no,
    mat_lot.reference_no,
    SUM(mat_lot.qty) AS issued_qty
FROM public.mfg_mps_vch mps
JOIN public.mfg_wo_vch w
  ON w.voucher_no = mps.wo_voucher_no
JOIN public.ic_stk_issue_vch si
  ON si.source_voucher_no = mps.wo_voucher_no
JOIN public.ic_stk_issue_mat mat
  ON mat.si_voucher_no = si.si_voucher_no
JOIN public.ic_stk_issue_mat_lot mat_lot
  ON mat_lot.si_voucher_no = mat.si_voucher_no
 AND mat_lot.line_item_no = mat.line_item_no
WHERE UPPER(BTRIM(mps.source_pp_no)) = %s
  AND si.issue_type = 'M'
  AND COALESCE(si.status, '') = 'H'
  AND COALESCE(mat_lot.qty, 0) > 0
GROUP BY 1, 2, 3, 4, 5, 6
"""

_LOTS_SQL = """
SELECT inventory_code, lot_no, source_location_code, reference_no,
       allocation_qty, remaining_qty
FROM public.ic_inventory_ost_lot
WHERE UPPER(BTRIM(inventory_code)) = ANY(%s)
  AND lot_no = ANY(%s)
"""

_DESC_SQL = """
SELECT inventory_code, main_desc
FROM public.mt_inventory
WHERE UPPER(BTRIM(inventory_code)) = ANY(%s)
"""

_BOM_DESC_SQL = """
SELECT inventory_code, bom_desc
FROM public.mfg_pp_partial_bom
WHERE UPPER(BTRIM(pp_voucher_no)) = %s
"""


def _query(sql: str, params: tuple) -> list[dict[str, Any]]:
    return live_query(sql, params, timeout_ms=_QUERY_TIMEOUT_MS)


def _resolve_sheet(query: str) -> tuple[str, str]:
    """Return (pp_voucher_no, focus_process_sheet)."""
    rows = _query(_RESOLVE_SQL, (query, query))
    if not rows:
        header = _query(_HEADER_SQL, (query,))
        if header:
            return compact_text(header[0].get("pp_voucher_no")), ""
        return "", ""
    children = [
        row
        for row in rows
        if _key(row.get("process_sheet_no")) == query and _key(row.get("process_sheet_no")) != _key(row.get("pp_voucher_no"))
    ]
    if children:
        return compact_text(children[0].get("pp_voucher_no")), compact_text(children[0].get("process_sheet_no"))
    parent = next(
        (
            row
            for row in rows
            if _key(row.get("pp_voucher_no")) == query or _key(row.get("process_sheet_no")) == query
        ),
        rows[0],
    )
    return compact_text(parent.get("pp_voucher_no")), ""


def trace_process_sheet(process_sheet_no: str) -> dict[str, Any]:
    query = _key(process_sheet_no)
    if not query:
        return {"found": False, "query": "", "lines": []}
    pp_no, focus = _resolve_sheet(query)
    if not pp_no:
        return {"found": False, "query": query, "lines": []}

    headers = _query(_HEADER_SQL, (_key(pp_no),))
    header = headers[0] if headers else {"pp_voucher_no": pp_no}
    materials = _query(_MATERIALS_SQL, (_key(pp_no),))
    components = _query(_COMPONENTS_SQL, (_key(pp_no),))
    allocations = _query(_ALLOC_SQL, (_key(pp_no),))
    issued_lots = _query(_ISSUED_SQL, (_key(pp_no),))
    bom_rows = _query(_BOM_DESC_SQL, (_key(pp_no),))

    codes = {_key(header.get("inventory_code"))}
    for row in materials:
        codes.add(_key(row.get("inventory_code")))
        codes.add(_key(row.get("material_inventory_code")))
    for row in components:
        codes.add(_key(row.get("inventory_code")))
    codes.discard("")

    lot_numbers = sorted({int(parse_number(row.get("lot_no"), 0)) for row in allocations if parse_number(row.get("lot_no"), 0)})
    alloc_codes = sorted({_key(row.get("inventory_code")) for row in allocations if _key(row.get("inventory_code"))})
    lots: list[dict[str, Any]] = []
    if alloc_codes and lot_numbers:
        lots = _query(_LOTS_SQL, (alloc_codes, lot_numbers))

    descriptions: dict[str, str] = {}
    if codes:
        for row in _query(_DESC_SQL, (sorted(codes),)):
            code = _key(row.get("inventory_code"))
            if code and code not in descriptions:
                descriptions[code] = compact_text(row.get("main_desc"))

    bom_desc_by_part: dict[str, str] = {}
    for row in bom_rows:
        code = _key(row.get("inventory_code"))
        desc = compact_text(row.get("bom_desc"))
        if code and desc and code not in bom_desc_by_part:
            bom_desc_by_part[code] = desc

    return build_trace(
        header,
        materials,
        components,
        allocations,
        lots,
        descriptions,
        bom_desc_by_part,
        issued_lots,
        query=query,
        focus_process_sheet=focus,
    )
