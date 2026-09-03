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
from .frame_agreement_service import (
    apply_frame_agreement_flags,
    load_frame_agreement_part_keys,
)
from .helpers import planner_db, rows
from .assembly_classify import is_component_child_ps
from .utils import compact_text, parse_date_text, shipped_quantity_completed
from .staged_erp import (
    STAGED_MFG_PP_PARTIAL_SQL,
    STAGED_MFG_PP_VCH_SQL,
    STAGED_SO_ORDER_HEADER_SQL,
    STAGED_SO_POSTED_DATES_SQL,
    fetch_rows,
    live_query,
)

logger = logging.getLogger(__name__)

sales_orders_bp = Blueprint("sales_orders", __name__)

_CACHE_TTL_SEC = 300
_LIVE_OVERLAY_TIMEOUT_MS = 30000
_cache: tuple[float, dict[str, list[dict[str, Any]]]] | None = None
_SCHEMA_VERSION = 23
_ACTIVE_PP_AND = """
  AND (
    det.qty IS NULL
    OR COALESCE(sq.qty_shipped, 0) < det.qty - 0.0001
  )
"""
_COMPLETE_PP_AND = """
  AND det.qty IS NOT NULL
  AND COALESCE(sq.qty_shipped, 0) >= det.qty - 0.0001
"""
_SIMILAR_PS_PREVIEW = 8

_NOTE_FIELDS = (
    "material_subcon",
    "mtl_part_order",
    "quality_doc",
    "ops_notes",
    "sales_notes",
    "buyer",
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
    pp.pp_voucher_no AS process_sheet_no,
    hdr.order_date AS order_date,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), ''),
        NULLIF(TRIM(pp.bom_desc), '')
    ) AS description,
    COALESCE(NULLIF(TRIM(part.customer_po_no), ''), NULLIF(TRIM(hdr.customer_po_no), '')) AS customer_po_no,
    COALESCE(det.required_shipment_date, pp.source_rsd) AS due_date,
    shipped.last_shipment_date AS delivery_date,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    (COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) * pp.pp_qty) AS amount,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped
FROM public.mfg_pp_vch pp
LEFT JOIN public.mt_inventory pd
       ON pd.inventory_code = pp.inventory_code
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
    SELECT
        d.source_voucher_no AS sales_order_no,
        regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        MAX(COALESCE(h.arrival_date, h.do_generation_datetime)::date) AS last_shipment_date
    FROM public.lg_out_shm_detail d
    LEFT JOIN public.lg_out_shm_hst_hdr h
           ON d.shipment_voucher_no = h.shipment_voucher_no
    WHERE NOT (d.status = 'History' AND COALESCE(d.qty_issued, 0) = 0)
      AND COALESCE(d.qty_issued, 0) > 0
    GROUP BY d.source_voucher_no,
             regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '')
) shipped
       ON shipped.sales_order_no = pp.source_voucher_no
      AND shipped.line_item_no = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
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
    v.pp_voucher_no,
    v.pp_partial_no,
    v.inventory_code,
    v.customer_code,
    v.party_name,
    v.customer_po_no,
    p.partial_qty
FROM public.mfg_pp_partial_view v
LEFT JOIN public.mfg_pp_partial p
       ON p.pp_voucher_no = v.pp_voucher_no
      AND p.pp_partial_no = v.pp_partial_no
ORDER BY v.pp_voucher_no, v.pp_partial_no
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


def _erp_query(
    sql: str,
    params: tuple = (),
    *,
    live_sql: str | None = None,
    live: bool = True,
) -> list[dict[str, Any]]:
    domain = "sales_orders" if live else None
    return fetch_rows(sql, params, live_sql=live_sql or sql, domain=domain)


def _restrict_sql(sql: str, clause: str) -> str:
    extra = (clause or "").strip()
    if not extra:
        return sql
    match = re.search(r"\nORDER BY\b", sql, re.I)
    if match:
        return sql[: match.start()] + "\n" + extra + sql[match.start() :]
    return sql.rstrip() + "\n" + extra + "\n"


def _unique_texts(values) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        text = compact_text(raw)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _sales_orders_cache_key(scope: str, *, lite: bool = False) -> str:
    base = f"sales_orders:v{_SCHEMA_VERSION}:{scope}"
    return f"{base}:lite" if lite else base


def _sales_orders_cache_keys() -> tuple[str, ...]:
    return (
        _sales_orders_cache_key("active"),
        _sales_orders_cache_key("active", lite=True),
        _sales_orders_cache_key("complete"),
    )


def _patch_cached_sales_orders(mutator) -> None:
    """Overlay planner edits onto the file cache Material Tracking actually reads."""
    from .erp_route_cache import update_data

    def apply(data) -> bool:
        if not isinstance(data, dict):
            return False
        changed = False
        for bucket in ("active", "complete"):
            for order in data.get(bucket) or []:
                for pp in order.get("pp_vouchers") or []:
                    if mutator(pp):
                        changed = True
        return changed

    for key in _sales_orders_cache_keys():
        update_data(key, apply)

    if _cache:
        for bucket in ("active", "complete"):
            for order in _cache[1].get(bucket, []):
                for pp in order.get("pp_vouchers") or []:
                    mutator(pp)


def _scoped_pp_sql(scope: str) -> tuple[str, str]:
    clause = ""
    if scope == "active":
        clause = _ACTIVE_PP_AND
    elif scope == "complete":
        clause = _COMPLETE_PP_AND
    return (
        _restrict_sql(STAGED_MFG_PP_VCH_SQL, clause),
        _restrict_sql(_MFG_PP_VCH_SQL, clause),
    )


def _erp_query_for_ids(
    staged_sql: str,
    live_sql: str,
    ids: list[str],
    *,
    staged_where: str,
    live_where: str,
    live: bool = True,
) -> list[dict[str, Any]]:
    if not ids:
        return []
    return _erp_query(
        _restrict_sql(staged_sql, staged_where),
        (ids,),
        live_sql=_restrict_sql(live_sql, live_where),
        live=live,
    )


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


def _parse_material_need_date(value: Any) -> str:
    text = parse_date_text(value)
    if len(text) < 10:
        return ""
    candidate = text[:10]
    try:
        date.fromisoformat(candidate)
    except ValueError:
        return ""
    return candidate


