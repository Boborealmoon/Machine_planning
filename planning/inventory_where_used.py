"""Reverse BOM lookup: which process sheets use (or used) an inventory code."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from urllib.parse import quote

from .helpers import planner_try_savepoint, rows
from .materials import _bom_qty_per_fg
from .utils import bom_code_match_key, compact_text, parse_number

HISTORICAL_PER_PARENT = 12
HISTORICAL_FETCH_LIMIT = 800

_COMPLETED = {"COMPLETED", "VOID"}


def material_match_type(inventory_code: str, bom_material_code: str) -> str:
    """How an enquiry part relates to a BOM leaf material code."""
    inv = compact_text(inventory_code).upper()
    bom = compact_text(bom_material_code).upper()
    if not inv or not bom:
        return ""
    if inv == bom:
        return "exact"
    if inv.startswith(f"{bom}_"):
        return "inventory_suffix"
    if bom.startswith(f"{inv}_"):
        return "bom_suffix"
    return ""


def _iso_date(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = compact_text(value)
    return text[:10] if text else ""


def _as_float(value: Any) -> float:
    if isinstance(value, Decimal):
        return float(value)
    return parse_number(value, 0)


def _as_int(value: Any, default: int = 1) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number > 0 else default


def _norm_code(value: Any) -> str:
    return compact_text(value).upper()


def _ps_url(ps_id: str) -> str:
    text = compact_text(ps_id)
    if not text:
        return "/process-sheets"
    return f"/process-sheets?q={quote(text, safe='')}"


def _ps_key(ps_id: Any, pp_partial_no: Any = 1) -> tuple[str, int]:
    return (_norm_code(ps_id), _as_int(pp_partial_no, 1))


def _is_completed(row: dict[str, Any]) -> bool:
    planner_status = compact_text(row.get("planner_status")).upper()
    status = compact_text(row.get("status") or row.get("planner_ps_status")).upper()
    return planner_status in _COMPLETED or status in _COMPLETED


def _serialize_ps(
    row: dict[str, Any],
    *,
    bucket: str,
    via: str,
    bom_unconfirmed: bool = False,
    qty_needed: float | None = None,
    matched_bom_code: str = "",
) -> dict[str, Any]:
    ps_id = compact_text(row.get("ps_id") or row.get("process_sheet_no") or row.get("source_ps_id"))
    partial = _as_int(row.get("pp_partial_no"), 1)
    bom_code = compact_text(
        matched_bom_code
        or row.get("selected_bom_code")
        or row.get("bom_code")
        or ""
    )
    qty = _as_float(row.get("qty") if row.get("qty") is not None else row.get("total_qty"))
    return {
        "ps_id": ps_id,
        "pp_partial_no": partial,
        "planner_ps_id": compact_text(row.get("planner_ps_id")),
        "part_no": compact_text(row.get("part_no") or row.get("inventory_code")),
        "part_desc": compact_text(row.get("part_desc") or row.get("description")),
        "bom_code": bom_code,
        "bom_unconfirmed": bool(bom_unconfirmed),
        "qty": qty,
        "qty_needed": qty_needed,
        "due_date": _iso_date(row.get("due_date")),
        "order_date": _iso_date(row.get("order_date") or row.get("sales_order_date")),
        "sales_order_no": compact_text(row.get("sales_order_no") or row.get("source_voucher_no")),
        "status": compact_text(row.get("status") or row.get("erp_status")),
        "planner_status": compact_text(row.get("planner_status")),
        "current_stage_desc": compact_text(row.get("current_stage_desc")),
        "process_sheets_url": _ps_url(ps_id),
        "via": via,
        "bucket": bucket,
    }


def _qty_per_fg_for(
    parent: str,
    bom_code: str,
    qty_by_parent_bom: dict[tuple[str, str], float],
    qty_by_parent: dict[str, float],
) -> float | None:
    parent_u = _norm_code(parent)
    bom_key = bom_code_match_key(bom_code)
    if bom_key:
        qty = qty_by_parent_bom.get((parent_u, bom_key))
        if qty is not None:
            return qty
    return qty_by_parent.get(parent_u)


def _ps_allowed_for_parent(
    row: dict[str, Any],
    allowed_boms: dict[str, set[str]],
) -> tuple[bool, bool, str]:
    """Return (allowed, bom_unconfirmed, matched_bom_code)."""
    parent = _norm_code(row.get("part_no") or row.get("inventory_code"))
    boms = allowed_boms.get(parent)
    if not boms:
        return False, False, ""
    selected = compact_text(row.get("selected_bom_code") or row.get("bom_code"))
    if not selected:
        return True, True, ""
    key = bom_code_match_key(selected)
    if key in boms:
        return True, False, selected
    return False, False, selected


def assemble_where_used(
    *,
    code: str,
    bom_rows: list[dict[str, Any]],
    open_rows: list[dict[str, Any]] | None = None,
    historical_rows: list[dict[str, Any]] | None = None,
    planner_rows: list[dict[str, Any]] | None = None,
    requirement_rows: list[dict[str, Any]] | None = None,
    part_descs: dict[str, str] | None = None,
    historical_counts: dict[str, int] | None = None,
    historical_per_parent: int = HISTORICAL_PER_PARENT,
) -> dict[str, Any]:
    """Group reverse-BOM rows and process sheets for one inventory code."""
    code = compact_text(code)
    code_u = _norm_code(code)
    part_descs = {_norm_code(k): compact_text(v) for k, v in (part_descs or {}).items() if compact_text(k)}
    historical_counts = {
        _norm_code(k): int(v or 0)
        for k, v in (historical_counts or {}).items()
        if compact_text(k)
    }

    parents: dict[str, dict[str, Any]] = {}
    allowed_boms: dict[str, set[str]] = {}
    qty_by_parent_bom: dict[tuple[str, str], float] = {}
    qty_by_parent: dict[str, float] = {}

    for raw in bom_rows or []:
        parent = compact_text(raw.get("source_inventory_code"))
        bom_code = compact_text(raw.get("bom_code"))
        material = compact_text(raw.get("material_inventory_code"))
        match = material_match_type(code, material)
        if not parent or not bom_code or not match:
            continue
        parent_u = _norm_code(parent)
        qty_fg = _bom_qty_per_fg(raw)
        entry = {
            "source_inventory_code": parent,
            "bom_code": bom_code,
            "material_inventory_code": material,
            "match_type": match,
            "description": compact_text(raw.get("description")),
            "qty_per_fg": qty_fg,
            "uom_code": compact_text(raw.get("uom_code")),
        }
        bucket = parents.setdefault(
            parent_u,
            {
                "source_inventory_code": parent,
                "part_desc": part_descs.get(parent_u, ""),
                "boms": [],
            },
        )
        if not any(
            compact_text(item.get("bom_code")) == bom_code
            and compact_text(item.get("material_inventory_code")) == material
            for item in bucket["boms"]
        ):
            bucket["boms"].append(entry)
        allowed_boms.setdefault(parent_u, set()).add(bom_code_match_key(bom_code))
        qty_by_parent_bom[(parent_u, bom_code_match_key(bom_code))] = qty_fg
        qty_by_parent.setdefault(parent_u, qty_fg)

    open_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    history_by_key: dict[tuple[str, int], dict[str, Any]] = {}

    def _remember(ps: dict[str, Any], store: dict[tuple[str, int], dict[str, Any]]) -> None:
        if not compact_text(ps.get("ps_id")):
            return
        store[_ps_key(ps.get("ps_id"), ps.get("pp_partial_no"))] = ps

    def _attach_qty(row: dict[str, Any], ps: dict[str, Any]) -> None:
        qty_fg = _qty_per_fg_for(
            ps["part_no"],
            ps["bom_code"],
            qty_by_parent_bom,
            qty_by_parent,
        )
        if qty_fg is None:
            return
        ps["qty_needed"] = round(_as_float(ps.get("qty")) * qty_fg, 6)

    for raw in open_rows or []:
        allowed, unconfirmed, matched_bom = _ps_allowed_for_parent(raw, allowed_boms)
        part_u = _norm_code(raw.get("part_no") or raw.get("inventory_code"))
        via = "finished_part" if part_u == code_u else "bom"
        if via != "finished_part" and not allowed:
            continue
        ps = _serialize_ps(
            raw,
            bucket="open",
            via=via,
            bom_unconfirmed=unconfirmed if via == "bom" else False,
            matched_bom_code=matched_bom,
        )
        _attach_qty(raw, ps)
        _remember(ps, open_by_key)

    for raw in planner_rows or []:
        part_u = _norm_code(raw.get("part_no") or raw.get("inventory_code"))
        via = "finished_part" if part_u == code_u else "bom"
        allowed, unconfirmed, matched_bom = _ps_allowed_for_parent(raw, allowed_boms)
        if via != "finished_part" and not allowed:
            continue
        key = _ps_key(raw.get("ps_id") or raw.get("source_ps_id"), raw.get("pp_partial_no"))
        if key in open_by_key:
            existing = open_by_key[key]
            if compact_text(raw.get("planner_ps_id")):
                existing["planner_ps_id"] = compact_text(raw.get("planner_ps_id"))
            if compact_text(raw.get("planner_status")):
                existing["planner_status"] = compact_text(raw.get("planner_status"))
            if compact_text(raw.get("selected_bom_code")) and not existing.get("bom_code"):
                existing["bom_code"] = compact_text(raw.get("selected_bom_code"))
                existing["bom_unconfirmed"] = False
            continue
        bucket = "history" if _is_completed(raw) else "open"
        ps = _serialize_ps(
            raw,
            bucket=bucket,
            via=via,
            bom_unconfirmed=unconfirmed if via == "bom" else False,
            matched_bom_code=matched_bom,
        )
        _attach_qty(raw, ps)
        _remember(ps, history_by_key if bucket == "history" else open_by_key)

    for raw in requirement_rows or []:
        key = _ps_key(raw.get("ps_id") or raw.get("source_ps_id"), raw.get("pp_partial_no"))
        if key in open_by_key or key in history_by_key:
            continue
        if not compact_text(raw.get("ps_id") or raw.get("source_ps_id")):
            continue
        bucket = "history" if _is_completed(raw) else "open"
        ps = _serialize_ps(raw, bucket=bucket, via="requirement")
        parent_u = _norm_code(raw.get("part_no") or raw.get("source_inventory_code"))
        if parent_u and parent_u not in parents:
            parents[parent_u] = {
                "source_inventory_code": compact_text(raw.get("part_no") or raw.get("source_inventory_code")),
                "part_desc": part_descs.get(parent_u, ""),
                "boms": [],
            }
        _attach_qty(raw, ps)
        _remember(ps, history_by_key if bucket == "history" else open_by_key)

    for raw in historical_rows or []:
        key = _ps_key(raw.get("ps_id") or raw.get("process_sheet_no"), raw.get("pp_partial_no") or 1)
        if key in open_by_key or key in history_by_key:
            continue
        part_u = _norm_code(raw.get("part_no") or raw.get("inventory_code"))
        via = "finished_part" if part_u == code_u else "bom"
        if via != "finished_part" and part_u not in allowed_boms:
            continue
        ps = _serialize_ps(
            raw,
            bucket="history",
            via=via,
            bom_unconfirmed=via == "bom",
        )
        _attach_qty(raw, ps)
        _remember(ps, history_by_key)

    def _sort_ps(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(
            items,
            key=lambda item: (
                item.get("due_date") or item.get("order_date") or "9999",
                compact_text(item.get("ps_id")).upper(),
                int(item.get("pp_partial_no") or 1),
            ),
        )

    finished_open = _sort_ps([ps for ps in open_by_key.values() if ps.get("via") == "finished_part"])
    finished_history = list(
        reversed(_sort_ps([ps for ps in history_by_key.values() if ps.get("via") == "finished_part"]))
    )

    parent_payloads: list[dict[str, Any]] = []
    for parent_u, parent in parents.items():
        open_ps = _sort_ps(
            [
                ps
                for ps in open_by_key.values()
                if ps.get("via") != "finished_part" and _norm_code(ps.get("part_no")) == parent_u
            ]
        )
        all_history = _sort_ps(
            [
                ps
                for ps in history_by_key.values()
                if ps.get("via") != "finished_part" and _norm_code(ps.get("part_no")) == parent_u
            ],
        )
        all_history_newest = list(reversed(all_history))
        shown_history = all_history_newest[: max(0, int(historical_per_parent))]
        implied_history = max(0, historical_counts.get(parent_u, 0) - len(open_ps))
        parent["boms"] = sorted(parent["boms"], key=lambda item: compact_text(item.get("bom_code")).upper())
        parent_payloads.append(
            {
                **parent,
                "open_process_sheets": open_ps,
                "historical_process_sheets": shown_history,
                "historical_total": max(len(all_history_newest), implied_history),
                "open_count": len(open_ps),
            }
        )

    def _parent_sort_key(item: dict[str, Any]) -> tuple:
        code = compact_text(item.get("source_inventory_code")).upper()
        desc = compact_text(item.get("part_desc")).upper()
        backup = 1 if code.startswith("BACKUP") or "DO NOT USE" in desc else 0
        return (
            backup,
            0 if item["open_count"] else 1,
            -int(item["historical_total"]),
            code,
        )

    parent_payloads.sort(key=_parent_sort_key)

    finished_history_total = max(
        len(finished_history),
        max(0, historical_counts.get(code_u, 0) - len(finished_open)),
    )
    open_count = sum(item["open_count"] for item in parent_payloads) + len(finished_open)
    history_count = sum(item["historical_total"] for item in parent_payloads) + finished_history_total
    bom_route_count = sum(len(item.get("boms") or []) for item in parent_payloads)

    return {
        "code": code,
        "as_finished_part": {
            "open_process_sheets": finished_open,
            "historical_process_sheets": finished_history[:historical_per_parent],
            "historical_total": finished_history_total,
        },
        "parents": parent_payloads,
        "counts": {
            "parent_parts": len(parent_payloads),
            "bom_routes": bom_route_count,
            "open_ps": open_count,
            "historical_ps": history_count,
            "makes_this_part_open": len(finished_open),
            "makes_this_part_historical": finished_history_total,
        },
    }


def _query_rows(con, name: str, sql: str, params: tuple) -> list[dict[str, Any]]:
    return planner_try_savepoint(con, name, lambda: rows(con.execute(sql, params)), default=[]) or []


_BOM_SQL = """
SELECT
    source_inventory_code,
    bom_code,
    material_inventory_code,
    description,
    qty_parent,
    qty_fg,
    uom_code
