"""Inventory enquiry — live ic_inventory_enquiry_summary_view on COMAIN."""
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

inventory_enquiry_bp = Blueprint("inventory_enquiry", __name__)

_CACHE_TTL_SEC = 300
_CACHE_VERSION = 4
_cache: tuple[float, int, list[dict[str, Any]]] | None = None
_lot_cache: tuple[float, int, list[dict[str, Any]]] | None = None

_CLASS_KEY_BY_CODE = {
    "RAW MATERIAL": "raw_material",
    "FG MFG COMMERCIAL": "fg_mfg_commercial",
    "FG MRO": "fg_mro",
    "CP": "cp",
    "CFM": "cfm",
}

_INVENTORY_SQL = """
SELECT *
FROM public.ic_inventory_enquiry_summary_view
WHERE inventory_code IS NOT NULL
  AND BTRIM(inventory_code) <> ''
ORDER BY
    inventory_class_code NULLS LAST,
    inventory_code
"""

_LOT_REF_SQL = """
SELECT DISTINCT inventory_code, reference_no
FROM public.ic_inventory_ost_lot
WHERE inventory_code IS NOT NULL
  AND BTRIM(inventory_code) <> ''
  AND reference_no IS NOT NULL
  AND BTRIM(reference_no) <> ''
  AND (COALESCE(remaining_qty, 0) > 0 OR COALESCE(allocation_qty, 0) > 0)
ORDER BY inventory_code, reference_no
"""

_LOT_DETAIL_SQL = """
SELECT
    o.inventory_code,
    o.lot_no,
    o.reference_no,
    o.source_location_code AS location_code,
    l.location_name,
    o.original_qty,
    o.remaining_qty,
    o.available_qty,
    o.allocation_qty,
    o.expiry_date,
    o.lot_creation_date,
    o.created_datetime
FROM public.ic_inventory_ost_lot o
LEFT JOIN public.mt_location l
    ON l.location_code = o.source_location_code
WHERE o.inventory_code IS NOT NULL
  AND BTRIM(o.inventory_code) <> ''
  AND o.reference_no IS NOT NULL
  AND BTRIM(o.reference_no) <> ''
  AND (COALESCE(o.remaining_qty, 0) > 0 OR COALESCE(o.allocation_qty, 0) > 0)
ORDER BY
    o.inventory_code,
    o.reference_no,
    o.source_location_code,
    o.lot_no
"""


def _class_key(row: dict[str, Any]) -> str:
    code = compact_text(row.get("inventory_class_code")).upper()
    return _CLASS_KEY_BY_CODE.get(code, "other")


from .helpers import planner_db, rows as db_rows
from .staged_erp import live_query, serialize_row, use_staging_reads


def _enrich_inventory_row(
    row: dict[str, Any],
    *,
    lot_reference_nos: list[str] | None = None,
) -> dict[str, Any]:
    out = serialize_row(row)
    out["class_key"] = _class_key(out)
    if lot_reference_nos is not None:
        out["lot_reference_nos"] = lot_reference_nos
    return out


def _fetch_lot_reference_map() -> dict[str, list[str]]:
    refs_by_code: dict[str, list[str]] = {}
    for row in live_query(_LOT_REF_SQL):
        code = compact_text(row.get("inventory_code"))
        ref = compact_text(row.get("reference_no"))
        if not code or not ref:
            continue
        refs_by_code.setdefault(code, []).append(ref)
    return refs_by_code