def _empty_notes() -> dict[str, Any]:
    out = {field: "" for field in _NOTE_FIELDS}
    out["ps_highlighted"] = False
    out["highlighted_partials"] = []
    out["material_delay"] = False
    out["material_need_date"] = ""
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
    out["material_delay"] = bool(row.get("material_delay"))
    out["material_need_date"] = _parse_material_need_date(row.get("material_need_date"))
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
            buyer               TEXT         NOT NULL DEFAULT '',
            ps_highlighted      BOOLEAN      NOT NULL DEFAULT FALSE,
            material_need_date  DATE,
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
    con.execute(
        """
        ALTER TABLE planner_so_pp_notes
        ADD COLUMN IF NOT EXISTS material_delay BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    con.execute(
        """
        ALTER TABLE planner_so_pp_notes
        ADD COLUMN IF NOT EXISTS material_need_date DATE
        """
    )
    con.execute(
        """
        ALTER TABLE planner_so_pp_notes
        ADD COLUMN IF NOT EXISTS buyer TEXT NOT NULL DEFAULT ''
        """
    )


def _ps_base_id(ps_id: str) -> str:
    return compact_text(ps_id).split("::")[0]


def _default_material_in_overlay() -> dict[str, Any]:
    return {"material_in": False, "material_in_date": None}


_PROCESS_SHEET_OVERLAY_LIVE_SQL = """
SELECT DISTINCT ON (pp_voucher_no)
    pp_voucher_no,
    process_sheet_no,
    inventory_code,
    sales_order_date
FROM public.mfg_process_sheet_info_v1_view
WHERE pp_voucher_no = ANY(%s)
ORDER BY pp_voucher_no, process_sheet_no
"""

_PROCESS_SHEET_OVERLAY_STAGED_SQL = """
SELECT DISTINCT ON (pp_voucher_no)
    pp_voucher_no,
    process_sheet_no,
    inventory_code,
    sales_order_date
FROM public.mfg_process_sheet_info
WHERE pp_voucher_no = ANY(%s)
ORDER BY pp_voucher_no, process_sheet_no
"""

_PART_DESC_LIVE_SQL = """
SELECT inventory_code, main_desc
FROM public.mt_inventory
WHERE inventory_code = ANY(%s)
"""

_PART_DESC_STAGED_SQL = """
SELECT inventory_code, main_desc
FROM public.part_desc
WHERE inventory_code = ANY(%s)
"""


def _overlay_query(
    staged_sql: str,
    live_sql: str,
    params: tuple,
    *,
    live: bool,
    label: str,
) -> list[dict[str, Any]]:
    try:
        if live:
            return live_query(live_sql, params, timeout_ms=_LIVE_OVERLAY_TIMEOUT_MS)
        return fetch_rows(staged_sql, params, live_sql=live_sql)
    except Exception as exc:
        logger.warning("%s overlay load skipped: %s", label, exc)
        return []


def _load_process_sheet_overlay(
    pp_voucher_nos: list[str],
    *,
    live: bool = True,
) -> dict[str, dict[str, Any]]:
    ids = [compact_text(v) for v in pp_voucher_nos if compact_text(v)]
    if not ids:
        return {}
    fetched = _overlay_query(
        _PROCESS_SHEET_OVERLAY_STAGED_SQL,
        _PROCESS_SHEET_OVERLAY_LIVE_SQL,
        (ids,),
        live=live,
        label="process sheet",
    )

    out: dict[str, dict[str, Any]] = {}
    for row in fetched:
        pp_no = compact_text(row.get("pp_voucher_no"))
        if not pp_no:
            continue
        out[pp_no] = {
            "process_sheet_no": compact_text(row.get("process_sheet_no")) or pp_no,
            "inventory_code": compact_text(row.get("inventory_code")),
            "sales_order_date": _serialize_value(row.get("sales_order_date")),
        }
    return out


def _load_part_desc_map(inventory_codes: list[str], *, live: bool = True) -> dict[str, str]:
    codes = [compact_text(v) for v in inventory_codes if compact_text(v)]
    if not codes:
        return {}
    fetched = _overlay_query(
        _PART_DESC_STAGED_SQL,
        _PART_DESC_LIVE_SQL,
        (codes,),
        live=live,
        label="part_desc",
    )

    out: dict[str, str] = {}
    for row in fetched:
        code = compact_text(row.get("inventory_code"))
        desc = compact_text(row.get("main_desc"))
        if code and desc:
            out[code] = desc
    return out


def _apply_process_sheet_overlay(
    orders: list[dict[str, Any]],
    overlay: dict[str, dict[str, Any]],
    desc_by_inv: dict[str, str],
) -> None:
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            pp_no = compact_text(pp.get("pp_voucher_no"))
            row = overlay.get(pp_no)
            if not row:
                continue
            ps_no = compact_text(row.get("process_sheet_no"))
            if ps_no:
                pp["process_sheet_no"] = ps_no
            so_date = row.get("sales_order_date")
            if so_date:
                pp["order_date"] = so_date
            inv = compact_text(row.get("inventory_code"))
            if not inv or inv == compact_text(pp.get("inventory_code")):
                continue
            pp["inventory_code"] = inv
            main_desc = desc_by_inv.get(inv)
            if not main_desc:
                continue
            current = compact_text(pp.get("description"))
            if not current or current == compact_text(pp.get("bom_desc")):
                pp["description"] = main_desc


def _material_subcon_arrived(raw: Any) -> bool:
    return compact_text(raw).upper() == "ARRIVED"


def _process_sheet_for_pp_voucher(con, pp_voucher_no: str) -> str:
    from .helpers import one

    pp_voucher_no = compact_text(pp_voucher_no)
    if not pp_voucher_no:
        return ""

    if _cache:
        for bucket in ("active", "complete"):
            for order in _cache[1].get(bucket, []):
                for pp in order.get("pp_vouchers") or []:
                    if compact_text(pp.get("pp_voucher_no")) == pp_voucher_no:
                        ps = compact_text(pp.get("process_sheet_no"))
                        if ps:
                            return ps

    try:
        fetched = live_query(
            """
            SELECT process_sheet_no
            FROM public.mfg_process_sheet_info_v1_view
            WHERE pp_voucher_no = %s
            ORDER BY process_sheet_no
            LIMIT 1
            """,
            (pp_voucher_no,),
        )
        if fetched and compact_text(fetched[0].get("process_sheet_no")):
            return compact_text(fetched[0].get("process_sheet_no"))
    except Exception as exc:
        logger.warning("live process sheet lookup for %s skipped: %s", pp_voucher_no, exc)

    row = one(
        con.execute(
            """
            SELECT process_sheet_no
            FROM mfg_process_sheet_info
            WHERE pp_voucher_no = %s
            ORDER BY process_sheet_no
            LIMIT 1
            """,
            (pp_voucher_no,),
        )
    )
    ps = compact_text(row.get("process_sheet_no")) if row else ""
    if ps:
        return ps

    return pp_voucher_no


def _sync_material_in_for_pp(con, pp_voucher_no: str, material_subcon_text: str) -> dict[str, Any] | None:
    try:
        ps_id = _process_sheet_for_pp_voucher(con, pp_voucher_no)
        if not ps_id:
            return None
        from .process_sheets import _update_material_in, material_in_date_from_subcon

        payload, err = _update_material_in(
            con,
            ps_id,
            _material_subcon_arrived(material_subcon_text),
            material_in_date=material_in_date_from_subcon(material_subcon_text) or None,
        )
        return payload if not err else None
    except Exception as exc:
        logger.warning("material_in sync for %s skipped: %s", pp_voucher_no, exc)
        return None


def patch_sales_orders_material_in(ps_id: str, payload: dict[str, Any]) -> None:
    """Keep sales-order cache aligned after planner material_in changes."""
    base = _ps_base_id(ps_id)
    if not base:
        return

    def mutator(pp: dict[str, Any]) -> bool:
        if _ps_base_id(pp.get("process_sheet_no") or "") != base:
            return False
        pp["material_in"] = bool(payload.get("material_in"))
        pp["material_in_date"] = payload.get("material_in_date")
        return True

    _patch_cached_sales_orders(mutator)


def _patch_sales_orders_pp_notes(pp_voucher_no: str, payload: dict[str, Any]) -> None:
    target = compact_text(pp_voucher_no)
    if not target:
        return
    target_key = target.upper()

    def mutator(pp: dict[str, Any]) -> bool:
        if compact_text(pp.get("pp_voucher_no")).upper() == target_key:
            pp.update(payload)
            return True
        if _ps_base_id(pp.get("process_sheet_no")).upper() == target_key:
            pp.update(payload)
            return True
        return False

    _patch_cached_sales_orders(mutator)


def _reconcile_subcon_material_in(orders: list[dict[str, Any]]) -> None:
    """Backfill planner material_in for rows already marked Arrived in S/O notes."""
    targets: list[tuple[str, dict[str, Any]]] = []
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            if not _material_subcon_arrived(pp.get("material_subcon")):
                continue
            if pp.get("material_in"):
                continue
            ps_id = compact_text(pp.get("process_sheet_no"))
            if ps_id:
                targets.append((ps_id, pp))
    if not targets:
        return
    try:
        from .process_sheets import _update_material_in

        with planner_db() as con:
            for ps_id, pp in targets:
                payload, err = _update_material_in(con, ps_id, True)
                if payload and not err:
                    pp["material_in"] = bool(payload.get("material_in"))
                    pp["material_in_date"] = payload.get("material_in_date")
    except Exception as exc:
        logger.warning("subcon material_in reconcile skipped: %s", exc)


def _load_material_in_overlay(process_sheet_nos: list[str]) -> dict[str, dict[str, Any]] | None:
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
        return None

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
            if _material_subcon_arrived(pp.get("material_subcon")):
                pp["material_in"] = True


def _load_coway_edd_overlay(process_sheet_nos: list[str]) -> dict[tuple[str, int], str]:
    """Planner proposed EDD from Supabase (coway_proposed_edd), keyed by PS base + partial."""
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
        from .process_sheets import _ensure_coway_proposed_edd_column

        with planner_db() as con:
            _ensure_coway_proposed_edd_column(con)
            fetched = rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id, pp_partial_no, coway_proposed_edd
                    FROM planner_process_sheet
                    WHERE coway_proposed_edd IS NOT NULL
                      AND (
                        planner_ps_id = ANY(%s)
                        OR source_ps_id = ANY(%s)
                        OR split_part(planner_ps_id, '::', 1) = ANY(%s)
                      )
                    """,
                    (bases, bases, bases),
                )
            )
    except Exception as exc:
        logger.warning("coway_proposed_edd overlay load skipped: %s", exc)
        return {}

    out: dict[tuple[str, int], str] = {}
    for row in fetched:
        edd = _serialize_value(row.get("coway_proposed_edd"))
        if not edd:
            continue
        try:
            partial_no = max(1, int(row.get("pp_partial_no") or 1))
        except (TypeError, ValueError):
            partial_no = 1
        for key in (
            compact_text(row.get("source_ps_id")),
            compact_text(row.get("planner_ps_id")),
        ):
            base = _ps_base_id(key)
            if base:
                out[(base, partial_no)] = str(edd)
    return out