FROM material_per_bom
WHERE BTRIM(COALESCE(material_inventory_code, '')) <> ''
  AND (
        UPPER(BTRIM(material_inventory_code)) = %s
     OR starts_with(%s, UPPER(BTRIM(material_inventory_code)) || '_')
     OR starts_with(UPPER(BTRIM(material_inventory_code)), %s || '_')
  )
ORDER BY source_inventory_code, bom_code, material_inventory_code
"""

_OPEN_PS_SQL = """
SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
    c.ps_id,
    c.pp_partial_no,
    c.part_no,
    c.description AS part_desc,
    c.bom_code,
    c.due_date,
    c.order_date,
    c.status,
    c.execution_status,
    COALESCE(NULLIF(c.partial_qty, 0), c.total_qty, 0) AS qty,
    c.qty_shipped,
    c.source_voucher_no AS sales_order_no,
    c.current_stage_desc,
    c.current_stage_status,
    ps.planner_ps_id,
    ps.planner_status,
    ps.status AS planner_ps_status,
    bv.bom_code AS selected_bom_code
FROM pp_vouchers_cache c
LEFT JOIN planner_process_sheet ps
       ON ps.source_ps_id = c.ps_id
      AND ps.pp_partial_no = c.pp_partial_no
LEFT JOIN planner_bom_variation bv
       ON bv.bom_id = ps.selected_bom_id
