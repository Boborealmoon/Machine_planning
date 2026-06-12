"""Sales orders — mfg_pp_vch foundation, nested partials, so_order_view header join."""
from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error
from .helpers import planner_db, rows
from .utils import compact_text, shipped_quantity_completed

logger = logging.getLogger(__name__)

sales_orders_bp = Blueprint("sales_orders", __name__)

_CACHE_TTL_SEC = 300
_cache: tuple[float, dict[str, list[dict[str, Any]]]] | None = None
_SCHEMA_VERSION = 8

_NOTE_FIELDS = (
    "material_subcon",
    "mtl_part_order",
    "quality_doc",
    "ops_notes",
    "sales_notes",
)

_MFG_PP_VCH_SQL = """
SELECT
    pp.pp_voucher_no,
    pp.inventory_code,
    pp.bom_code,
    pp.bom_desc,
    pp.pp_qty,
    pp.source_voucher_no,
    pp.source_rsd,
    pp.source_line_item_no,
    pp.status,
    pp.segment_1_code,
    pp.proposed_edd,
    pp.production_due_date,
    pp.remarks,
    pp.customer_code,
    pp.mark_as_complete,
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS process_sheet_no,
    COALESCE(ps.sales_order_date, hdr.order_date) AS order_date,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), ''),
        NULLIF(TRIM(pp.bom_desc), '')
    ) AS description,
    COALESCE(NULLIF(TRIM(part.customer_po_no), ''), NULLIF(TRIM(hdr.customer_po_no), '')) AS customer_po_no,
    COALESCE(det.required_shipment_date, pp.source_rsd) AS due_date,
    CASE
        WHEN pp.proposed_edd IS NULL THEN NULL
        WHEN pp.proposed_edd::date = COALESCE(det.required_shipment_date, pp.source_rsd)::date THEN NULL
        ELSE pp.proposed_edd
    END AS delivery_date,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    (COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) * pp.pp_qty) AS amount,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped
FROM public.mfg_pp_vch pp
LEFT JOIN (
    SELECT DISTINCT ON (pp_voucher_no)
        pp_voucher_no,
        process_sheet_no,
        sales_order_date,
        inventory_code
    FROM public.mfg_process_sheet_info_v1_view
    ORDER BY pp_voucher_no, process_sheet_no
) ps ON ps.pp_voucher_no = pp.pp_voucher_no
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = COALESCE(ps.inventory_code, pp.inventory_code)
LEFT JOIN public.so_order_view hdr
       ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.so_order_ost_det det
       ON det.sales_order_no = pp.source_voucher_no
      AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT pp_voucher_no, MAX(customer_po_no) AS customer_po_no
    FROM public.mfg_pp_partial_view
    GROUP BY pp_voucher_no
) part ON part.pp_voucher_no = pp.pp_voucher_no
WHERE pp.source_voucher_no IS NOT NULL
ORDER BY pp.source_voucher_no, pp.pp_voucher_no
"""

_MFG_PP_PARTIAL_SQL = """
SELECT
    pp_voucher_no,
    pp_partial_no,
    inventory_code,
    customer_code,
    party_name,
    customer_po_no
FROM public.mfg_pp_partial_view
ORDER BY pp_voucher_no, pp_partial_no
"""

_SO_ORDER_HEADER_SQL = """
SELECT
    sales_order_no,
    status,
    voucher_status,
    order_date,
    customer_code,
    customer_name,
    customer_short_name,
    customer_po_no,
    sales_person_code,
    sales_person_name,
    sbu_code,
    sbu_desc,
    reference_no,
    sales_quotation_no,
    total_after_tax_home_amt,
    total_pre_tax_home_amt,
    created_datetime,
    created_by_alias,
    last_updated_datetime,
    last_updated_by_alias,
    remarks,
    external_remarks,
    subject
FROM public.so_order_view
"""