def _apply_coway_edd_overlay(
    orders: list[dict[str, Any]],
    overlay: dict[tuple[str, int], str],
) -> None:
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            base = _pp_ps_base(pp)
            partial_rows = pp.get("partials") or []
            if not partial_rows:
                pp["coway_proposed_edd"] = overlay.get((base, 1), "")
                continue
            for partial in partial_rows:
                try:
                    partial_no = max(1, int(partial.get("pp_partial_no") or 1))
                except (TypeError, ValueError):
                    partial_no = 1
                partial["coway_proposed_edd"] = overlay.get((base, partial_no), "")


def _program_finish_iso(value: Any) -> str:
    text = compact_text(_serialize_value(value))
    if not text:
        return ""
    head = text.replace(" ", "T")[:10]
    if len(head) == 10 and head[4] == "-" and head[7] == "-":
        return head
    return ""


def _load_program_finish_overlay(process_sheet_nos: list[str]) -> dict[str, str] | None:
    """Programme finish dates from NPI/FA New parts, keyed by uppercase PS base."""
    bases: list[str] = []
    seen: set[str] = set()
    for raw in process_sheet_nos:
        base = _ps_base_id(raw)
        if not base:
            continue
        key = base.upper()
        if key in seen:
            continue
        seen.add(key)
        bases.append(key)
    if not bases:
        return {}

    try:
        with planner_db() as con:
            fetched = rows(
                con.execute(
                    """
                    SELECT process_sheet_no, program_finish_at
                    FROM planner_first_article_new_part
                    WHERE TRIM(COALESCE(program_finish_at, '')) <> ''
                      AND UPPER(TRIM(split_part(process_sheet_no, '::', 1))) = ANY(%s)
                    """,
                    (bases,),
                )
            )
    except Exception as exc:
        logger.warning("program_finish overlay load skipped: %s", exc)
        return None

    out: dict[str, str] = {}
    for row in fetched:
        base = _ps_base_id(row.get("process_sheet_no") or "")
        finish = _program_finish_iso(row.get("program_finish_at"))
        if base and finish:
            out[base.upper()] = finish
    return out


def _apply_program_finish_overlay(
    orders: list[dict[str, Any]],
    overlay: dict[str, str],
) -> None:
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            base = _pp_ps_base(pp)
            pp["program_finish_at"] = overlay.get(base.upper(), "") if base else ""


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