WHERE UPPER(BTRIM(c.part_no)) = ANY(%s)
ORDER BY c.ps_id, c.pp_partial_no, c.stage_no NULLS FIRST
"""

_PLANNER_PS_SQL = """
SELECT
    ps.planner_ps_id,
    ps.source_ps_id AS ps_id,
    ps.pp_partial_no,
    ps.inventory_code AS part_no,
    ps.planner_status,
    ps.status,
    ps.finished_qty AS qty,
    bv.bom_code AS selected_bom_code
FROM planner_process_sheet ps
LEFT JOIN planner_bom_variation bv
       ON bv.bom_id = ps.selected_bom_id
WHERE UPPER(BTRIM(ps.inventory_code)) = ANY(%s)
"""

_REQUIREMENT_SQL = """
SELECT
    r.planner_ps_id,
    r.material_inventory_code,
    r.source_inventory_code,
    r.bom_code,
    r.material_qty_needed,
    ps.source_ps_id AS ps_id,
    ps.pp_partial_no,
    ps.inventory_code AS part_no,
    ps.planner_status,
    ps.status,
    COALESCE(v.description, '') AS part_desc,
    v.due_date,
    COALESCE(NULLIF(v.partial_qty, 0), v.total_qty, ps.planned_qty, 0) AS qty,
    v.source_voucher_no AS sales_order_no,
    bv.bom_code AS selected_bom_code