_SO_POSTED_DATES_SQL = """
SELECT
    h.sales_order_no,
    COALESCE(rev.first_posted_datetime, h.posted_datetime) AS first_posted_datetime,
    h.posted_datetime AS latest_posted_datetime
FROM public.so_order_ost_hdr h
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = h.sales_order_no
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


def _normalize_line_item_no(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = re.sub(r"\.0+$", "", text)
    return text or None


def _order_sort_key(order: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(order.get("first_posted_datetime") or order.get("order_date") or ""),
        str(order.get("created_datetime") or ""),
        str(order.get("sales_order_no") or ""),
    )


def _erp_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows_out = cur.fetchall()
            return [_serialize_row(dict(row)) for row in rows_out]
    finally:
        release_conn(conn)


def _headers_by_sales_order(headers: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_so: dict[str, dict[str, Any]] = {}
    for row in headers:
        so_no = compact_text(row.get("sales_order_no"))
        if so_no:
            by_so[so_no] = row
    return by_so


def _posted_dates_by_sales_order(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_so: dict[str, dict[str, Any]] = {}
    for row in rows:
        so_no = compact_text(row.get("sales_order_no"))
        if so_no:
            by_so[so_no] = row
    return by_so


def _partials_by_pp_voucher(partials: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for raw in partials:
        row = dict(raw)
        pp_no = compact_text(row.get("pp_voucher_no"))
        if not pp_no:
            continue
        grouped.setdefault(pp_no, []).append(row)
    for pp_rows in grouped.values():
        pp_rows.sort(key=lambda row: int(row.get("pp_partial_no") or 0))
    return grouped


def _empty_notes() -> dict[str, Any]:
    out = {field: "" for field in _NOTE_FIELDS}
    out["ps_highlighted"] = False
    out["highlighted_partials"] = []
    return out


def _parse_highlighted_partials(raw: Any, *, legacy_bool: bool = False) -> list[int]:
    out: list[int] = []
    text = compact_text(raw)
    if text:
        for part in text.split(","):
            part = part.strip()
            if part.isdigit():
                out.append(int(part))
    if not out and legacy_bool:
        out = [1]
    return sorted(set(out))


def _format_highlighted_partials(partials: list[int]) -> str:
    return ",".join(str(p) for p in sorted(set(int(p) for p in partials if int(p) > 0)))


def _notes_from_row(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return _empty_notes()
    out = {field: compact_text(row.get(field)) for field in _NOTE_FIELDS}
    highlighted = _parse_highlighted_partials(
        row.get("highlighted_partials"),
        legacy_bool=bool(row.get("ps_highlighted")),
    )
    out["highlighted_partials"] = highlighted
    out["ps_highlighted"] = bool(highlighted)
    return out


def _ensure_notes_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_so_pp_notes (
            pp_voucher_no       TEXT         PRIMARY KEY,
            material_subcon     TEXT         NOT NULL DEFAULT '',
            mtl_part_order      TEXT         NOT NULL DEFAULT '',
            quality_doc         TEXT         NOT NULL DEFAULT '',
            ops_notes           TEXT         NOT NULL DEFAULT '',
            sales_notes         TEXT         NOT NULL DEFAULT '',
            ps_highlighted      BOOLEAN      NOT NULL DEFAULT FALSE,
            updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        ALTER TABLE planner_so_pp_notes
        ADD COLUMN IF NOT EXISTS ps_highlighted BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    con.execute(
        """
        ALTER TABLE planner_so_pp_notes
        ADD COLUMN IF NOT EXISTS highlighted_partials TEXT NOT NULL DEFAULT ''
        """
    )


def _ps_base_id(ps_id: str) -> str:
    return compact_text(ps_id).split("::")[0]


def _default_material_in_overlay() -> dict[str, Any]:
    return {"material_in": False, "material_in_date": None}


def _load_material_in_overlay(process_sheet_nos: list[str]) -> dict[str, dict[str, Any]]:
    bases: list[str] = []
    seen: set[str] = set()
    for raw in process_sheet_nos:
        base = _ps_base_id(raw)
        if not base or base in seen:
            continue
        seen.add(base)
        bases.append(base)
    if not bases:
        return {}

    default = _default_material_in_overlay()
    try:
        from .process_sheets import _ensure_planner_overlay_columns

        with planner_db() as con:
            _ensure_planner_overlay_columns(con)
            fetched = rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id,
                           COALESCE(material_in, FALSE) AS material_in,
                           material_in_date
                    FROM planner_process_sheet
                    WHERE planner_ps_id = ANY(%s)
                       OR source_ps_id = ANY(%s)
                       OR split_part(planner_ps_id, '::', 1) = ANY(%s)
                    """,
                    (bases, bases, bases),
                )
            )
    except Exception as exc:
        logger.warning("material_in overlay load skipped: %s", exc)
        return {base: dict(default) for base in bases}

    out = {base: dict(default) for base in bases}
    for row in fetched:
        payload = {
            "material_in": bool(row.get("material_in")),
            "material_in_date": _serialize_value(row.get("material_in_date")),
        }
        for key in (
            compact_text(row.get("planner_ps_id")),
            compact_text(row.get("source_ps_id")),
        ):
            base = _ps_base_id(key)
            if base in out:
                out[base] = payload
    return out