_STAGE_OVERLAY_LIVE_SQL = """
WITH pp_partials AS (
    SELECT DISTINCT ON (pp_voucher_no, partial_qty)
        pp_voucher_no,
        partial_qty,
        pp_partial_no
    FROM public.mfg_pp_partial
    WHERE pp_voucher_no IS NOT NULL
    ORDER BY pp_voucher_no, partial_qty, pp_partial_no
),
wo AS (
    SELECT
        t2.source_pp_no AS ps_base,
        COALESCE(
            NULLIF(t2.source_pp_partial_no, 0),
            pp.pp_partial_no,
            1
        ) AS pp_partial_no,
        t3.execution_status,
        NULLIF(t2.stage_no::TEXT, '')::INTEGER AS stage_no,
        TRIM(COALESCE(t3.stage_desc, '')) AS stage_desc,
        t3.wo_qty_required,
        t3.total_acc_qty_produced
    FROM mfg_mps_vch t2
    JOIN mfg_wo_vch t3
      ON t2.wo_voucher_no = t3.voucher_no
     AND t2.stage_no = t3.stage_no
    LEFT JOIN pp_partials pp
      ON pp.pp_voucher_no = t2.source_pp_no
     AND pp.partial_qty = t3.wo_qty_required
     AND COALESCE(t2.source_pp_partial_no, 0) = 0
    WHERE t2.source_pp_no = ANY(%s)
      AND t2.stage_no IS NOT NULL
),
-- Per stage_no: PP + rework rows share one bucket (e.g. 49/50 + RW 1 → 50).
stage_done AS (
    SELECT
        ps_base,
        pp_partial_no,
        stage_no,
        BOOL_AND(
            UPPER(COALESCE(execution_status, '')) IN ('C', 'COMPLETED')
        ) AS all_status_complete,
        SUM(COALESCE(total_acc_qty_produced, 0)) AS produced_sum,
        MAX(COALESCE(wo_qty_required, 0)) AS required_max
    FROM wo
    GROUP BY ps_base, pp_partial_no, stage_no
),
agg AS (
    SELECT
        w.ps_base,
        w.pp_partial_no,
        COUNT(*)::int AS erp_wo_stage_count,
        COALESCE(
            (
                SELECT BOOL_AND(
                    sd.all_status_complete
                    AND (
                        sd.required_max <= 0.0001
                        OR sd.produced_sum >= sd.required_max - 0.0001
                    )
                )
                FROM stage_done sd
                WHERE sd.ps_base = w.ps_base
                  AND sd.pp_partial_no = w.pp_partial_no
            ),
            FALSE
        ) AS erp_all_wo_complete
    FROM wo w
    GROUP BY w.ps_base, w.pp_partial_no
),
open_stage AS (
    SELECT DISTINCT ON (ps_base, pp_partial_no)
        ps_base,
        pp_partial_no,
        stage_no AS current_stage_no,
        stage_desc AS current_stage_desc,
        execution_status AS current_stage_status
    FROM wo
    WHERE UPPER(COALESCE(execution_status, '')) NOT IN ('C', 'COMPLETED')
    ORDER BY
        ps_base,
        pp_partial_no,
        CASE execution_status
            WHEN 'I' THEN 0
            WHEN 'R' THEN 1
            WHEN 'P' THEN 2
            ELSE 3
        END,
        COALESCE(total_acc_qty_produced, 0) DESC,
        stage_no ASC
),
last_stage AS (
    SELECT DISTINCT ON (ps_base, pp_partial_no)
        ps_base,
        pp_partial_no,
        stage_no AS erp_last_stage_no,
        stage_desc AS erp_last_stage_desc,
        execution_status AS erp_last_stage_status
    FROM wo
    ORDER BY ps_base, pp_partial_no, stage_no DESC, stage_desc DESC
)
SELECT
    a.ps_base,
    a.pp_partial_no,
    a.erp_wo_stage_count,
    a.erp_all_wo_complete,
    o.current_stage_no,
    o.current_stage_desc,
    o.current_stage_status,
    l.erp_last_stage_no,
    l.erp_last_stage_desc,
    l.erp_last_stage_status,
    CASE
        WHEN o.current_stage_no IS NOT NULL THEN 'open'
        WHEN a.erp_all_wo_complete THEN 'completed'
        -- WO history exists and ERP closed every stage (qty quirks / rework split)
        -- → never treat as "No WO".
        WHEN a.erp_wo_stage_count > 0 THEN 'completed'
        ELSE 'unassigned'
    END AS erp_stage_mode
FROM agg a
LEFT JOIN open_stage o
       ON o.ps_base = a.ps_base AND o.pp_partial_no = a.pp_partial_no
LEFT JOIN last_stage l
       ON l.ps_base = a.ps_base AND l.pp_partial_no = a.pp_partial_no
"""

_STAGE_OVERLAY_STAGED_SQL = """
WITH wo AS (
    SELECT
        source_mps_no AS ps_base,
        COALESCE(NULLIF(pp_partial_no, 0), 1) AS pp_partial_no,
        execution_status,
        stage_no,
        TRIM(COALESCE(stage_desc, '')) AS stage_desc,
        wo_qty_required,
        total_acc_qty_produced
    FROM public.mfg_wo_status
    WHERE source_mps_no = ANY(%s)
      AND stage_no IS NOT NULL
),
stage_done AS (
    SELECT
        ps_base,
        pp_partial_no,
        stage_no,
        BOOL_AND(
            UPPER(COALESCE(execution_status, '')) IN ('C', 'COMPLETED')
        ) AS all_status_complete,
        SUM(COALESCE(total_acc_qty_produced, 0)) AS produced_sum,
        MAX(COALESCE(wo_qty_required, 0)) AS required_max
    FROM wo
    GROUP BY ps_base, pp_partial_no, stage_no
),
agg AS (
    SELECT
        w.ps_base,
        w.pp_partial_no,
        COUNT(*)::int AS erp_wo_stage_count,
        COALESCE(
            (
                SELECT BOOL_AND(
                    sd.all_status_complete
                    AND (
                        sd.required_max <= 0.0001
                        OR sd.produced_sum >= sd.required_max - 0.0001
                    )
                )
                FROM stage_done sd
                WHERE sd.ps_base = w.ps_base
                  AND sd.pp_partial_no = w.pp_partial_no
            ),
            FALSE
        ) AS erp_all_wo_complete
    FROM wo w
    GROUP BY w.ps_base, w.pp_partial_no
),
open_stage AS (
    SELECT DISTINCT ON (ps_base, pp_partial_no)
        ps_base,
        pp_partial_no,
        stage_no AS current_stage_no,
        stage_desc AS current_stage_desc,
        execution_status AS current_stage_status
    FROM wo
    WHERE UPPER(COALESCE(execution_status, '')) NOT IN ('C', 'COMPLETED')
    ORDER BY
        ps_base,
        pp_partial_no,
        CASE execution_status
            WHEN 'I' THEN 0
            WHEN 'R' THEN 1
            WHEN 'P' THEN 2
            ELSE 3
        END,
        COALESCE(total_acc_qty_produced, 0) DESC,
        stage_no ASC
),
last_stage AS (
    SELECT DISTINCT ON (ps_base, pp_partial_no)
        ps_base,
        pp_partial_no,
        stage_no AS erp_last_stage_no,
        stage_desc AS erp_last_stage_desc,
        execution_status AS erp_last_stage_status
    FROM wo
    ORDER BY ps_base, pp_partial_no, stage_no DESC, stage_desc DESC
)
SELECT
    a.ps_base,
    a.pp_partial_no,
    a.erp_wo_stage_count,
    a.erp_all_wo_complete,
    o.current_stage_no,
    o.current_stage_desc,
    o.current_stage_status,
    l.erp_last_stage_no,
    l.erp_last_stage_desc,
    l.erp_last_stage_status,
    CASE
        WHEN o.current_stage_no IS NOT NULL THEN 'open'
        WHEN a.erp_all_wo_complete THEN 'completed'
        WHEN a.erp_wo_stage_count > 0 THEN 'completed'
        ELSE 'unassigned'
    END AS erp_stage_mode
FROM agg a
LEFT JOIN open_stage o
       ON o.ps_base = a.ps_base AND o.pp_partial_no = a.pp_partial_no
LEFT JOIN last_stage l
       ON l.ps_base = a.ps_base AND l.pp_partial_no = a.pp_partial_no
"""


