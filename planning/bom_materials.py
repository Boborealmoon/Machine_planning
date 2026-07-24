"""Resolve BOM material rows from ERP inventory_bom_listing with fallbacks."""
from __future__ import annotations

from typing import Any

from .materials import _bom_qty_per_fg
from .utils import bom_code_match_key, compact_text, parse_number

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

_BOM_ROUTE_SQL = """
SELECT bom_code, COALESCE(bom_desc, '') AS bom_desc, COALESCE(is_default, 'N') AS is_default
FROM public.mt_inventory_bom
WHERE inventory_code = %s
  AND bom_code IS NOT NULL
  AND BTRIM(bom_code) <> ''
ORDER BY CASE WHEN COALESCE(is_default, 'N') = 'Y' THEN 0 ELSE 1 END, bom_code
"""

_BOM_STAGES_SQL = """
SELECT bom_code, stage_no, COALESCE(stage_desc, '') AS stage_desc
FROM public.mt_inventory_bom_stage
WHERE inventory_code = %s
  AND bom_code IS NOT NULL
  AND BTRIM(bom_code) <> ''
ORDER BY bom_code, stage_no
"""


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


def _pick_matching_code(candidates: list[str], requested_bom: str) -> str:
    codes = [compact_text(code) for code in candidates if compact_text(code)]
    if not codes:
        return ""
    requested = compact_text(requested_bom)
    if requested:
        for code in codes:
            if code == requested:
                return code
        requested_key = bom_code_match_key(requested)
        if requested_key:
            for code in codes:
                if bom_code_match_key(code) == requested_key:
                    return code
    return codes[0]


def _fetch_bom_route_context(db_query, source: str, requested_bom: str) -> dict[str, Any]:
    """When listing has no leaf materials, still resolve the ERP BOM route + op stages."""
    empty = {
        "matched_bom_code": "",
        "matched_bom_desc": "",
        "matched_stages": [],
        "route_matched": False,
    }
    source = compact_text(source)
    if not source:
        return empty

    try:
        route_rows = db_query(_BOM_ROUTE_SQL, (source,), fetchall=True) or []
    except Exception:
        route_rows = []
    try:
        stage_rows = db_query(_BOM_STAGES_SQL, (source,), fetchall=True) or []
    except Exception:
        stage_rows = []

    route_codes = [compact_text(row[0]) for row in route_rows if compact_text(row[0])]
    stage_codes = [compact_text(row[0]) for row in stage_rows if compact_text(row[0])]
    matched_bom = _pick_matching_code(route_codes or stage_codes, requested_bom)
    if not matched_bom:
        return empty

    matched_key = bom_code_match_key(matched_bom)
    bom_desc = ""
    for row in route_rows:
        code = compact_text(row[0])
        if code == matched_bom or bom_code_match_key(code) == matched_key:
            bom_desc = compact_text(row[1])
            matched_bom = code or matched_bom
            break

    stages: list[dict[str, Any]] = []
    for row in stage_rows:
        code = compact_text(row[0])
        if code != matched_bom and bom_code_match_key(code) != matched_key:
            continue
        try:
            stage_no = int(row[1] or 0)
        except (TypeError, ValueError):
            stage_no = 0
        stages.append(
            {
                "bom_code": code,
                "stage_no": stage_no,
                "stage_desc": compact_text(row[2]),
            }
        )

    return {
        "matched_bom_code": matched_bom,
        "matched_bom_desc": bom_desc,
        "matched_stages": stages,
        "route_matched": True,
    }


def _notice_for_mode(
    *,
    match_mode: str,
    requested_bom: str,
    resolved_bom: str,
    alternate_bom_codes: list[str],
    matched_bom_desc: str = "",
    matched_stages: list[dict[str, Any]] | None = None,
) -> str:
    if match_mode == "normalized_bom":
        return (
            f"No materials on BOM {requested_bom} - matched ERP listing using "
            f"{resolved_bom} (hyphen/underscore variant)."
        )
    if match_mode == "alternate_bom":
        alts = ", ".join(alternate_bom_codes[:4])
        suffix = f" (+{len(alternate_bom_codes) - 4} more)" if len(alternate_bom_codes) > 4 else ""
        bom_label = requested_bom or "requested BOM"
        return (
            f"BOM {bom_label} has no material requirements in ERP - "
            f"showing materials from alternate BOM route(s): {alts}{suffix}."
        )
    if match_mode == "any_bom_for_part":
        alts = ", ".join(alternate_bom_codes[:4])
        suffix = f" (+{len(alternate_bom_codes) - 4} more)" if len(alternate_bom_codes) > 4 else ""
        if len(alternate_bom_codes) > 1:
            return f"This part has multiple BOM routes in ERP - showing all: {alts}{suffix}."
        return ""
    if match_mode == "route_no_materials":
        route = resolved_bom or requested_bom or "BOM route"
        desc = f" ({matched_bom_desc})" if matched_bom_desc else ""
        stage_labels = [
            compact_text(stage.get("stage_desc")) or f"Stage {stage.get('stage_no')}"
            for stage in (matched_stages or [])
        ]
        stage_labels = [label for label in stage_labels if label]
        stages_bit = ""
        if stage_labels:
            stages_bit = " Op stages: " + " -> ".join(stage_labels) + "."
        return (
            f"Matched BOM route {route}{desc} - this is a process-flow / rework BOM "
            f"with no raw-material lines in inventory_bom_listing.{stages_bit}"
        )
    if match_mode == "not_found":
        return (
            "No BOM material requirements found for this part in ERP "
            "(inventory_bom_listing). The PP may be on a process-flow BOM without "
            "raw-material lines, or materials are not set up yet."
        )
    return ""