def _apply_material_in_overlay(orders: list[dict[str, Any]], overlay: dict[str, dict[str, Any]]) -> None:
    default = _default_material_in_overlay()
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            base = _ps_base_id(pp.get("process_sheet_no") or "")
            pp.update(overlay.get(base, default))


_QUEUED_MACHINES_SQL = """
SELECT DISTINCT
    COALESCE(NULLIF(TRIM(o.source_ps_id), ''), NULLIF(TRIM(o.job_no), '')) AS raw_ps_id,
    m.machine_no
FROM planner_operation o
JOIN planner_run_block b ON b.operation_id = o.operation_id
JOIN planner_machines m ON m.machine_id = b.machine_id
WHERE COALESCE(b.active, TRUE) = TRUE
  AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
  AND m.active = TRUE
  AND COALESCE(NULLIF(TRIM(o.source_ps_id), ''), NULLIF(TRIM(o.job_no), '')) <> ''
ORDER BY raw_ps_id, m.machine_no
"""


def _pp_ps_base(pp: dict[str, Any]) -> str:
    return _ps_base_id(pp.get("process_sheet_no") or pp.get("pp_voucher_no") or "")


def _machines_for_planner_ps_id(
    by_canonical: dict[str, list[str]],
    ps_id: str,
) -> list[str]:
    """Match planner queue rows to a sales-order partial (same rules as catalog sidebar)."""
    from .catalog import _canonical_catalog_ps_id, _catalog_op_qty_ps_ids

    machines: list[str] = []
    for variant in _catalog_op_qty_ps_ids(ps_id):
        canonical = _canonical_catalog_ps_id(variant)
        for machine in by_canonical.get(canonical, []):
            if machine not in machines:
                machines.append(machine)
    return machines


def _load_queued_machines_by_canonical_ps() -> dict[str, list[str]]:
    from .catalog import _canonical_catalog_ps_id

    out: dict[str, list[str]] = {}
    try:
        with planner_db() as con:
            fetched = rows(con.execute(_QUEUED_MACHINES_SQL))
    except Exception as exc:
        logger.warning("queued machines overlay load skipped: %s", exc)
        return out

    for row in fetched:
        raw_ps_id = compact_text(row.get("raw_ps_id"))
        machine = compact_text(row.get("machine_no"))
        if not raw_ps_id or not machine:
            continue
        canonical = _canonical_catalog_ps_id(raw_ps_id)
        if not canonical:
            continue
        bucket = out.setdefault(canonical, [])
        if machine not in bucket:
            bucket.append(machine)
    return out


_STAGE_OVERLAY_SQL = """
SELECT
    split_part(ps_id, '::', 1) AS ps_base,
    pp_partial_no,
    MAX(current_stage_no) AS current_stage_no,
    MAX(current_stage_desc) AS current_stage_desc,
    MAX(current_stage_status) AS current_stage_status
FROM pp_vouchers_cache
WHERE split_part(ps_id, '::', 1) = ANY(%s)
GROUP BY split_part(ps_id, '::', 1), pp_partial_no
"""