def _default_stage_overlay() -> dict[str, Any]:
    return {
        "current_stage_no": None,
        "current_stage_desc": "",
        "current_stage_status": "",
        "erp_stage_mode": "unassigned",
        "erp_wo_stage_count": 0,
        "erp_all_wo_complete": False,
        "erp_last_stage_no": None,
        "erp_last_stage_desc": "",
        "erp_last_stage_status": "",
    }


def _stage_overlay_from_row(row: dict[str, Any]) -> dict[str, Any]:
    stage_desc = compact_text(row.get("current_stage_desc"))
    stage_status = compact_text(row.get("current_stage_status"))
    stage_no = row.get("current_stage_no")
    last_no = row.get("erp_last_stage_no")
    wo_count = int(row.get("erp_wo_stage_count") or 0)
    mode = compact_text(row.get("erp_stage_mode")) or "unassigned"
    if stage_desc or stage_status:
        mode = "open"
    elif wo_count <= 0:
        mode = "unassigned"
    elif mode == "unassigned":
        # Closed WO history with qty/rework edge cases must not show as No WO.
        mode = "completed"
    all_complete = bool(row.get("erp_all_wo_complete")) or mode == "completed"
    return {
        "current_stage_no": int(stage_no) if stage_no is not None else None,
        "current_stage_desc": stage_desc,
        "current_stage_status": stage_status,
        "erp_stage_mode": mode,
        "erp_wo_stage_count": wo_count,
        "erp_all_wo_complete": all_complete,
        "erp_last_stage_no": int(last_no) if last_no is not None else None,
        "erp_last_stage_desc": compact_text(row.get("erp_last_stage_desc")),
        "erp_last_stage_status": compact_text(row.get("erp_last_stage_status")),
    }


def _load_stage_overlay(
    process_sheet_nos: list[str],
    *,
    live: bool = True,
) -> dict[tuple[str, int], dict[str, Any]]:
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

    fetched = _overlay_query(
        _STAGE_OVERLAY_STAGED_SQL,
        _STAGE_OVERLAY_LIVE_SQL,
        (bases,),
        live=live,
        label="stage",
    )

    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in fetched:
        ps_base = compact_text(row.get("ps_base"))
        if not ps_base:
            continue
        try:
            partial_no = max(1, int(row.get("pp_partial_no") or 1))
        except (TypeError, ValueError):
            partial_no = 1
        out[(ps_base, partial_no)] = _stage_overlay_from_row(row)
    return out


_WO_QTY_OVERLAY_LIVE_SQL = """
WITH partials AS (
    SELECT pp_voucher_no, pp_partial_no, partial_qty
    FROM public.mfg_pp_partial
    WHERE pp_voucher_no = ANY(%s)
),
wo_partials AS (
    SELECT DISTINCT
        t2.source_pp_no AS pp_voucher_no,
        COALESCE(
            NULLIF(t2.source_pp_partial_no, 0),
            pp.pp_partial_no,
            1
        ) AS pp_partial_no
    FROM public.mfg_mps_vch t2
    JOIN public.mfg_wo_vch t3 ON t2.wo_voucher_no = t3.voucher_no
    LEFT JOIN public.mfg_pp_partial pp
           ON pp.pp_voucher_no = t2.source_pp_no
          AND pp.partial_qty = t3.wo_qty_required
          AND COALESCE(t2.source_pp_partial_no, 0) = 0
    WHERE t2.source_pp_no = ANY(%s)
),
issued AS (
    SELECT
        p.pp_voucher_no,
        COALESCE(SUM(p.partial_qty), 0) AS wo_issued_qty
    FROM partials p
    JOIN wo_partials w
      ON w.pp_voucher_no = p.pp_voucher_no
     AND w.pp_partial_no = p.pp_partial_no
    GROUP BY p.pp_voucher_no
),
has_wo AS (
    SELECT DISTINCT m.source_pp_no AS pp_voucher_no
    FROM public.mfg_mps_vch m
    JOIN public.mfg_wo_vch w ON w.voucher_no = m.wo_voucher_no
    WHERE m.source_pp_no = ANY(%s)
)
SELECT
    v.pp_voucher_no,
    (h.pp_voucher_no IS NOT NULL) AS erp_has_wo,
    COALESCE(i.wo_issued_qty, 0) AS erp_wo_issued_qty,
    v.pp_qty
FROM public.mfg_pp_vch v
LEFT JOIN issued i ON i.pp_voucher_no = v.pp_voucher_no
LEFT JOIN has_wo h ON h.pp_voucher_no = v.pp_voucher_no
WHERE v.pp_voucher_no = ANY(%s)
"""

_WO_QTY_OVERLAY_STAGED_SQL = """
WITH partials AS (
    SELECT pp_voucher_no, pp_partial_no, partial_qty
    FROM public.pp_partial_detail
    WHERE pp_voucher_no = ANY(%s)
),
wo_partials AS (
    SELECT DISTINCT
        source_mps_no AS pp_voucher_no,
        COALESCE(NULLIF(pp_partial_no, 0), 1) AS pp_partial_no
    FROM public.mfg_wo_status
    WHERE source_mps_no = ANY(%s)
),
issued AS (
    SELECT
        p.pp_voucher_no,
        COALESCE(SUM(p.partial_qty), 0) AS wo_issued_qty
    FROM partials p
    JOIN wo_partials w
      ON w.pp_voucher_no = p.pp_voucher_no
     AND w.pp_partial_no = p.pp_partial_no
    GROUP BY p.pp_voucher_no
),
has_wo AS (
    SELECT DISTINCT source_mps_no AS pp_voucher_no
    FROM public.mfg_wo_status
    WHERE source_mps_no = ANY(%s)
)
SELECT
    v.pp_voucher_no,
    (h.pp_voucher_no IS NOT NULL) AS erp_has_wo,
    COALESCE(i.wo_issued_qty, 0) AS erp_wo_issued_qty,
    v.pp_qty
FROM public.pp_voucher_hdr v
LEFT JOIN issued i ON i.pp_voucher_no = v.pp_voucher_no
LEFT JOIN has_wo h ON h.pp_voucher_no = v.pp_voucher_no
WHERE v.pp_voucher_no = ANY(%s)
"""


def _load_wo_qty_overlay(
    pp_voucher_nos: list[str],
    *,
    live: bool = True,
) -> dict[str, dict[str, Any]]:
    """Per PP: WO issued qty (partial batches with vouchers) and remaining PP qty awaiting WO."""
    ids = [compact_text(v) for v in pp_voucher_nos if compact_text(v)]
    if not ids:
        return {}
    fetched = _overlay_query(
        _WO_QTY_OVERLAY_STAGED_SQL,
        _WO_QTY_OVERLAY_LIVE_SQL,
        (ids, ids, ids, ids),
        live=live,
        label="wo qty",
    )

    out: dict[str, dict[str, Any]] = {}
    for row in fetched:
        pp_no = compact_text(row.get("pp_voucher_no"))
        if not pp_no:
            continue
        pp_qty = float(row.get("pp_qty") or 0)
        issued = float(row.get("erp_wo_issued_qty") or 0)
        pending = max(0.0, pp_qty - issued)
        out[pp_no] = {
            "erp_has_wo": bool(row.get("erp_has_wo")),
            "erp_wo_issued_qty": issued,
            "erp_pending_wo_qty": pending,
        }
    return out


