"""Resolve BOM material rows from ERP inventory_bom_listing with fallbacks."""
from __future__ import annotations

import re
from typing import Any

from .materials import _bom_qty_per_fg
from .utils import compact_text

_BOM_MATERIALS_SQL = """
SELECT
    main.source_inventory_code,
    main.bom_code,
    main.material_inventory_code,
    MAX(main.description) AS description,
    SUM(main.qty_parent) AS qty_parent,
    MAX(main.qty_fg) AS qty_fg,
    MAX(main.uom_code) AS uom_code
FROM public.inventory_bom_listing AS main
WHERE main.source_inventory_code = %s
  {bom_clause}
  AND NOT EXISTS (
      SELECT 1
      FROM public.inventory_bom_listing AS sub
      WHERE sub.source_inventory_code = main.material_inventory_code
  )
GROUP BY main.source_inventory_code, main.bom_code, main.material_inventory_code
ORDER BY main.bom_code, main.material_inventory_code
"""

_LIST_BOM_CODES_SQL = """
SELECT bom_code, COUNT(DISTINCT material_inventory_code) AS material_count
FROM public.inventory_bom_listing AS main
WHERE main.source_inventory_code = %s
  AND main.bom_code IS NOT NULL
  AND BTRIM(main.bom_code) <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM public.inventory_bom_listing AS sub
      WHERE sub.source_inventory_code = main.material_inventory_code
  )
GROUP BY main.bom_code
ORDER BY material_count DESC, bom_code
"""


def bom_code_match_key(code: str) -> str:
    """Normalize BOM codes so hyphen/underscore variants compare equal."""
    text = compact_text(code).upper()
    if not text:
        return ""
    return re.sub(r"[-_]+", "-", text)


def _serialize_row(row: tuple) -> dict[str, Any]:
    payload = {
        "source_inventory_code": row[0],
        "bom_code": row[1],
        "material_inventory_code": row[2],
        "description": row[3] or "",
        "qty_parent": float(row[4]) if row[4] is not None else None,
        "qty_fg": float(row[5]) if row[5] is not None else None,
        "uom_code": row[6] or "",
    }
    payload["qty_per_fg"] = _bom_qty_per_fg(payload)
    return payload


def fetch_bom_material_rows(db_query, source: str, bom: str | None = None) -> list[dict[str, Any]]:
    source = compact_text(source)
    if not source:
        return []
    params: list[Any] = [source]
    bom_clause = ""
    bom_text = compact_text(bom)
    if bom_text:
        bom_clause = "AND main.bom_code = %s"
        params.append(bom_text)
    rows = db_query(
        _BOM_MATERIALS_SQL.format(bom_clause=bom_clause),
        tuple(params),
        fetchall=True,
    )
    return [_serialize_row(row) for row in (rows or [])]


def _list_bom_codes_with_counts(db_query, source: str) -> list[tuple[str, int]]:
    rows = db_query(_LIST_BOM_CODES_SQL, (source,), fetchall=True)
    out: list[tuple[str, int]] = []
    for row in rows or []:
        code = compact_text(row[0])
        if not code:
            continue
        try:
            count = int(row[1] or 0)
        except (TypeError, ValueError):
            count = 0
        out.append((code, count))
    return out


def _pick_best_bom_code(
    candidates: list[tuple[str, int]],
    requested_bom: str,
) -> str:
    if not candidates:
        return ""
    requested_key = bom_code_match_key(requested_bom)
    if requested_key:
        normalized = [item for item in candidates if bom_code_match_key(item[0]) == requested_key]
        if normalized:
            normalized.sort(key=lambda item: (-item[1], item[0]))
            return normalized[0][0]
    candidates = sorted(candidates, key=lambda item: (-item[1], item[0]))
    return candidates[0][0]


def _notice_for_mode(
    *,
    match_mode: str,
    requested_bom: str,
    resolved_bom: str,
    alternate_bom_codes: list[str],
) -> str:
    if match_mode == "normalized_bom":
        return (
            f"No materials on BOM {requested_bom} — matched ERP listing using "
            f"{resolved_bom} (hyphen/underscore variant)."
        )
    if match_mode == "alternate_bom":
        alts = ", ".join(alternate_bom_codes[:4])
        suffix = f" (+{len(alternate_bom_codes) - 4} more)" if len(alternate_bom_codes) > 4 else ""
        bom_label = requested_bom or "requested BOM"
        return (
            f"BOM {bom_label} has no material requirements in ERP — "
            f"showing materials from alternate BOM route(s): {alts}{suffix}."
        )
    if match_mode == "any_bom_for_part":
        alts = ", ".join(alternate_bom_codes[:4])
        suffix = f" (+{len(alternate_bom_codes) - 4} more)" if len(alternate_bom_codes) > 4 else ""
        if len(alternate_bom_codes) > 1:
            return f"This part has multiple BOM routes in ERP — showing all: {alts}{suffix}."
        return ""
    if match_mode == "not_found":
        return (
            "No BOM material requirements found for this part in ERP "
            "(inventory_bom_listing). The PP may be on a process-flow BOM without "
            "raw-material lines, or materials are not set up yet."
        )
    return ""