def _default_stage_overlay() -> dict[str, Any]:
    return {
        "current_stage_no": None,
        "current_stage_desc": "",
        "current_stage_status": "",
    }


def _load_stage_overlay(process_sheet_nos: list[str]) -> dict[tuple[str, int], dict[str, Any]]:
    bases: list[str] = []
    seen: set[str] = set()
    for raw in process_sheet_nos:
        base = _ps_base_id(raw)
        if not base or base in seen:
            continue
        seen.add(base)
        bases.append(base)
    if not bases:
        return {}

    try:
        with planner_db() as con:
            fetched = rows(con.execute(_STAGE_OVERLAY_SQL, (bases,)))
    except Exception as exc:
        logger.warning("stage overlay load skipped: %s", exc)
        return {}

    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in fetched:
        ps_base = compact_text(row.get("ps_base"))
        if not ps_base:
            continue
        try:
            partial_no = max(1, int(row.get("pp_partial_no") or 1))
        except (TypeError, ValueError):
            partial_no = 1
        stage_desc = compact_text(row.get("current_stage_desc"))
        stage_status = compact_text(row.get("current_stage_status"))
        if not stage_desc and not stage_status:
            continue
        stage_no = row.get("current_stage_no")
        out[(ps_base, partial_no)] = {
            "current_stage_no": int(stage_no) if stage_no is not None else None,
            "current_stage_desc": stage_desc,
            "current_stage_status": stage_status,
        }
    return out


def _apply_stage_overlay(
    orders: list[dict[str, Any]],
    overlay: dict[tuple[str, int], dict[str, Any]],
) -> None:
    default = _default_stage_overlay()
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            base = _pp_ps_base(pp)
            partial_rows = pp.get("partials") or []
            if not partial_rows:
                pp.update(overlay.get((base, 1), default))
                continue
            for partial in partial_rows:
                try:
                    partial_no = max(1, int(partial.get("pp_partial_no") or 1))
                except (TypeError, ValueError):
                    partial_no = 1
                partial.update(overlay.get((base, partial_no), default))


def _apply_queued_machines_overlay(
    orders: list[dict[str, Any]],
    by_canonical: dict[str, list[str]],
) -> None:
    from .process_sheets import format_planner_ps_id

    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            base = _pp_ps_base(pp)
            partial_rows = pp.get("partials") or []
            if not partial_rows:
                partial_rows = [{"pp_partial_no": 1}]
            all_machines: list[str] = []
            by_partial: dict[str, list[str]] = {}
            for partial in partial_rows:
                partial_no = int(partial.get("pp_partial_no") or 1)
                ps_id = format_planner_ps_id(base, partial_no)
                machines = _machines_for_planner_ps_id(by_canonical, ps_id)
                partial["queued_machines"] = machines
                by_partial[str(partial_no)] = machines
                for machine in machines:
                    if machine not in all_machines:
                        all_machines.append(machine)
            pp["queued_machines"] = all_machines
            pp["queued_machines_by_partial"] = by_partial


def _strip_completed_highlights(orders: list[dict[str, Any]]) -> list[str]:
    to_clear: list[str] = []
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            if pp.get("shipped_completed") and pp.get("highlighted_partials"):
                pp["highlighted_partials"] = []
                pp["ps_highlighted"] = False
                pp_no = compact_text(pp.get("pp_voucher_no"))
                if pp_no:
                    to_clear.append(pp_no)
    return to_clear


def _batch_clear_ps_highlights(pp_voucher_nos: list[str]) -> None:
    ids = [compact_text(v) for v in pp_voucher_nos if compact_text(v)]
    if not ids:
        return
    try:
        with planner_db() as con:
            _ensure_notes_table(con)
            con.execute(
                """
                UPDATE planner_so_pp_notes
                SET ps_highlighted = FALSE,
                    highlighted_partials = '',
                    updated_at = NOW()
                WHERE pp_voucher_no = ANY(%s)
                  AND (ps_highlighted = TRUE OR highlighted_partials <> '')
                """,
                (ids,),
            )
    except Exception as exc:
        logger.warning("ps_highlighted batch clear skipped: %s", exc)