def _apply_wo_qty_overlay(
    orders: list[dict[str, Any]],
    overlay: dict[str, dict[str, Any]],
) -> None:
    """SO-linked PP with PP qty not yet fully issued as WO vouchers (partial batches)."""
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            pp_no = compact_text(pp.get("pp_voucher_no"))
            so_no = compact_text(pp.get("source_voucher_no"))
            if pp.get("shipped_completed"):
                pp_qty = float(pp.get("pp_qty") or 0)
                pp["erp_has_wo"] = True
                pp["erp_wo_issued_qty"] = pp_qty
                pp["erp_pending_wo_qty"] = 0.0
                pp["erp_pending_no_wo"] = False
                continue
            data = overlay.get(pp_no, {})
            has_wo = bool(data.get("erp_has_wo"))
            issued = float(data.get("erp_wo_issued_qty") or 0)
            pending = float(data.get("erp_pending_wo_qty") or 0)
            if not data and pp_no:
                pp_qty = float(pp.get("pp_qty") or 0)
                pending = pp_qty
                has_wo = False
                issued = 0.0
            pp["erp_has_wo"] = has_wo
            pp["erp_wo_issued_qty"] = issued
            pp["erp_pending_wo_qty"] = pending
            pp["erp_pending_no_wo"] = so_no.startswith("SO/") and pending > 0.0001


def _apply_stage_overlay(
    orders: list[dict[str, Any]],
    overlay: dict[tuple[str, int], dict[str, Any]],
) -> None:
    default = _default_stage_overlay()
    shipped_default = {
        **default,
        "erp_stage_mode": "completed",
        "erp_all_wo_complete": True,
    }
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            base = _pp_ps_base(pp)
            fallback = shipped_default if pp.get("shipped_completed") else default
            partial_rows = pp.get("partials") or []
            if not partial_rows:
                pp.update(overlay.get((base, 1), fallback))
                continue
            for partial in partial_rows:
                try:
                    partial_no = max(1, int(partial.get("pp_partial_no") or 1))
                except (TypeError, ValueError):
                    partial_no = 1
                partial.update(overlay.get((base, partial_no), fallback))


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


def _jobs_by_ps_from_orders(orders: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            part = compact_text(pp.get("inventory_code"))
            if not part:
                for partial in pp.get("partials") or []:
                    part = compact_text(partial.get("inventory_code"))
                    if part:
                        break
            jobs.append(
                {
                    "process_sheet_no": compact_text(pp.get("process_sheet_no") or pp.get("pp_voucher_no")),
                    "pp_voucher_no": compact_text(pp.get("pp_voucher_no")),
                    "part_no": part,
                    "inventory_code": part,
                    "queued_machines": list(pp.get("queued_machines") or []),
                    "machine_cnc": compact_text(pp.get("machine_cnc")),
                }
            )
    from .first_article_service import index_jobs_by_ps

    return index_jobs_by_ps(jobs)


def _apply_proposed_cnc_overlay(orders: list[dict[str, Any]]) -> None:
    """Copy NPI/FA Machine (CNC) onto S/O rows that share the same part number."""
    from .first_article_service import _part_key, load_proposed_cnc_by_part

    try:
        by_part = load_proposed_cnc_by_part(live_by_ps=_jobs_by_ps_from_orders(orders))
    except Exception as exc:
        logger.warning("proposed CNC overlay skipped: %s", exc)
        return
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            pp_part = compact_text(pp.get("inventory_code"))
            pp["proposed_cnc"] = list(by_part.get(_part_key(pp_part), []))
            for partial in pp.get("partials") or []:
                part = compact_text(partial.get("inventory_code")) or pp_part
                partial["proposed_cnc"] = list(by_part.get(_part_key(part), []))


def _apply_new_part_overlay(orders: list[dict[str, Any]]) -> None:
    """Flag PP lines with no prior process-sheet history on other sales orders."""
    from .new_orders_route import _fetch_repeat_groups_by_part, _ps_base_id, _similar_ps_for_row

    try:
        groups = _fetch_repeat_groups_by_part()
    except Exception as exc:
        logger.warning("new-part overlay skipped: %s", exc)
        return

    so_ps: dict[str, set[str]] = {}
    for order in orders:
        so_no = compact_text(order.get("sales_order_no"))
        if not so_no:
            continue
        bases = so_ps.setdefault(so_no, set())
        for pp in order.get("pp_vouchers") or []:
            ps_base = _ps_base_id(pp.get("process_sheet_no") or pp.get("pp_voucher_no") or "")
            if ps_base:
                bases.add(ps_base)

    for order in orders:
        so_no = compact_text(order.get("sales_order_no"))
        exclude = so_ps.get(so_no)
        for pp in order.get("pp_vouchers") or []:
            row = {
                "source_voucher_no": so_no,
                "inventory_code": pp.get("inventory_code"),
                "process_sheet_no": pp.get("process_sheet_no") or pp.get("pp_voucher_no"),
            }
            similar = _similar_ps_for_row(row, groups, exclude_ps=exclude) if groups else []
            pp["is_new_part"] = not similar
            pp["similar_ps_count"] = len(similar)
            # Full similar_ps lists balloon the S/O payload (~18MB). Keep a short
            # preview for active lines; omit lists on shipped/complete lines.
            if pp.get("shipped_completed"):
                pp["similar_ps"] = []
            else:
                pp["similar_ps"] = similar[:_SIMILAR_PS_PREVIEW]


def _strip_completed_highlights(orders: list[dict[str, Any]]) -> list[str]:
    to_clear: list[str] = []
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            if not pp.get("shipped_completed"):
                continue
            cleared = False
            if pp.get("highlighted_partials"):
                pp["highlighted_partials"] = []
                pp["ps_highlighted"] = False
                cleared = True
            if pp.get("material_delay"):
                pp["material_delay"] = False
                cleared = True
            if cleared:
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
                    material_delay = FALSE,
                    updated_at = NOW()
                WHERE pp_voucher_no = ANY(%s)
                  AND (
                    ps_highlighted = TRUE
                    OR highlighted_partials <> ''
                    OR material_delay = TRUE
                  )
                """,
                (ids,),
            )
    except Exception as exc:
        logger.warning("ps_highlighted batch clear skipped: %s", exc)


def _load_notes_map(pp_voucher_nos: list[str]) -> dict[str, dict[str, str]] | None:
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
                           quality_doc, ops_notes, sales_notes, buyer, ps_highlighted,
                           highlighted_partials, material_delay, material_need_date
                    FROM planner_so_pp_notes
                    WHERE pp_voucher_no = ANY(%s)
                    """,
                    (ids,),
                )
            )
    except Exception as exc:
        logger.warning("planner_so_pp_notes load skipped: %s", exc)
        return None

    out: dict[str, dict[str, str]] = {}
    for row in fetched:
        key = compact_text(row.get("pp_voucher_no"))
        if not key:
            continue
        parsed = _notes_from_row(row)
        out[key] = parsed
        upper = key.upper()
        if upper not in out:
            out[upper] = parsed
    return out