def resolve_bom_materials(db_query, source: str, bom: str | None = None) -> dict[str, Any]:
    """Resolve leaf materials with fallbacks for BOM alias / alternate routes."""
    source = compact_text(source)
    requested_bom = compact_text(bom)
    if not source:
        return {
            "rows": [],
            "requested_bom_code": requested_bom,
            "resolved_bom_code": "",
            "match_mode": "not_found",
            "alternate_bom_codes": [],
            "notice": "Part number is required.",
        }

    if requested_bom:
        exact_rows = fetch_bom_material_rows(db_query, source, requested_bom)
        if exact_rows:
            return {
                "rows": exact_rows,
                "requested_bom_code": requested_bom,
                "resolved_bom_code": requested_bom,
                "match_mode": "exact",
                "alternate_bom_codes": [],
                "notice": "",
            }

    bom_candidates = _list_bom_codes_with_counts(db_query, source)
    alternate_codes = [code for code, _count in bom_candidates if code != requested_bom]
    resolved_bom = _pick_best_bom_code(bom_candidates, requested_bom)

    if resolved_bom:
        resolved_rows = fetch_bom_material_rows(db_query, source, resolved_bom)
        if resolved_rows:
            if not requested_bom:
                all_rows = fetch_bom_material_rows(db_query, source, None)
                resolved_codes = sorted(
                    {compact_text(row.get("bom_code")) for row in all_rows if row.get("bom_code")}
                )
                if len(resolved_codes) <= 1:
                    return {
                        "rows": resolved_rows,
                        "requested_bom_code": requested_bom,
                        "resolved_bom_code": resolved_bom,
                        "match_mode": "exact",
                        "alternate_bom_codes": alternate_codes,
                        "notice": "",
                    }
                return {
                    "rows": all_rows,
                    "requested_bom_code": requested_bom,
                    "resolved_bom_code": "",
                    "match_mode": "any_bom_for_part",
                    "alternate_bom_codes": resolved_codes,
                    "notice": _notice_for_mode(
                        match_mode="any_bom_for_part",
                        requested_bom=requested_bom,
                        resolved_bom=resolved_codes[0] if resolved_codes else "",
                        alternate_bom_codes=resolved_codes,
                    ),
                }
            if bom_code_match_key(resolved_bom) == bom_code_match_key(requested_bom):
                match_mode = "normalized_bom"
                rows = resolved_rows
                resolved_code = resolved_bom
            else:
                match_mode = "alternate_bom"
                rows = fetch_bom_material_rows(db_query, source, None)
                route_codes = sorted(
                    {compact_text(row.get("bom_code")) for row in rows if row.get("bom_code")}
                )
                resolved_code = route_codes[0] if len(route_codes) == 1 else ""
            return {
                "rows": rows,
                "requested_bom_code": requested_bom,
                "resolved_bom_code": resolved_code,
                "match_mode": match_mode,
                "alternate_bom_codes": alternate_codes,
                "notice": _notice_for_mode(
                    match_mode=match_mode,
                    requested_bom=requested_bom,
                    resolved_bom=resolved_code or resolved_bom,
                    alternate_bom_codes=alternate_codes,
                ),
            }

    all_rows = fetch_bom_material_rows(db_query, source, None)
    if all_rows:
        resolved_codes = sorted({compact_text(row.get("bom_code")) for row in all_rows if row.get("bom_code")})
        return {
            "rows": all_rows,
            "requested_bom_code": requested_bom,
            "resolved_bom_code": resolved_codes[0] if len(resolved_codes) == 1 else "",
            "match_mode": "any_bom_for_part",
            "alternate_bom_codes": resolved_codes,
            "notice": _notice_for_mode(
                match_mode="any_bom_for_part",
                requested_bom=requested_bom,
                resolved_bom=resolved_codes[0] if resolved_codes else "",
                alternate_bom_codes=resolved_codes,
            ),
        }

    return {
        "rows": [],
        "requested_bom_code": requested_bom,
        "resolved_bom_code": "",
        "match_mode": "not_found",
        "alternate_bom_codes": alternate_codes,
        "notice": _notice_for_mode(
            match_mode="not_found",
            requested_bom=requested_bom,
            resolved_bom="",
            alternate_bom_codes=alternate_codes,
        ),
    }