def _load_notes_map(pp_voucher_nos: list[str]) -> dict[str, dict[str, str]]:
    ids = [compact_text(v) for v in pp_voucher_nos if compact_text(v)]
    if not ids:
        return {}
    try:
        with planner_db() as con:
            _ensure_notes_table(con)
            fetched = rows(
                con.execute(
                    """
                    SELECT pp_voucher_no, material_subcon, mtl_part_order,
                           quality_doc, ops_notes, sales_notes, ps_highlighted,
                           highlighted_partials
                    FROM planner_so_pp_notes
                    WHERE pp_voucher_no = ANY(%s)
                    """,
                    (ids,),
                )
            )
    except Exception as exc:
        logger.warning("planner_so_pp_notes load skipped: %s", exc)
        return {}

    out: dict[str, dict[str, str]] = {}
    for row in fetched:
        key = compact_text(row.get("pp_voucher_no"))
        if key:
            out[key] = _notes_from_row(row)
    return out


def _build_orders_from_pp_vouchers(
    pp_rows: list[dict[str, Any]],
    partials_by_pp: dict[str, list[dict[str, Any]]],
    headers_by_so: dict[str, dict[str, Any]],
    posted_by_so: dict[str, dict[str, Any]] | None = None,
    notes_by_pp: dict[str, dict[str, str]] | None = None,
) -> list[dict[str, Any]]:
    """mfg_pp_vch rows grouped by source_voucher_no with nested partials + SO header."""
    grouped: dict[str, dict[str, Any]] = {}
    notes_map = notes_by_pp or {}
    seen_pp: set[str] = set()

    for raw in pp_rows:
        pp = dict(raw)
        pp_no = compact_text(pp.get("pp_voucher_no"))
        so_no = compact_text(pp.get("source_voucher_no"))
        if not pp_no or not so_no or pp_no in seen_pp:
            continue
        seen_pp.add(pp_no)

        pp["source_line_item_no"] = _normalize_line_item_no(pp.get("source_line_item_no"))
        pp["partials"] = partials_by_pp.get(pp_no, [])
        pp["partial_count"] = len(pp["partials"])
        pp["shipped_completed"] = shipped_quantity_completed(
            pp.get("so_det_qty"),
            pp.get("qty_shipped"),
        )
        pp.update(notes_map.get(pp_no, _empty_notes()))

        if so_no not in grouped:
            header = dict(headers_by_so.get(so_no, {}))
            header["sales_order_no"] = so_no
            header["has_header"] = so_no in headers_by_so
            posted = dict((posted_by_so or {}).get(so_no, {}))
            header["first_posted_datetime"] = posted.get("first_posted_datetime")
            header["latest_posted_datetime"] = posted.get("latest_posted_datetime")
            header["pp_vouchers"] = []
            grouped[so_no] = header

        grouped[so_no]["pp_vouchers"].append(pp)

    orders: list[dict[str, Any]] = []
    for order in grouped.values():
        pp_vouchers = order.get("pp_vouchers") or []
        pp_vouchers.sort(key=lambda row: str(row.get("pp_voucher_no") or ""))
        order["pp_count"] = len(pp_vouchers)
        order["partial_count"] = sum(int(row.get("partial_count") or 0) for row in pp_vouchers)
        orders.append(order)

    orders.sort(key=_order_sort_key, reverse=True)
    return orders


def _order_with_pp_subset(order: dict[str, Any], pp_vouchers: list[dict[str, Any]]) -> dict[str, Any]:
    out = dict(order)
    out["pp_vouchers"] = pp_vouchers
    out["pp_count"] = len(pp_vouchers)
    out["partial_count"] = sum(int(row.get("partial_count") or 0) for row in pp_vouchers)
    return out