def _notes_for_pp(pp: dict[str, Any], notes_map: dict[str, dict[str, str]], default: dict[str, Any]) -> dict[str, Any]:
    """Resolve planner notes. Child COMP sheets share Assembly Parts Tracker keys."""
    pp_no = compact_text(pp.get("pp_voucher_no"))
    ps_no = _ps_base_id(pp.get("process_sheet_no"))
    if is_component_child_ps(ps_no):
        child_notes = notes_map.get(ps_no) or notes_map.get(ps_no.upper())
        if child_notes:
            return child_notes
    for key in (pp_no, ps_no):
        if not key:
            continue
        found = notes_map.get(key) or notes_map.get(key.upper())
        if found:
            return found
    return default


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
        pp.update(_notes_for_pp(pp, notes_map, _empty_notes()))

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


def invalidate_sales_orders_cache() -> None:
    global _cache
    _cache = None
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("sales_orders:")


def _build_sales_orders(*, scope: str, lite: bool = False) -> dict[str, Any]:
    started = time.perf_counter()
    lite = bool(lite)
    # Material Tracking (lite) reads planner staging so a cache miss does not wait on COMAIN.
    live = not lite
    staged_sql, live_sql = _scoped_pp_sql(scope)
    pp_rows = _erp_query(staged_sql, live_sql=live_sql, live=live)
    pp_nos = _unique_texts(row.get("pp_voucher_no") for row in pp_rows)
    so_nos = _unique_texts(row.get("source_voucher_no") for row in pp_rows)
    note_ids = _unique_texts(
        list(pp_nos) + [_ps_base_id(row.get("process_sheet_no")) for row in pp_rows]
    )
    notes_map = _load_notes_map(note_ids) or {}
    partials = _erp_query_for_ids(
        STAGED_MFG_PP_PARTIAL_SQL,
        _MFG_PP_PARTIAL_SQL,
        pp_nos,
        staged_where="WHERE pp_voucher_no = ANY(%s)",
        live_where="WHERE v.pp_voucher_no = ANY(%s)",
        live=live,
    )
    headers = _erp_query_for_ids(
        STAGED_SO_ORDER_HEADER_SQL,
        _SO_ORDER_HEADER_SQL,
        so_nos,
        staged_where="WHERE sales_order_no = ANY(%s)",
        live_where="WHERE sales_order_no = ANY(%s)",
        live=live,
    )
    posted_dates = _erp_query_for_ids(
        STAGED_SO_POSTED_DATES_SQL,
        _SO_POSTED_DATES_SQL,
        so_nos,
        staged_where="WHERE sales_order_no = ANY(%s)",
        live_where="WHERE h.sales_order_no = ANY(%s)",
        live=live,
    )
    orders = _build_orders_from_pp_vouchers(
        pp_rows,
        _partials_by_pp_voucher(partials),
        _headers_by_sales_order(headers),
        _posted_dates_by_sales_order(posted_dates),
        notes_map,
    )
    ps_overlay = _load_process_sheet_overlay(pp_nos, live=live)
    inv_codes = sorted(
        {
            compact_text(v.get("inventory_code"))
            for v in ps_overlay.values()
            if compact_text(v.get("inventory_code"))
        }
    )
    _apply_process_sheet_overlay(orders, ps_overlay, _load_part_desc_map(inv_codes, live=live))
    process_sheets = [
        pp.get("process_sheet_no")
        for order in orders
        for pp in (order.get("pp_vouchers") or [])
        if pp.get("process_sheet_no")
    ]
    material_in_overlay = _load_material_in_overlay(process_sheets)
    if material_in_overlay is not None:
        _apply_material_in_overlay(orders, material_in_overlay)
    _apply_coway_edd_overlay(orders, _load_coway_edd_overlay(process_sheets))
    program_finish_overlay = _load_program_finish_overlay(process_sheets)
    if program_finish_overlay is not None:
        _apply_program_finish_overlay(orders, program_finish_overlay)
    if scope != "complete":
        _reconcile_subcon_material_in(orders)
        _apply_stage_overlay(orders, _load_stage_overlay(process_sheets, live=live))
        _apply_wo_qty_overlay(orders, _load_wo_qty_overlay(pp_nos, live=live))
        # Material Tracking does not show queued machines or similar-PS history.
        if not lite:
            _apply_queued_machines_overlay(orders, _load_queued_machines_by_canonical_ps())
            _apply_new_part_overlay(orders)
    else:
        to_clear = _strip_completed_highlights(orders)
        if to_clear:
            _batch_clear_ps_highlights(to_clear)
    frame_agreement_keys: set[str] = set()
    try:
        with planner_db() as con:
            frame_agreement_keys = load_frame_agreement_part_keys(con)
        apply_frame_agreement_flags(orders, frame_agreement_keys)
    except Exception as exc:
        logger.warning("frame agreement overlay skipped: %s", exc)
    payload = _split_by_shipped_completion(orders)
    if scope == "active":
        payload["complete"] = []
    elif scope == "complete":
        payload["active"] = []
    payload["frame_agreement_parts"] = sorted(frame_agreement_keys)
    logger.info(
        "sales_orders built scope=%s lite=%s live=%s pp=%s in %.1fs",
        scope,
        lite,
        live,
        len(pp_rows),
        time.perf_counter() - started,
    )
    return payload


def _payload_orders(payload: dict[str, Any]) -> list[dict[str, Any]]:
    orders: list[dict[str, Any]] = []
    for bucket in ("active", "complete"):
        orders.extend(payload.get(bucket) or [])
    return orders


def _overlay_planner_edits(payload: dict[str, Any]) -> dict[str, Any]:
    """Re-apply planner notes / material-in / NPI Proposed CNC / programme finish.

    Material dates live in planner_so_pp_notes. NPI Machine (CNC) is keyed by
    part number. Programme finish is the NPI/FA New parts date. The ERP
    snapshot is cached, so without this overlay a reload shows empty Material
    in / Proposed CNC / Programme finish cells until rebuild.
    """
    if not isinstance(payload, dict):
        return payload
    orders = _payload_orders(payload)
    if not orders:
        return payload

    pps = [pp for order in orders for pp in (order.get("pp_vouchers") or [])]
    pp_nos = _unique_texts(pp.get("pp_voucher_no") for pp in pps)
    process_sheets = [pp.get("process_sheet_no") for pp in pps if pp.get("process_sheet_no")]
    note_ids = _unique_texts(
        list(pp_nos) + [_ps_base_id(ps) for ps in process_sheets]
    )

    notes_map = _load_notes_map(note_ids)
    if notes_map is not None:
        default = _empty_notes()
        for pp in pps:
            pp.update(_notes_for_pp(pp, notes_map, default))

    material_in_overlay = _load_material_in_overlay(process_sheets)
    if material_in_overlay is not None:
        _apply_material_in_overlay(orders, material_in_overlay)
    _apply_proposed_cnc_overlay(orders)
    program_finish_overlay = _load_program_finish_overlay(process_sheets)
    if program_finish_overlay is not None:
        _apply_program_finish_overlay(orders, program_finish_overlay)
    return payload