FROM planner_material_requirement r
JOIN planner_process_sheet ps
  ON ps.planner_ps_id = r.planner_ps_id
LEFT JOIN pp_vouchers_cache v
       ON v.ps_id = ps.source_ps_id
      AND v.pp_partial_no = ps.pp_partial_no
LEFT JOIN planner_bom_variation bv
       ON bv.bom_id = ps.selected_bom_id
WHERE BTRIM(COALESCE(r.material_inventory_code, '')) <> ''
  AND (
        UPPER(BTRIM(r.material_inventory_code)) = %s
     OR starts_with(%s, UPPER(BTRIM(r.material_inventory_code)) || '_')
     OR starts_with(UPPER(BTRIM(r.material_inventory_code)), %s || '_')
  )
"""

_HISTORICAL_SQL = """
SELECT
    m.process_sheet_no AS ps_id,
    1 AS pp_partial_no,
    m.pp_voucher_no,
    m.inventory_code AS part_no,
    m.total_qty AS qty,
    m.sales_order_date
FROM mfg_process_sheet_info m
WHERE m.process_sheet_no IS NOT NULL
  AND BTRIM(m.process_sheet_no) <> ''
  AND UPPER(BTRIM(m.inventory_code)) = ANY(%s)
ORDER BY m.sales_order_date DESC NULLS LAST, m.process_sheet_no DESC
LIMIT %s
"""

_HISTORICAL_COUNT_SQL = """
SELECT UPPER(BTRIM(inventory_code)) AS part_no,
       COUNT(DISTINCT process_sheet_no) AS ps_count
