"""BOM Variation queries — Lookup, BOM Per Part, BOM Per PS."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .utils import compact_text

logger = logging.getLogger(__name__)

bom_variation_bp = Blueprint("bom_variation", __name__)

_CACHE_TTL_SEC = 300
_bom_per_part_cache: tuple[float, list[dict]] | None = None
_bom_per_ps_cache: tuple[float, list[dict]] | None = None

_EXCLUDE_DO_NOT_USE = "UPPER(COALESCE(i.main_desc, '')) NOT LIKE '%DO NOT USE%'"

_BOM_LOOKUP_SELECT = """
SELECT
    s.inventory_code           AS "Part No",
    i.main_desc                AS "Part Name",
    s.bom_code                 AS "BOM Code",
    s.stage_desc               AS "OP Description",
    bm.qty_parent              AS "Required Quantity",
    bm.material_inventory_code AS "Material Inventory Code",
    bm.description             AS "Material Description"
FROM mt_inventory_bom_stage s
LEFT JOIN mt_inventory_item_view i
    ON s.inventory_code = i.inventory_code
LEFT JOIN inventory_bom_listing bm
    ON s.inventory_code = bm.source_inventory_code
    AND s.bom_code = bm.bom_code
"""


def _parse_lookup_terms(raw: str) -> list[str]:
    return [t.strip() for t in raw.replace(";", ",").split(",") if t.strip()]


def _build_lookup_sql(terms: list[str]) -> tuple[str, dict[str, Any]]:
    """Match each term against part no (exact), part name, or BOM code (contains)."""
    term_clauses: list[str] = []
    params: dict[str, Any] = {}
    for idx, term in enumerate(terms):
        exact_key = f"term_{idx}"
        like_key = f"like_{idx}"
        upper_term = term.upper()
        params[exact_key] = upper_term
        params[like_key] = f"%{upper_term}%"
        term_clauses.append(
            f"""(
            s.inventory_code = %({exact_key})s
            OR UPPER(COALESCE(i.main_desc, '')) LIKE %({like_key})s
            OR UPPER(s.bom_code) LIKE %({like_key})s
        )"""
        )
    where = f"({' OR '.join(term_clauses)}) AND {_EXCLUDE_DO_NOT_USE}"
    sql = (
        _BOM_LOOKUP_SELECT
        + f"WHERE {where}\n"
        + """ORDER BY
    s.inventory_code ASC,
    s.bom_code ASC,
    s.stage_no ASC
"""
    )
    return sql, params

_BOM_PER_PART_SQL = """
SELECT
    s.inventory_code           AS "Part No",
    i.main_desc                AS "Part Name",
    s.bom_code                 AS "BOM Code",
    CAST(
        NULLIF(REGEXP_REPLACE(s.stage_desc, '[^0-9]', '', 'g'), '')
        AS INTEGER
    )                          AS "OP No",
    s.stage_desc               AS "OP Description",
    bm.qty_parent              AS "Inhouse Quantity",
    bm.material_inventory_code AS "Material Inventory Code",
    bm.description             AS "Material Description"
FROM mt_inventory_bom_stage s
LEFT JOIN mt_inventory_item_view i
    ON s.inventory_code = i.inventory_code
LEFT JOIN inventory_bom_listing bm
    ON s.inventory_code = bm.source_inventory_code
    AND s.bom_code = bm.bom_code
WHERE """ + _EXCLUDE_DO_NOT_USE + """
ORDER BY
    s.inventory_code ASC,
    s.bom_code ASC,
    "OP No" ASC
"""

_BOM_PER_PS_SQL = """
SELECT
    ps.process_sheet_no        AS "Process Sheet",
    s.inventory_code           AS "Part No",
    i.main_desc                AS "Part Name",
    s.bom_code                 AS "BOM Code",
    CAST(
        NULLIF(REGEXP_REPLACE(s.stage_desc, '[^0-9]', '', 'g'), '')
        AS INTEGER
    )                          AS "OP No",
    s.stage_desc               AS "OP Description",
    bm.qty_parent              AS "Inhouse Quantity",
    bm.material_inventory_code AS "Material Inventory Code",
    bm.description             AS "Material Description"
FROM mfg_process_sheet_info_v1_view ps
LEFT JOIN mt_inventory_bom_stage s
    ON ps.inventory_code = s.inventory_code
LEFT JOIN mt_inventory_item_view i
    ON s.inventory_code = i.inventory_code
LEFT JOIN inventory_bom_listing bm
    ON s.inventory_code = bm.source_inventory_code
    AND s.bom_code = bm.bom_code
WHERE (ps.process_sheet_no LIKE '%APS%'
   OR ps.process_sheet_no LIKE '%NPS%')
  AND """ + _EXCLUDE_DO_NOT_USE + """
ORDER BY
    ps.process_sheet_no ASC,
    s.bom_code ASC,
    "OP No" ASC
"""


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


def _erp_query(sql: str, params=None) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
            return [_serialize_row(dict(row)) for row in rows]
    finally:
        release_conn(conn)


@bom_variation_bp.get("/bom-variation")
def bom_variation_page():
    return render_template("bom_variation.html", active="bom_variation")


@bom_variation_bp.get("/api/bom-variation/lookup")
def api_bom_lookup():
    raw = request.args.get("part_nos", "") or request.args.get("q", "")
    terms = _parse_lookup_terms(raw)
    if not terms:
        return jsonify({"error": "Enter a part no, part name, or BOM code to search"}), 400
    try:
        sql, params = _build_lookup_sql(terms)
        rows = _erp_query(sql, params)
        return jsonify({"ok": True, "count": len(rows), "rows": rows})
    except Exception as exc:
        logger.exception("BOM lookup query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502


@bom_variation_bp.get("/api/bom-variation/bom-per-part")
def api_bom_per_part():
    global _bom_per_part_cache
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    now = time.time()
    if not refresh and _bom_per_part_cache and now - _bom_per_part_cache[0] < _CACHE_TTL_SEC:
        cached_rows = _bom_per_part_cache[1]
        cached_at = _bom_per_part_cache[0]
        return jsonify({
            "ok": True,
            "count": len(cached_rows),
            "rows": cached_rows,
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
        })
    try:
        rows = _erp_query(_BOM_PER_PART_SQL)
        _bom_per_part_cache = (now, rows)
        return jsonify({
            "ok": True,
            "count": len(rows),
            "rows": rows,
            "cached_at": datetime.fromtimestamp(now).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
        })
    except Exception as exc:
        logger.exception("BOM per part query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502


@bom_variation_bp.get("/api/bom-variation/bom-per-ps")
def api_bom_per_ps():
    global _bom_per_ps_cache
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    now = time.time()
    if not refresh and _bom_per_ps_cache and now - _bom_per_ps_cache[0] < _CACHE_TTL_SEC:
        cached_rows = _bom_per_ps_cache[1]
        cached_at = _bom_per_ps_cache[0]
        return jsonify({
            "ok": True,
            "count": len(cached_rows),
            "rows": cached_rows,
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
        })
    try:
        rows = _erp_query(_BOM_PER_PS_SQL)
        _bom_per_ps_cache = (now, rows)
        return jsonify({
            "ok": True,
            "count": len(rows),
            "rows": rows,
            "cached_at": datetime.fromtimestamp(now).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
        })
    except Exception as exc:
        logger.exception("BOM per PS query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502