def _fetch_sales_orders(
    *,
    refresh: bool = False,
    active_only: bool = False,
    lite: bool = False,
) -> dict[str, Any]:
    from .erp_route_cache import cached_fetch, get as cache_get

    lite = bool(lite)
    if lite:
        active_only = True

    active = cached_fetch(
        _sales_orders_cache_key("active", lite=lite),
        lambda: _build_sales_orders(scope="active", lite=lite),
        ttl_sec=_CACHE_TTL_SEC,
        refresh=refresh,
    )
    payload = dict(active)
    payload["complete"] = []
    if active_only:
        if not refresh:
            complete_cached = cache_get(
                _sales_orders_cache_key("complete"),
                ttl_sec=_CACHE_TTL_SEC,
            )
            if complete_cached:
                payload["complete_job_count"] = _job_count(complete_cached.get("complete") or [])
        return _overlay_planner_edits(payload)

    complete = cached_fetch(
        _sales_orders_cache_key("complete"),
        lambda: _build_sales_orders(scope="complete"),
        ttl_sec=_CACHE_TTL_SEC,
        refresh=refresh,
    )
    payload["complete"] = complete.get("complete") or []
    payload["complete_job_count"] = _job_count(payload["complete"])
    if not payload.get("frame_agreement_parts"):
        payload["frame_agreement_parts"] = complete.get("frame_agreement_parts") or []
    return _overlay_planner_edits(payload)


def _upsert_notes(pp_voucher_no: str, patch: dict[str, Any]) -> dict[str, Any]:
    with planner_db() as con:
        _ensure_notes_table(con)
        existing = rows(
            con.execute(
                """
                SELECT pp_voucher_no, material_subcon, mtl_part_order,
                       quality_doc, ops_notes, sales_notes, buyer, ps_highlighted,
                       highlighted_partials, material_delay, material_need_date
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
        if "material_delay" in patch:
            current["material_delay"] = bool(patch.pop("material_delay"))
        if "material_need_date" in patch:
            current["material_need_date"] = _parse_material_need_date(patch.pop("material_need_date"))
        for key, value in patch.items():
            if key in _NOTE_FIELDS:
                current[key] = compact_text(value)
        # Material arrived resolves the purchaser delay flag.
        if "material_subcon" in patch and _material_subcon_arrived(current.get("material_subcon")):
            current["material_delay"] = False
        highlighted_text = _format_highlighted_partials(current.get("highlighted_partials") or [])
        con.execute(
            """
            INSERT INTO planner_so_pp_notes (
                pp_voucher_no, material_subcon, mtl_part_order,
                quality_doc, ops_notes, sales_notes, buyer, ps_highlighted,
                highlighted_partials, material_delay, material_need_date, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (pp_voucher_no) DO UPDATE SET
                material_subcon = EXCLUDED.material_subcon,
                mtl_part_order = EXCLUDED.mtl_part_order,
                quality_doc = EXCLUDED.quality_doc,
                ops_notes = EXCLUDED.ops_notes,
                sales_notes = EXCLUDED.sales_notes,
                buyer = EXCLUDED.buyer,
                ps_highlighted = EXCLUDED.ps_highlighted,
                highlighted_partials = EXCLUDED.highlighted_partials,
                material_delay = EXCLUDED.material_delay,
                material_need_date = EXCLUDED.material_need_date,
                updated_at = NOW()
            """,
            (
                pp_voucher_no,
                current["material_subcon"],
                current["mtl_part_order"],
                current["quality_doc"],
                current["ops_notes"],
                current["sales_notes"],
                current.get("buyer") or "",
                current["ps_highlighted"],
                highlighted_text,
                current["material_delay"],
                current["material_need_date"] or None,
            ),
        )
        current["highlighted_partials"] = _parse_highlighted_partials(highlighted_text)
        result = {"pp_voucher_no": pp_voucher_no, **current}
        if "material_subcon" in patch:
            sync_payload = _sync_material_in_for_pp(con, pp_voucher_no, current["material_subcon"])
            if sync_payload:
                result["material_in"] = bool(sync_payload.get("material_in"))
                result["material_in_date"] = sync_payload.get("material_in_date")
        return result


@sales_orders_bp.get("/sales-orders")
def sales_orders_page():
    return render_template("sales_orders.html", active="sales_orders")


@sales_orders_bp.get("/sales-orders/logistics")
def sales_orders_logistics_page():
    return render_template("sales_orders_logistics.html", active="sales_orders_logistics")


@sales_orders_bp.get("/api/sales-orders")
def api_sales_orders():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    active_only = compact_text(request.args.get("active_only")).lower() in {"1", "true", "yes"}
    lite = compact_text(request.args.get("lite")).lower() in {"1", "true", "yes"}

    try:
        data = _fetch_sales_orders(refresh=refresh, active_only=active_only, lite=lite)
    except Exception as exc:
        logger.exception("sales orders ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    active = data.get("active") or []
    complete = [] if active_only else (data.get("complete") or [])
    complete_count = len(data.get("complete") or [])
    cached_at = _cache[0] if _cache else time.time()
    active_jobs = _job_count(active)
    complete_jobs = data.get("complete_job_count")
    if complete_jobs is None:
        complete_jobs = _job_count(data.get("complete") or [])
    pp_count = active_jobs + complete_jobs
    # Material Tracking only needs active rows; keep counts from the full cache.
    partial_count = (
        sum(int(row.get("partial_count") or 0) for row in active)
        if active_only
        else sum(int(row.get("partial_count") or 0) for row in active + complete)
    )
    missing_header = sum(
        1 for row in (active if active_only else active + complete) if not row.get("has_header")
    )

    frame_agreement_parts = data.get("frame_agreement_parts") or []

    return jsonify(
        {
            "ok": True,
            "schema_version": _SCHEMA_VERSION,
            "source": "mfg_pp_vch",
            "active_count": len(active),
            "complete_count": complete_count,
            "active_job_count": active_jobs,
            "complete_job_count": complete_jobs,
            "pp_count": pp_count,
            "partial_count": partial_count,
            "missing_header_count": missing_header,
            "frame_agreement_count": len(frame_agreement_parts),
            "frame_agreement_parts": frame_agreement_parts,
            "count": len(active) + complete_count,
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "active_only": active_only,
            "lite": lite,
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

    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        data = {}
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
    if "material_delay" in data:
        patch["material_delay"] = bool(data.get("material_delay"))
    if "material_need_date" in data:
        raw_need_date = data.get("material_need_date")
        if raw_need_date in (None, ""):
            patch["material_need_date"] = ""
        else:
            parsed_need_date = _parse_material_need_date(raw_need_date)
            if not parsed_need_date:
                return jsonify({"error": "material_need_date must be YYYY-MM-DD"}), 400
            patch["material_need_date"] = parsed_need_date

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

    _patch_sales_orders_pp_notes(pp_voucher_no, payload)
    return jsonify({"ok": True, **payload})