def _empty_result(
    *,
    requested_bom: str,
    match_mode: str,
    alternate_bom_codes: list[str] | None = None,
    resolved_bom_code: str = "",
    matched_bom_desc: str = "",
    matched_stages: list[dict[str, Any]] | None = None,
    notice: str = "",
) -> dict[str, Any]:
    stages = matched_stages or []
    return {
        "rows": [],
        "requested_bom_code": requested_bom,
        "resolved_bom_code": resolved_bom_code,
        "match_mode": match_mode,
        "alternate_bom_codes": alternate_bom_codes or [],
        "matched_bom_code": resolved_bom_code,
        "matched_bom_desc": matched_bom_desc,
        "matched_stages": stages,
        "route_matched": bool(resolved_bom_code or stages),
        "notice": notice
        or _notice_for_mode(
            match_mode=match_mode,
            requested_bom=requested_bom,
            resolved_bom=resolved_bom_code,
            alternate_bom_codes=alternate_bom_codes or [],
            matched_bom_desc=matched_bom_desc,
            matched_stages=stages,
        ),
    }


def resolve_bom_materials(db_query, source: str, bom: str | None = None) -> dict[str, Any]:
    """Resolve leaf materials with fallbacks for BOM alias / alternate routes."""
    source = compact_text(source)
    requested_bom = compact_text(bom)
    if not source:
        return _empty_result(
            requested_bom=requested_bom,
            match_mode="not_found",
            notice="Part number is required.",
        )

    if requested_bom:
        exact_rows = fetch_bom_material_rows(db_query, source, requested_bom)
        if exact_rows:
            return {
                "rows": exact_rows,
                "requested_bom_code": requested_bom,
                "resolved_bom_code": requested_bom,
                "match_mode": "exact",
                "alternate_bom_codes": [],
                "matched_bom_code": requested_bom,
                "matched_bom_desc": "",
                "matched_stages": [],
                "route_matched": True,
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
                        "matched_bom_code": resolved_bom,
                        "matched_bom_desc": "",
                        "matched_stages": [],
                        "route_matched": True,
                        "notice": "",
                    }
                return {
                    "rows": all_rows,
                    "requested_bom_code": requested_bom,
                    "resolved_bom_code": "",
                    "match_mode": "any_bom_for_part",
                    "alternate_bom_codes": resolved_codes,
                    "matched_bom_code": resolved_codes[0] if len(resolved_codes) == 1 else "",
                    "matched_bom_desc": "",
                    "matched_stages": [],
                    "route_matched": True,
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
                "matched_bom_code": resolved_code or resolved_bom,
                "matched_bom_desc": "",
                "matched_stages": [],
                "route_matched": True,
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
            "matched_bom_code": resolved_codes[0] if len(resolved_codes) == 1 else "",
            "matched_bom_desc": "",
            "matched_stages": [],
            "route_matched": True,
            "notice": _notice_for_mode(
                match_mode="any_bom_for_part",
                requested_bom=requested_bom,
                resolved_bom=resolved_codes[0] if resolved_codes else "",
                alternate_bom_codes=resolved_codes,
            ),
        }

    route = _fetch_bom_route_context(db_query, source, requested_bom)
    if route["route_matched"]:
        return _empty_result(
            requested_bom=requested_bom,
            match_mode="route_no_materials",
            alternate_bom_codes=alternate_codes,
            resolved_bom_code=route["matched_bom_code"],
            matched_bom_desc=route["matched_bom_desc"],
            matched_stages=route["matched_stages"],
        )

    return _empty_result(
        requested_bom=requested_bom,
        match_mode="not_found",
        alternate_bom_codes=alternate_codes,
    )


def _serialize_planner_dict(row: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "source_inventory_code": compact_text(row.get("source_inventory_code")),
        "bom_code": compact_text(row.get("bom_code")),
        "material_inventory_code": compact_text(row.get("material_inventory_code")),
        "description": compact_text(row.get("description")),
        "qty_parent": parse_number(row.get("qty_parent"), 0),
        "qty_fg": parse_number(row.get("qty_fg"), 1),
        "uom_code": compact_text(row.get("uom_code")),
    }
    payload["qty_per_fg"] = _bom_qty_per_fg(payload)
    return payload