def _split_by_shipped_completion(orders: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Active vs complete per PP job — fully shipped SO line qty (same rule as planner lanes)."""
    active: list[dict[str, Any]] = []
    complete: list[dict[str, Any]] = []
    for order in orders:
        pp_vouchers = order.get("pp_vouchers") or []
        active_pp = [pp for pp in pp_vouchers if not pp.get("shipped_completed")]
        complete_pp = [pp for pp in pp_vouchers if pp.get("shipped_completed")]
        if active_pp:
            active.append(_order_with_pp_subset(order, active_pp))
        if complete_pp:
            complete.append(_order_with_pp_subset(order, complete_pp))
    return {"active": active, "complete": complete}


def _job_count(orders: list[dict[str, Any]]) -> int:
    return sum(len(order.get("pp_vouchers") or []) for order in orders)


def _fetch_sales_orders(*, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
    global _cache
    now = time.time()
    if not refresh and _cache and now - _cache[0] < _CACHE_TTL_SEC:
        return _cache[1]

    pp_rows = _erp_query(_MFG_PP_VCH_SQL)
    notes_map = _load_notes_map([str(row.get("pp_voucher_no") or "") for row in pp_rows])
    partials = _erp_query(_MFG_PP_PARTIAL_SQL)
    headers = _erp_query(_SO_ORDER_HEADER_SQL)
    posted_dates = _erp_query(_SO_POSTED_DATES_SQL)
    orders = _build_orders_from_pp_vouchers(
        pp_rows,
        _partials_by_pp_voucher(partials),
        _headers_by_sales_order(headers),
        _posted_dates_by_sales_order(posted_dates),
        notes_map,
    )
    process_sheets = [
        pp.get("process_sheet_no")
        for order in orders
        for pp in (order.get("pp_vouchers") or [])
        if pp.get("process_sheet_no")
    ]
    _apply_material_in_overlay(orders, _load_material_in_overlay(process_sheets))
    _apply_stage_overlay(orders, _load_stage_overlay(process_sheets))
    _apply_queued_machines_overlay(orders, _load_queued_machines_by_canonical_ps())
    to_clear = _strip_completed_highlights(orders)
    if to_clear:
        _batch_clear_ps_highlights(to_clear)
    payload = _split_by_shipped_completion(orders)
    _cache = (now, payload)
    return payload


def _upsert_notes(pp_voucher_no: str, patch: dict[str, Any]) -> dict[str, Any]:
    with planner_db() as con:
        _ensure_notes_table(con)
        existing = rows(
            con.execute(
                """
                SELECT pp_voucher_no, material_subcon, mtl_part_order,
                       quality_doc, ops_notes, sales_notes, ps_highlighted,
                       highlighted_partials
                FROM planner_so_pp_notes
                WHERE pp_voucher_no = %s
                """,
                (pp_voucher_no,),
            )
        )
        current = _notes_from_row(existing[0] if existing else None)
        partial_toggle = patch.pop("partial_highlight", None)
        if partial_toggle is not None:
            try:
                partial_no = max(1, int(partial_toggle.get("pp_partial_no") or 1))
            except (TypeError, ValueError):
                partial_no = 1
            highlighted_set = set(current.get("highlighted_partials") or [])
            if bool(partial_toggle.get("highlighted")):
                highlighted_set.add(partial_no)
            else:
                highlighted_set.discard(partial_no)
            current["highlighted_partials"] = sorted(highlighted_set)
            current["ps_highlighted"] = bool(highlighted_set)
        elif "ps_highlighted" in patch:
            on = bool(patch.pop("ps_highlighted"))
            try:
                partial_no = max(1, int(patch.pop("pp_partial_no", 1) or 1))
            except (TypeError, ValueError):
                partial_no = 1
            highlighted_set = set(current.get("highlighted_partials") or [])
            if on:
                highlighted_set.add(partial_no)
            else:
                highlighted_set.discard(partial_no)
            current["highlighted_partials"] = sorted(highlighted_set)
            current["ps_highlighted"] = bool(highlighted_set)
        for key, value in patch.items():
            if key in _NOTE_FIELDS:
                current[key] = compact_text(value)
        highlighted_text = _format_highlighted_partials(current.get("highlighted_partials") or [])
        con.execute(
            """
            INSERT INTO planner_so_pp_notes (
                pp_voucher_no, material_subcon, mtl_part_order,
                quality_doc, ops_notes, sales_notes, ps_highlighted,
                highlighted_partials, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (pp_voucher_no) DO UPDATE SET
                material_subcon = EXCLUDED.material_subcon,
                mtl_part_order = EXCLUDED.mtl_part_order,
                quality_doc = EXCLUDED.quality_doc,
                ops_notes = EXCLUDED.ops_notes,
                sales_notes = EXCLUDED.sales_notes,
                ps_highlighted = EXCLUDED.ps_highlighted,
                highlighted_partials = EXCLUDED.highlighted_partials,
                updated_at = NOW()
            """,
            (
                pp_voucher_no,
                current["material_subcon"],
                current["mtl_part_order"],
                current["quality_doc"],
                current["ops_notes"],
                current["sales_notes"],
                current["ps_highlighted"],
                highlighted_text,
            ),
        )
        current["highlighted_partials"] = _parse_highlighted_partials(highlighted_text)
        return {"pp_voucher_no": pp_voucher_no, **current}


@sales_orders_bp.get("/sales-orders")
def sales_orders_page():
    return render_template("sales_orders.html", active="sales_orders")


@sales_orders_bp.get("/api/sales-orders")
def api_sales_orders():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        data = _fetch_sales_orders(refresh=refresh)
    except Exception as exc:
        logger.exception("sales orders ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    active = data.get("active") or []
    complete = data.get("complete") or []
    cached_at = _cache[0] if _cache else time.time()
    active_jobs = _job_count(active)
    complete_jobs = _job_count(complete)
    pp_count = active_jobs + complete_jobs
    partial_count = sum(int(row.get("partial_count") or 0) for row in active + complete)
    missing_header = sum(1 for row in active + complete if not row.get("has_header"))

    return jsonify(
        {
            "ok": True,
            "schema_version": _SCHEMA_VERSION,
            "source": "mfg_pp_vch",
            "active_count": len(active),
            "complete_count": len(complete),
            "active_job_count": active_jobs,
            "complete_job_count": complete_jobs,
            "pp_count": pp_count,
            "partial_count": partial_count,
            "missing_header_count": missing_header,
            "count": len(active) + len(complete),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "active": active,
            "complete": complete,
        }
    )


@sales_orders_bp.patch("/api/sales-orders/notes/<path:pp_voucher_no>")
@sales_orders_bp.put("/api/sales-orders/notes/<path:pp_voucher_no>")
def api_sales_order_notes(pp_voucher_no):
    pp_voucher_no = compact_text(pp_voucher_no)
    if not pp_voucher_no:
        return jsonify({"error": "pp_voucher_no is required"}), 400

    data = request.get_json(force=True, silent=True) or {}
    patch: dict[str, Any] = {}
    for field in _NOTE_FIELDS:
        if field in data:
            patch[field] = compact_text(data.get(field))
    if "partial_highlight" in data and isinstance(data.get("partial_highlight"), dict):
        patch["partial_highlight"] = data.get("partial_highlight")
    elif "ps_highlighted" in data:
        patch["ps_highlighted"] = bool(data.get("ps_highlighted"))
        if "pp_partial_no" in data:
            patch["pp_partial_no"] = data.get("pp_partial_no")

    if not patch:
        return jsonify({"error": "No editable fields supplied"}), 400

    try:
        payload = _upsert_notes(pp_voucher_no, patch)
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        logger.exception("sales order notes save failed")
        return jsonify({"error": str(exc)}), 500

    if _cache:
        for bucket in ("active", "complete"):
            for order in _cache[1].get(bucket, []):
                for pp in order.get("pp_vouchers") or []:
                    if compact_text(pp.get("pp_voucher_no")) == pp_voucher_no:
                        pp.update(payload)

    return jsonify({"ok": True, **payload})