def _attach_lot_references(
    rows: list[dict[str, Any]],
    refs_by_code: dict[str, list[str]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        code = compact_text(row.get("inventory_code"))
        refs = refs_by_code.get(code, [])
        enriched = dict(row)
        enriched["lot_reference_nos"] = refs
        out.append(enriched)
    return out


def _fetch_inventory_staged() -> list[dict[str, Any]]:
    with planner_db() as con:
        raw = db_rows(
            con.execute(
                """
                SELECT payload
                FROM public.stg_inventory_enquiry
                ORDER BY inventory_code
                """
            )
        )
    rows_out: list[dict[str, Any]] = []
    for row in raw:
        payload = row.get("payload") or {}
        if isinstance(payload, str):
            import json

            payload = json.loads(payload)
        rows_out.append(_enrich_inventory_row(dict(payload)))
    return _attach_lot_references(rows_out, _fetch_lot_reference_map())


def _fetch_inventory_live() -> list[dict[str, Any]]:
    rows_out = [_enrich_inventory_row(row) for row in live_query(_INVENTORY_SQL)]
    return _attach_lot_references(rows_out, _fetch_lot_reference_map())


def _class_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {key: 0 for key in _CLASS_KEY_BY_CODE.values()}
    counts["other"] = 0
    counts["all"] = len(rows)
    for row in rows:
        key = row.get("class_key") or "other"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _qty(row: dict[str, Any], key: str) -> float:
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def _stock_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    on_hand = 0
    on_order = 0
    back_order = 0
    free_balance = 0
    for row in rows:
        if _qty(row, "total_qty_on_hand") > 0:
            on_hand += 1
        if _qty(row, "total_qty_on_order") > 0:
            on_order += 1
        if _qty(row, "total_qty_back_order") > 0:
            back_order += 1
        if _qty(row, "total_free_balance_qty") > 0:
            free_balance += 1
    return {
        "on_hand": on_hand,
        "on_order": on_order,
        "back_order": back_order,
        "free_balance": free_balance,
    }


def invalidate_inventory_enquiry_cache() -> None:
    global _cache, _lot_cache
    _cache = None
    _lot_cache = None
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("inventory_enquiry:")


def _fetch_inventory(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _cache
    now = time.time()
    if (
        not refresh
        and _cache
        and _cache[1] == _CACHE_VERSION
        and now - _cache[0] < _CACHE_TTL_SEC
    ):
        return _cache[2]

    if use_staging_reads("inventory_enquiry"):
        rows_out = _fetch_inventory_staged()
    else:
        rows_out = _fetch_inventory_live()
    _cache = (now, _CACHE_VERSION, rows_out)
    return rows_out


def _serialize_lot_row(row: dict[str, Any]) -> dict[str, Any]:
    out = serialize_row(row)
    out["lot_key"] = "|".join(
        [
            compact_text(out.get("inventory_code")),
            compact_text(out.get("reference_no")),
            compact_text(out.get("location_code")),
            str(out.get("lot_no") or ""),
        ]
    )
    return out


def _fetch_lot_details(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _lot_cache
    now = time.time()
    if (
        not refresh
        and _lot_cache
        and _lot_cache[1] == _CACHE_VERSION
        and now - _lot_cache[0] < _CACHE_TTL_SEC
    ):
        return _lot_cache[2]

    rows_out = [_serialize_lot_row(row) for row in live_query(_LOT_DETAIL_SQL)]
    _lot_cache = (now, _CACHE_VERSION, rows_out)
    return rows_out


def _filter_lots_by_codes(
    lots: list[dict[str, Any]],
    codes: list[str],
) -> list[dict[str, Any]]:
    if not codes:
        return lots
    code_set = set(codes)
    return [
        lot
        for lot in lots
        if compact_text(lot.get("inventory_code")) in code_set
    ]


@inventory_enquiry_bp.get("/planning-data/inventory-enquiry")
def inventory_enquiry_page():
    return render_template("inventory_enquiry.html", active="planning_data")


def _parse_codes_filter() -> list[str]:
    raw = compact_text(request.args.get("codes"))
    if not raw:
        return []
    parts = [compact_text(part) for part in raw.replace(";", ",").split(",")]
    return [part for part in parts if part]


def _loose_match_enabled() -> bool:
    return compact_text(request.args.get("loose")).lower() in {"1", "true", "yes"}


def _inventory_matches_bom_material(inventory_code: str, bom_material_code: str) -> bool:
    """Exact match, or inventory variant with dimension suffix after underscore."""
    inv = compact_text(inventory_code)
    bom = compact_text(bom_material_code)
    if not inv or not bom:
        return False
    if inv == bom:
        return True
    return inv.startswith(f"{bom}_")


def _match_type(inventory_code: str, bom_material_code: str) -> str:
    inv = compact_text(inventory_code)
    bom = compact_text(bom_material_code)
    if inv == bom:
        return "exact"
    if inv.startswith(f"{bom}_"):
        return "suffix"
    return ""


def _filter_rows_by_codes(
    rows: list[dict[str, Any]],
    codes: list[str],
    *,
    loose: bool = False,
) -> list[dict[str, Any]]:
    if not codes:
        return rows
    if not loose:
        code_set = set(codes)
        return [
            row
            for row in rows
            if compact_text(row.get("inventory_code")) in code_set
        ]

    matched: list[dict[str, Any]] = []
    seen_inventory_codes: set[str] = set()
    for row in rows:
        inv = compact_text(row.get("inventory_code"))
        if not inv:
            continue
        for bom_code in codes:
            if not _inventory_matches_bom_material(inv, bom_code):
                continue
            if inv in seen_inventory_codes:
                break
            out = dict(row)
            out["matched_bom_material_code"] = bom_code
            out["match_type"] = _match_type(inv, bom_code)
            matched.append(out)
            seen_inventory_codes.add(inv)
            break
    return matched


@inventory_enquiry_bp.get("/api/inventory-enquiry")
def api_inventory_enquiry():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    codes = _parse_codes_filter()
    loose = _loose_match_enabled()

    try:
        rows = _fetch_inventory(refresh=refresh)
    except Exception as exc:
        logger.exception("inventory enquiry ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    if codes:
        rows = _filter_rows_by_codes(rows, codes, loose=loose)

    cached_at = _cache[0] if _cache else time.time()
    return jsonify(
        {
            "ok": True,
            "count": len(rows),
            "class_counts": _class_counts(rows),
            "stock_counts": _stock_counts(rows),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
            "filtered_codes": codes or None,
            "loose_match": loose if codes else False,
        }
    )


@inventory_enquiry_bp.get("/api/inventory-enquiry/lots")
def api_inventory_enquiry_lots():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    codes = _parse_codes_filter()

    try:
        lots = _fetch_lot_details(refresh=refresh)
    except Exception as exc:
        logger.exception("inventory enquiry lot query failed")
        return jsonify({"error": f"ERP lot query failed: {exc}"}), 502

    if codes:
        lots = _filter_lots_by_codes(lots, codes)

    cached_at = _lot_cache[0] if _lot_cache else time.time()
    return jsonify(
        {
            "ok": True,
            "count": len(lots),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": lots,
            "filtered_codes": codes or None,
        }
    )