def fetch_material_per_bom_planner(con, source: str, bom: str | None = None) -> list[dict[str, Any]]:
    """Leaf BOM materials from synced material_per_bom (planner / Supabase)."""
    from .helpers import rows

    source = compact_text(source)
    if not source:
        return []
    params: list[Any] = [source]
    bom_clause = ""
    bom_text = compact_text(bom)
    if bom_text:
        bom_clause = "AND bom_code = %s"
        params.append(bom_text)
    query_rows = rows(
        con.execute(
            f"""
            SELECT source_inventory_code, bom_code, material_inventory_code,
                   description, qty_parent, qty_fg, uom_code
            FROM material_per_bom
            WHERE source_inventory_code = %s
              {bom_clause}
            ORDER BY bom_code, material_inventory_code
            """,
            tuple(params),
        )
    )
    return [_serialize_planner_dict(row) for row in query_rows]


def _list_planner_bom_codes(con, source: str) -> list[tuple[str, int]]:
    from .helpers import rows

    query_rows = rows(
        con.execute(
            """
            SELECT bom_code, COUNT(DISTINCT material_inventory_code) AS material_count
            FROM material_per_bom
            WHERE source_inventory_code = %s
              AND bom_code IS NOT NULL
              AND BTRIM(bom_code) <> ''
            GROUP BY bom_code
            ORDER BY material_count DESC, bom_code
            """,
            (source,),
        )
    )
    out: list[tuple[str, int]] = []
    for row in query_rows:
        code = compact_text(row.get("bom_code"))
        if not code:
            continue
        try:
            count = int(row.get("material_count") or 0)
        except (TypeError, ValueError):
            count = 0
        out.append((code, count))
    return out


def resolve_material_per_bom_planner(con, source: str, bom: str | None = None) -> dict[str, Any]:
    """Resolve BOM materials from material_per_bom with the same fallbacks as ERP lookup."""
    source = compact_text(source)
    requested_bom = compact_text(bom)
    if not source:
        return _empty_result(
            requested_bom=requested_bom,
            match_mode="not_found",
            notice="Part number is required.",
        )

    if requested_bom:
        exact_rows = fetch_material_per_bom_planner(con, source, requested_bom)
        if exact_rows:
            return {
                "rows": exact_rows,
                "requested_bom_code": requested_bom,
                "resolved_bom_code": requested_bom,
                "match_mode": "exact",
                "alternate_bom_codes": [],
                "matched_bom_code": requested_bom,
                "matched_bom_desc": "",
                "matched_stages": [],
                "route_matched": True,
                "notice": "",
            }

    bom_candidates = _list_planner_bom_codes(con, source)
    alternate_codes = [code for code, _count in bom_candidates if code != requested_bom]
    resolved_bom = _pick_best_bom_code(bom_candidates, requested_bom)

    if resolved_bom:
        resolved_rows = fetch_material_per_bom_planner(con, source, resolved_bom)
        if resolved_rows:
            if bom_code_match_key(resolved_bom) == bom_code_match_key(requested_bom):
                match_mode = "normalized_bom"
                match_rows = resolved_rows
                resolved_code = resolved_bom
            else:
                match_mode = "alternate_bom"
                match_rows = fetch_material_per_bom_planner(con, source, None)
                route_codes = sorted(
                    {
                        compact_text(row.get("bom_code"))
                        for row in match_rows
                        if compact_text(row.get("bom_code"))
                    }
                )
                resolved_code = route_codes[0] if len(route_codes) == 1 else resolved_bom
            return {
                "rows": match_rows,
                "requested_bom_code": requested_bom,
                "resolved_bom_code": resolved_code,
                "match_mode": match_mode,
                "alternate_bom_codes": alternate_codes,
                "matched_bom_code": resolved_code or resolved_bom,
                "matched_bom_desc": "",
                "matched_stages": [],
                "route_matched": True,
                "notice": _notice_for_mode(
                    match_mode=match_mode,
                    requested_bom=requested_bom,
                    resolved_bom=resolved_code or resolved_bom,
                    alternate_bom_codes=alternate_codes,
                ),
            }

    all_rows = fetch_material_per_bom_planner(con, source, None)
    if all_rows:
        resolved_codes = sorted(
            {compact_text(row.get("bom_code")) for row in all_rows if compact_text(row.get("bom_code"))}
        )
        return {
            "rows": all_rows,
            "requested_bom_code": requested_bom,
            "resolved_bom_code": resolved_codes[0] if len(resolved_codes) == 1 else "",
            "match_mode": "any_bom_for_part",
            "alternate_bom_codes": resolved_codes,
            "matched_bom_code": resolved_codes[0] if len(resolved_codes) == 1 else "",
            "matched_bom_desc": "",
            "matched_stages": [],
            "route_matched": True,
            "notice": _notice_for_mode(
                match_mode="any_bom_for_part",
                requested_bom=requested_bom,
                resolved_bom=resolved_codes[0] if resolved_codes else "",
                alternate_bom_codes=resolved_codes,
            ),
        }

    return _empty_result(
        requested_bom=requested_bom,
        match_mode="not_found",
        alternate_bom_codes=alternate_codes,
    )