FROM mfg_process_sheet_info
WHERE process_sheet_no IS NOT NULL
  AND BTRIM(process_sheet_no) <> ''
  AND UPPER(BTRIM(inventory_code)) = ANY(%s)
GROUP BY UPPER(BTRIM(inventory_code))
"""

_PART_DESC_SQL = """
SELECT inventory_code, main_desc
FROM part_desc
WHERE UPPER(BTRIM(inventory_code)) = ANY(%s)
"""


def fetch_inventory_where_used(con, code: str) -> dict[str, Any]:
    code = compact_text(code)
    if not code:
        return assemble_where_used(code="", bom_rows=[])

    code_u = _norm_code(code)
    bom_rows = rows(con.execute(_BOM_SQL, (code_u, code_u, code_u)))
    parent_codes = sorted(
        {
            _norm_code(row.get("source_inventory_code"))
            for row in bom_rows
            if compact_text(row.get("source_inventory_code"))
        }
        | {code_u}
    )

    open_rows = _query_rows(con, "inv_wu_open", _OPEN_PS_SQL, (parent_codes,)) if parent_codes else []
    planner_rows = _query_rows(con, "inv_wu_planner", _PLANNER_PS_SQL, (parent_codes,)) if parent_codes else []
    requirement_rows = _query_rows(con, "inv_wu_req", _REQUIREMENT_SQL, (code_u, code_u, code_u))
    historical_rows = (
        _query_rows(
            con,
            "inv_wu_hist",
            _HISTORICAL_SQL,
            (parent_codes, HISTORICAL_FETCH_LIMIT),
        )
        if parent_codes
        else []
    )
    count_rows = (
        _query_rows(con, "inv_wu_hist_count", _HISTORICAL_COUNT_SQL, (parent_codes,))
        if parent_codes
        else []
    )
    historical_counts = {
        compact_text(row.get("part_no")): int(row.get("ps_count") or 0)
        for row in count_rows
        if compact_text(row.get("part_no"))
    }
    desc_rows = _query_rows(con, "inv_wu_desc", _PART_DESC_SQL, (parent_codes,)) if parent_codes else []
    part_descs = {
        compact_text(row.get("inventory_code")): compact_text(row.get("main_desc"))
        for row in desc_rows
        if compact_text(row.get("inventory_code"))
    }

    payload = assemble_where_used(
        code=code,
        bom_rows=bom_rows,
        open_rows=open_rows,
        historical_rows=historical_rows,
        planner_rows=planner_rows,
        requirement_rows=requirement_rows,
        part_descs=part_descs,
        historical_counts=historical_counts,
    )
    payload["source"] = "material_per_bom + pp_vouchers_cache + mfg_process_sheet_info"
    return payload
