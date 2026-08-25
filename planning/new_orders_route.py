"""New posted sales orders — live ERP read with short-lived in-memory cache."""
from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg2.extras
from flask import Blueprint, jsonify, render_template, request

from .staged_erp import (
    STAGED_FIRST_POSTED_FOR_SOS_SQL,
    STAGED_NEW_ORDERS_LINES_SQL,
    STAGED_NEW_ORDERS_SHIPMENT_SQL,
    STAGED_RECENT_SO_ACTIVITY_SQL,
    STAGED_RECENT_SO_HDR_SQL,
    fetch_rows,
    live_query,
    serialize_row as _serialize_row,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

new_orders_bp = Blueprint("new_orders", __name__)

_CACHE_TTL_SEC = 300
_NOTIF_CACHE_TTL_SEC = 60
_ENRICH_LOOKUP_TTL_SEC = 60
_ROWS_SCHEMA_VERSION = 3
_NOTIF_SCHEMA_VERSION = 3
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_notif_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_queued_lookup_cache: tuple[float, set[str], dict[str, list[str]]] | None = None
_repeat_lookup_cache: tuple[float, dict[str, list[tuple[str, Any]]]] | None = None

_GENERIC_SO_LINE_DESC_RE = re.compile(
    r"^\s*(?:PR\s*NO|BATCH\s*#|SERIAL\s*#|SO\s*/\s*MO\s*NO)\b",
    re.IGNORECASE,
)

_RECENT_SO_HDR_SQL = """
SELECT sales_order_no, posted_datetime, customer_code, reference_no, created_datetime
FROM public.so_order_ost_hdr
WHERE sales_order_no LIKE 'SO/%%'
  AND posted_datetime::date >= %s
"""

_FIRST_POSTED_FOR_SOS_SQL = """
SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
FROM public.so_order_rev_hst_hdr
WHERE sales_order_no = ANY(%s)
GROUP BY sales_order_no
"""

_NEW_ORDERS_LINES_SQL = """
SELECT
    pp.source_voucher_no AS source_voucher_no,
    regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '') AS source_voucher_line_item_no,
    pp.pp_voucher_no AS process_sheet_no,
    COALESCE(ps_info.inventory_code, pp.inventory_code, det.inventory_code) AS inventory_code,
    COALESCE(
        NULLIF(TRIM(ps_info.inventory_main_desc), ''),
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(pp.bom_desc), '')
    ) AS part_desc,
    COALESCE(det.required_shipment_date, pp.source_rsd) AS po_due_date,
    COALESCE(det.qty, pp.pp_qty) AS qty,
    COALESCE(NULLIF(TRIM(part.customer_po_no), ''), NULLIF(TRIM(hdr.customer_po_no), '')) AS customer_po_no,
    NULL::text AS customer_po_line_item_no,
    pp.proposed_edd,
    pp.bom_code,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    det.line_item_description
FROM public.mfg_pp_vch pp
LEFT JOIN public.so_order_ost_det det
    ON det.sales_order_no = pp.source_voucher_no
    AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
        = regexp_replace(pp.source_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN public.so_order_view hdr
    ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN LATERAL (
    SELECT
        ps.inventory_code,
        ps.inventory_main_desc
    FROM public.mfg_process_sheet_info_v1_view ps
    WHERE ps.pp_voucher_no = pp.pp_voucher_no
    ORDER BY ps.process_sheet_no
    LIMIT 1
) ps_info ON TRUE
LEFT JOIN public.mt_inventory pd
    ON pd.inventory_code = COALESCE(ps_info.inventory_code, pp.inventory_code, det.inventory_code)
LEFT JOIN (
    SELECT pp_voucher_no, MAX(customer_po_no) AS customer_po_no
    FROM public.mfg_pp_partial_view
    GROUP BY pp_voucher_no
) part ON part.pp_voucher_no = pp.pp_voucher_no
WHERE pp.source_voucher_no = ANY(%s)
ORDER BY pp.source_voucher_no, source_voucher_line_item_no, pp.pp_voucher_no
"""

_NEW_ORDERS_SHIPMENT_SQL = """
SELECT
    d.source_voucher_no,
    regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '') AS source_voucher_line_item_no,
    d.status,
    d.qty_issued,
    d.invoice_no,
    d.invoice_line_item_no,
    d.shipment_voucher_no,
    d.unit_selling_price,
    h.arrival_date,
    h.exch_rate,
    h.do_no,
    h.do_generation_datetime,
    (d.unit_selling_price * d.qty_issued * h.exch_rate) AS total_home_amt
FROM public.lg_out_shm_detail d
LEFT JOIN public.lg_out_shm_hst_hdr h
    ON d.shipment_voucher_no = h.shipment_voucher_no
WHERE d.source_voucher_no = ANY(%s)
  AND NOT (d.status = 'History' AND COALESCE(d.qty_issued, 0) = 0)
"""


def working_week_range(for_date: date | None = None, offset_weeks: int = 0) -> tuple[date, date]:
    """Mon–Sat working week (matches planner calendar)."""
    anchor = for_date or date.today()
    monday = anchor - timedelta(days=anchor.weekday()) + timedelta(weeks=offset_weeks)
    saturday = monday + timedelta(days=5)
    return monday, saturday


def _erp_query(sql: str, params: tuple, *, live_sql: str | None = None) -> list[dict[str, Any]]:
    return fetch_rows(sql, params, live_sql=live_sql or sql, domain="new_orders")


def _is_generic_so_line_description(raw: Any) -> bool:
    text = compact_text(raw)
    if not text:
        return True
    first_line = text.splitlines()[0].strip()
    return bool(_GENERIC_SO_LINE_DESC_RE.match(first_line))


def _load_part_desc_map(inventory_codes: list[str]) -> dict[str, str]:
    codes = [compact_text(code) for code in inventory_codes if compact_text(code)]
    if not codes:
        return {}
    try:
        fetched = live_query(
            """
            SELECT
                inventory_code,
                COALESCE(
                    NULLIF(TRIM(main_desc), ''),
                    NULLIF(TRIM(short_desc), '')
                ) AS part_desc
            FROM public.mt_inventory
            WHERE inventory_code = ANY(%s)
            """,
            (codes,),
        )
    except Exception as exc:
        logger.warning("new orders part_desc overlay skipped: %s", exc)
        return {}

    out: dict[str, str] = {}
    for row in fetched:
        code = compact_text(row.get("inventory_code"))
        desc = compact_text(row.get("part_desc"))
        if code and desc and not _is_generic_so_line_description(desc):
            out[code] = desc
    return out


def _resolve_part_description(
    row: dict[str, Any],
    desc_by_inv: dict[str, str],
) -> str:
    inv = compact_text(row.get("inventory_code"))
    candidates = [
        desc_by_inv.get(inv),
        row.get("part_desc"),
        row.get("main_desc"),
        row.get("bom_desc"),
    ]
    for raw in candidates:
        desc = compact_text(raw)
        if desc and not _is_generic_so_line_description(desc):
            return desc
    return ""


def _apply_part_descriptions(rows: list[dict[str, Any]]) -> None:
    inv_codes = [compact_text(row.get("inventory_code")) for row in rows]
    desc_by_inv = _load_part_desc_map(inv_codes)
    for row in rows:
        part_desc = _resolve_part_description(row, desc_by_inv)
        row["part_desc"] = part_desc
        row["main_desc"] = part_desc


def _cache_key(from_d: date, to_d: date, *, include_reposts: bool = False) -> str:
    suffix = ":reposts" if include_reposts else ""
    return f"v{_ROWS_SCHEMA_VERSION}:{from_d.isoformat()}:{to_d.isoformat()}{suffix}"


def _ps_base_id(ps_id: str) -> str:
    return compact_text(ps_id).split("::")[0]


_REPEAT_LOOKUP_LIVE_SQL = """
SELECT
    TRIM(COALESCE(ps.inventory_code, pp.inventory_code)) AS part_no,
    TRIM(COALESCE(pp.bom_code, '')) AS bom_code,
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS ps_base,
    MIN(COALESCE(ps.sales_order_date, pp.source_rsd)) AS order_date
FROM public.mfg_pp_vch pp
LEFT JOIN public.mfg_process_sheet_info_v1_view ps
       ON ps.pp_voucher_no = pp.pp_voucher_no
WHERE COALESCE(NULLIF(TRIM(COALESCE(ps.inventory_code, pp.inventory_code)), ''), '') <> ''
GROUP BY
    TRIM(COALESCE(ps.inventory_code, pp.inventory_code)),
    TRIM(COALESCE(pp.bom_code, '')),
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no)
"""

# Active machine-lane blocks — same "in queue" signal as process sheets / scheduler.
_PLANNER_QUEUED_SQL = """
WITH op_ps AS (
    SELECT DISTINCT
        split_part(
            COALESCE(NULLIF(TRIM(o.source_ps_id), ''), NULLIF(TRIM(o.job_no), '')),
            '::',
            1
        ) AS ps_base
    FROM planner_operation o
    JOIN planner_run_block b ON b.operation_id = o.operation_id
    WHERE b.active = TRUE
      AND COALESCE(b.block_type, 'ORIGINAL') <> 'REWORK'
      AND COALESCE(NULLIF(TRIM(o.source_ps_id), ''), NULLIF(TRIM(o.job_no), '')) <> ''
)
SELECT
    q.ps_base,
    NULLIF(TRIM(MAX(ps.inventory_code)), '') AS part_no
FROM op_ps q
LEFT JOIN planner_process_sheet ps
       ON split_part(ps.planner_ps_id, '::', 1) = q.ps_base
       OR ps.source_ps_id = q.ps_base
       OR ps.planner_ps_id = q.ps_base
WHERE q.ps_base <> ''
GROUP BY q.ps_base
"""

_LIVE_PART_NO_BY_PS_SQL = """
SELECT
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS ps_id,
    COALESCE(ps.inventory_code, pp.inventory_code) AS part_no
FROM public.mfg_pp_vch pp
LEFT JOIN public.mfg_process_sheet_info_v1_view ps
       ON ps.pp_voucher_no = pp.pp_voucher_no
WHERE COALESCE(ps.process_sheet_no, pp.pp_voucher_no) = ANY(%s)
"""


def _fetch_repeat_groups_by_part() -> dict[str, list[tuple[str, Any]]]:
    global _repeat_lookup_cache
    now = time.time()
    cached = _repeat_lookup_cache
    if cached and now - cached[0] < _ENRICH_LOOKUP_TTL_SEC:
        return cached[1]

    groups: dict[str, list[tuple[str, Any]]] = {}
    for row in live_query(_REPEAT_LOOKUP_LIVE_SQL):
        part_no = compact_text(row.get("part_no"))
        ps_base = compact_text(row.get("ps_base"))
        if not part_no or not ps_base:
            continue
        groups.setdefault(part_no, []).append((ps_base, row.get("order_date")))
    _repeat_lookup_cache = (now, groups)
    return groups


def _fetch_planner_queued_by_part() -> tuple[set[str], dict[str, list[str]]]:
    """Return queued PS bases and part_no -> queued PS bases (active machine blocks)."""
    global _queued_lookup_cache
    now = time.time()
    cached = _queued_lookup_cache
    if cached and now - cached[0] < _ENRICH_LOOKUP_TTL_SEC:
        return cached[1], cached[2]

    from .helpers import planner_db, rows as db_rows

    queued_bases: set[str] = set()
    by_part: dict[str, list[str]] = {}
    planner_rows: list[dict[str, Any]] = []
    with planner_db() as con:
        planner_rows = db_rows(con.execute(_PLANNER_QUEUED_SQL))

    missing_ps: list[str] = []
    for row in planner_rows:
        ps_base = compact_text(row.get("ps_base"))
        part_no = compact_text(row.get("part_no"))
        if not ps_base:
            continue
        queued_bases.add(ps_base)
        if part_no:
            siblings = by_part.setdefault(part_no, [])
            if ps_base not in siblings:
                siblings.append(ps_base)
        else:
            missing_ps.append(ps_base)

    if missing_ps:
        part_by_ps: dict[str, str] = {}
        for row in live_query(_LIVE_PART_NO_BY_PS_SQL, (missing_ps,)):
            ps_id = compact_text(row.get("ps_id"))
            part_no = compact_text(row.get("part_no"))
            if ps_id and part_no:
                part_by_ps[ps_id] = part_no
        for ps_base in missing_ps:
            part_no = part_by_ps.get(ps_base)
            if not part_no:
                continue
            siblings = by_part.setdefault(part_no, [])
            if ps_base not in siblings:
                siblings.append(ps_base)

    _queued_lookup_cache = (now, queued_bases, by_part)
    return queued_bases, by_part


def _so_ps_map(rows: list[dict[str, Any]]) -> dict[str, set[str]]:
    by_so: dict[str, set[str]] = {}
    for row in rows:
        so_no = compact_text(row.get("source_voucher_no"))
        ps_base = _ps_base_id(row.get("process_sheet_no") or "")
        if not so_no or not ps_base:
            continue
        by_so.setdefault(so_no, set()).add(ps_base)
    return by_so


def _so_part_ps_map(rows: list[dict[str, Any]]) -> dict[str, dict[str, list[str]]]:
    """Sales order -> part_no -> distinct PS bases on that order."""
    out: dict[str, dict[str, list[str]]] = {}
    seen: dict[str, dict[str, set[str]]] = {}
    for row in rows:
        so_no = compact_text(row.get("source_voucher_no"))
        part_no = compact_text(row.get("inventory_code"))
        ps_base = _ps_base_id(row.get("process_sheet_no") or "")
        if not so_no or not part_no or not ps_base:
            continue
        part_seen = seen.setdefault(so_no, {}).setdefault(part_no, set())
        if ps_base in part_seen:
            continue
        part_seen.add(ps_base)
        out.setdefault(so_no, {}).setdefault(part_no, []).append(ps_base)
    return out


def _same_so_same_part_for_row(
    row: dict[str, Any],
    so_part_map: dict[str, dict[str, list[str]]],
) -> list[str]:
    so_no = compact_text(row.get("source_voucher_no"))
    part_no = compact_text(row.get("inventory_code"))
    ps_current = _ps_base_id(row.get("process_sheet_no") or "")
    if not so_no or not part_no:
        return []
    siblings = so_part_map.get(so_no, {}).get(part_no, [])
    return [ps for ps in siblings if ps and ps != ps_current]


def _queued_ps_for_row(
    row: dict[str, Any],
    *,
    queued_bases: set[str],
    queued_by_part: dict[str, list[str]],
    exclude_ps: set[str] | None = None,
) -> tuple[bool, list[str]]:
    ps_current = _ps_base_id(row.get("process_sheet_no") or "")
    skip = set(exclude_ps or set())
    if ps_current:
        skip.add(ps_current)
    in_queue = bool(ps_current and ps_current in queued_bases)
    part_no = compact_text(row.get("inventory_code"))
    queued_same_part: list[str] = []
    seen: set[str] = set()
    for ps_base in queued_by_part.get(part_no, []):
        if not ps_base or ps_base in skip or ps_base in seen:
            continue
        seen.add(ps_base)
        queued_same_part.append(ps_base)
    return in_queue, queued_same_part


def _similar_ps_for_row(
    row: dict[str, Any],
    groups: dict[str, list[tuple[str, Any]]],
    *,
    exclude_ps: set[str] | None = None,
) -> list[str]:
    part_no = compact_text(row.get("inventory_code"))
    if not part_no:
        return []
    ps_current = _ps_base_id(row.get("process_sheet_no") or "")
    skip = set(exclude_ps or set())
    if ps_current:
        skip.add(ps_current)
    siblings = groups.get(part_no, [])
    ranked = sorted(
        [(ps, order_date) for ps, order_date in siblings if ps and ps not in skip],
        key=lambda item: (item[1] is None, item[1]),
        reverse=True,
    )
    seen: set[str] = set()
    similar: list[str] = []
    for ps, _ in ranked:
        if ps in seen:
            continue
        seen.add(ps)
        similar.append(ps)
    return similar


def _enrich_new_orders_repeat_info(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        queued_bases, queued_by_part = _fetch_planner_queued_by_part()
    except Exception:
        logger.exception("planner queue lookup failed for new orders")
        queued_bases, queued_by_part = set(), {}

    try:
        groups = _fetch_repeat_groups_by_part()
    except Exception:
        logger.exception("repeat lookup failed for new orders")
        groups = {}

    so_ps = _so_ps_map(rows)
    so_part_map = _so_part_ps_map(rows)
    for row in rows:
        so_no = compact_text(row.get("source_voucher_no"))
        exclude = so_ps.get(so_no)
        similar = _similar_ps_for_row(row, groups, exclude_ps=exclude) if groups else []
        in_queue, queued_same_part = _queued_ps_for_row(
            row,
            queued_bases=queued_bases,
            queued_by_part=queued_by_part,
            exclude_ps=exclude,
        )
        same_so_similar = _same_so_same_part_for_row(row, so_part_map)
        queued_in_so = [ps for ps in same_so_similar if ps in queued_bases]
        row["similar_ps"] = similar
        row["similar_ps_in_queue"] = [ps for ps in similar if ps in queued_bases]
        row["queued_in_planner"] = queued_same_part
        row["same_so_similar_ps"] = same_so_similar
        row["queued_in_so"] = queued_in_so
        row["planner_queued"] = in_queue
        row["is_repeat"] = bool(
            (similar and queued_same_part)
            or queued_in_so
            or same_so_similar
        )
    return rows, sorted(queued_bases)


def invalidate_new_orders_cache() -> None:
    global _cache, _notif_cache, _queued_lookup_cache, _repeat_lookup_cache
    _cache.clear()
    _notif_cache.clear()
    _queued_lookup_cache = None
    _repeat_lookup_cache = None
    from .erp_route_cache import invalidate_prefix

    invalidate_prefix("new_orders:")


def _serialize_notif_posted_at(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    text = compact_text(value)
    return text or None


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        return dt.replace(microsecond=0)
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    text = compact_text(value).replace("T", " ")
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1]
    plus = text.rfind("+")
    if plus > 10:
        text = text[:plus]
    text = text.strip()
    for fmt, width in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(text[:width], fmt)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(compact_text(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed.replace(microsecond=0)


def _so_event_kind(
    first_posted: Any,
    latest_posted: Any,
    *,
    week_from: date | None = None,
    created_at: Any = None,
) -> str:
    """'updated' when the SO already existed or was posted again; otherwise 'new'."""
    first_dt = _coerce_datetime(first_posted)
    latest_dt = _coerce_datetime(latest_posted)
    created_dt = _coerce_datetime(created_at)
    if week_from is not None:
        if first_dt is not None and first_dt.date() < week_from:
            return "updated"
        if created_dt is not None and created_dt.date() < week_from:
            return "updated"
    if first_dt is None or latest_dt is None:
        return "new"
    return "updated" if latest_dt > first_dt else "new"


def _so_in_posted_window(
    first_date: date | None,
    latest_date: date | None,
    from_d: date,
    to_d: date,
    *,
    include_reposts: bool,
) -> bool:
    if first_date is not None and from_d <= first_date <= to_d:
        return True
    if not include_reposts:
        return False
    return latest_date is not None and from_d <= latest_date <= to_d


def _build_notif_orders(
    rows: list[dict[str, Any]],
    *,
    week_from: date | None = None,
) -> list[dict[str, Any]]:
    """Compact SO cards for the navbar bell — no planner/repeat enrichment."""
    by_so: dict[str, dict[str, Any]] = {}
    seen_parts: dict[str, set[str]] = {}
    for row in rows:
        so = compact_text(row.get("source_voucher_no"))
        if not so:
            continue
        first_at = _serialize_notif_posted_at(row.get("first_posted_datetime"))
        latest_at = _serialize_notif_posted_at(row.get("latest_posted_datetime")) or first_at
        created_at = _serialize_notif_posted_at(row.get("created_datetime"))
        kind = _so_event_kind(
            row.get("first_posted_datetime"),
            row.get("latest_posted_datetime"),
            week_from=week_from,
            created_at=row.get("created_datetime"),
        )
        event_at = latest_at if kind == "updated" else first_at
        group = by_so.get(so)
        if group is None:
            group = {
                "so": so,
                "customer": compact_text(row.get("customer_code")),
                "kind": kind,
                "postedAt": event_at,
                "firstPostedAt": first_at,
                "latestPostedAt": latest_at,
                "createdAt": created_at,
                "parts": [],
            }
            by_so[so] = group
            seen_parts[so] = set()
        else:
            if not group.get("customer"):
                group["customer"] = compact_text(row.get("customer_code"))
            if kind == "updated":
                group["kind"] = "updated"
            if first_at and (
                not group.get("firstPostedAt") or first_at < str(group.get("firstPostedAt") or "")
            ):
                group["firstPostedAt"] = first_at
            if latest_at and latest_at > str(group.get("latestPostedAt") or ""):
                group["latestPostedAt"] = latest_at
            group["postedAt"] = (
                group.get("latestPostedAt")
                if group.get("kind") == "updated"
                else group.get("firstPostedAt")
            )

        ps = compact_text(row.get("process_sheet_no"))
        part = compact_text(row.get("inventory_code"))
        desc = compact_text(row.get("part_desc") or row.get("main_desc"))
        if not ps and not part:
            continue
        key = f"{ps}|{part}"
        if key in seen_parts[so]:
            continue
        seen_parts[so].add(key)
        group["parts"].append({"ps": ps, "part": part, "desc": desc})

    orders = list(by_so.values())
    orders.sort(key=lambda item: str(item.get("postedAt") or ""), reverse=True)
    return orders


def _notif_orders_for_week(*, refresh: bool = False) -> tuple[list[dict[str, Any]], date, date, float]:
    from_d, to_d = working_week_range()
    key = f"notif:v{_NOTIF_SCHEMA_VERSION}:{from_d.isoformat()}:{to_d.isoformat()}"
    now = time.time()
    if not refresh:
        cached = _notif_cache.get(key)
        if cached and now - cached[0] < _NOTIF_CACHE_TTL_SEC:
            return cached[1], from_d, to_d, cached[0]

    orders = _build_notif_orders(
        _fetch_new_orders(from_d, to_d, refresh=refresh, include_reposts=True),
        week_from=from_d,
    )
    _notif_cache[key] = (now, orders)
    return orders, from_d, to_d, now


def _coerce_date(value: Any) -> date | None:
    dt = _coerce_datetime(value)
    return dt.date() if dt is not None else None


def _resolve_posted_in_range(
    from_d: date,
    to_d: date,
    *,
    include_reposts: bool = False,
) -> dict[str, dict[str, Any]]:
    """Return SO numbers whose first post date falls in [from_d, to_d].

    With include_reposts, also keep SOs first posted earlier whose latest
    ERP post falls in the window (an update of an existing sales order).
    """
    staged_sql = STAGED_RECENT_SO_ACTIVITY_SQL if include_reposts else STAGED_RECENT_SO_HDR_SQL
    headers = _erp_query(staged_sql, (from_d,), live_sql=_RECENT_SO_HDR_SQL)
    if not headers:
        return {}

    so_nos = [
        compact_text(row.get("sales_order_no"))
        for row in headers
        if compact_text(row.get("sales_order_no"))
    ]
    if not so_nos:
        return {}

    first_posted_rows = _erp_query(
        STAGED_FIRST_POSTED_FOR_SOS_SQL,
        (so_nos,),
        live_sql=_FIRST_POSTED_FOR_SOS_SQL,
    )
    first_posted_by_so = {
        compact_text(row.get("sales_order_no")): row.get("first_posted_datetime")
        for row in first_posted_rows
        if compact_text(row.get("sales_order_no"))
    }

    posted: dict[str, dict[str, Any]] = {}
    for row in headers:
        so_no = compact_text(row.get("sales_order_no"))
        if not so_no:
            continue
        latest_posted = row.get("posted_datetime")
        first_posted = first_posted_by_so.get(so_no) or latest_posted
        if not _so_in_posted_window(
            _coerce_date(first_posted),
            _coerce_date(latest_posted),
            from_d,
            to_d,
            include_reposts=include_reposts,
        ):
            continue
        posted[so_no] = {
            "first_posted_datetime": first_posted,
            "latest_posted_datetime": latest_posted,
            "created_datetime": row.get("created_datetime"),
            "customer_code": row.get("customer_code"),
            "reference_no": row.get("reference_no"),
        }
    return posted


def _line_shipment_key(row: dict[str, Any]) -> tuple[str, str]:
    return (
        compact_text(row.get("source_voucher_no")),
        compact_text(row.get("source_voucher_line_item_no")),
    )


def _index_shipment_rows(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    indexed: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = _line_shipment_key(row)
        if not key[0]:
            continue
        existing = indexed.get(key)
        existing_qty = float(existing.get("qty_issued") or 0) if existing else 0.0
        row_qty = float(row.get("qty_issued") or 0)
        if existing is None or row_qty >= existing_qty:
            indexed[key] = dict(row)
        elif row_qty > 0:
            merged = dict(existing)
            merged["qty_issued"] = existing_qty + row_qty
            indexed[key] = merged
    return indexed


def _merge_shipment_fields(
    rows: list[dict[str, Any]],
    shipment_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_line = _index_shipment_rows(shipment_rows)
    merged_rows: list[dict[str, Any]] = []
    for row in rows:
        merged = dict(row)
        shipment = by_line.get(_line_shipment_key(row))
        if shipment:
            merged.update(
                {
                    "status": shipment.get("status"),
                    "qty_issued": shipment.get("qty_issued"),
                    "invoice_no": shipment.get("invoice_no"),
                    "invoice_line_item_no": shipment.get("invoice_line_item_no"),
                    "shipment_voucher_no": shipment.get("shipment_voucher_no"),
                    "arrival_date": shipment.get("arrival_date"),
                    "exch_rate": shipment.get("exch_rate"),
                    "do_no": shipment.get("do_no"),
                    "do_generation_datetime": shipment.get("do_generation_datetime"),
                    "total_home_amt": shipment.get("total_home_amt"),
                }
            )
            if shipment.get("unit_selling_price") is not None:
                merged["unit_selling_price"] = shipment.get("unit_selling_price")
        else:
            merged.setdefault("status", "Open")
            merged.setdefault("qty_issued", 0)
        merged_rows.append(merged)
    return merged_rows


def _attach_posted_headers(
    rows: list[dict[str, Any]],
    posted_by_so: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for row in rows:
        so_no = compact_text(row.get("source_voucher_no"))
        hdr = posted_by_so.get(so_no)
        if not hdr:
            continue
        merged = dict(row)
        merged.update(hdr)
        enriched.append(merged)
    enriched.sort(
        key=lambda row: (
            compact_text(row.get("first_posted_datetime")),
            compact_text(row.get("source_voucher_no")),
            compact_text(row.get("source_voucher_line_item_no")),
        ),
        reverse=True,
    )
    return enriched


def _fetch_new_orders(
    from_d: date,
    to_d: date,
    *,
    refresh: bool = False,
    include_reposts: bool = False,
) -> list[dict[str, Any]]:
    key = _cache_key(from_d, to_d, include_reposts=include_reposts)
    now = time.time()
    if not refresh:
        cached = _cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL_SEC:
            return cached[1]

    posted_by_so = _resolve_posted_in_range(from_d, to_d, include_reposts=include_reposts)
    if not posted_by_so:
        rows: list[dict[str, Any]] = []
    else:
        so_nos = list(posted_by_so.keys())
        line_rows = _erp_query(STAGED_NEW_ORDERS_LINES_SQL, (so_nos,), live_sql=_NEW_ORDERS_LINES_SQL)
        shipment_rows = _erp_query(
            STAGED_NEW_ORDERS_SHIPMENT_SQL,
            (so_nos,),
            live_sql=_NEW_ORDERS_SHIPMENT_SQL,
        )
        rows = _attach_posted_headers(
            _merge_shipment_fields(line_rows, shipment_rows),
            posted_by_so,
        )
        _apply_part_descriptions(rows)

    _cache[key] = (now, rows)
    return rows


def _parse_iso_date(raw: str | None, field: str) -> date | None:
    text = compact_text(raw)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        raise ValueError(f"{field} must be YYYY-MM-DD") from None


@new_orders_bp.get("/new-orders")
def new_orders_page():
    return render_template("new_orders.html", active="new_orders")


@new_orders_bp.get("/api/new-orders/notifications")
def api_new_orders_notifications():
    """Lightweight this-week SO feed for the navbar bell (skips repeat/queue enrich).

    Each card is tagged kind=new or kind=updated from first vs latest ERP post.
    """
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    try:
        orders, from_d, to_d, cached_at = _notif_orders_for_week(refresh=refresh)
    except Exception as exc:
        logger.exception("new orders notification feed failed")
        return jsonify({"ok": False, "error": f"ERP query failed: {exc}"}), 502

    return jsonify(
        {
            "ok": True,
            "from": from_d.isoformat(),
            "to": to_d.isoformat(),
            "week": "this_week",
            "count": len(orders),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(
                sep=" ", timespec="seconds"
            ),
            "cache_ttl_sec": _NOTIF_CACHE_TTL_SEC,
            "orders": orders,
        }
    )


@new_orders_bp.get("/api/new-orders")
def api_new_orders():
    week = compact_text(request.args.get("week")).lower()
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}

    try:
        if week == "last_week":
            from_d, to_d = working_week_range(offset_weeks=-1)
        elif week == "this_week" or (not week and not request.args.get("from")):
            from_d, to_d = working_week_range()
        else:
            from_raw = compact_text(request.args.get("from"))
            to_raw = compact_text(request.args.get("to"))
            if not from_raw or not to_raw:
                from_d, to_d = working_week_range()
            else:
                from_d = _parse_iso_date(from_raw, "from")
                to_d = _parse_iso_date(to_raw, "to")
                if from_d is None or to_d is None:
                    return jsonify({"error": "from and to are required for custom range"}), 400
                if to_d < from_d:
                    from_d, to_d = to_d, from_d
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        rows, queued_ps_bases = _enrich_new_orders_repeat_info(
            _fetch_new_orders(from_d, to_d, refresh=refresh)
        )
    except Exception as exc:
        logger.exception("new orders ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    cached = _cache.get(_cache_key(from_d, to_d))
    cached_at = cached[0] if cached else time.time()

    if week in {"this_week", "last_week"}:
        week_label = week
    elif compact_text(request.args.get("from")) and compact_text(request.args.get("to")):
        week_label = "custom"
    else:
        week_label = "this_week"

    return jsonify(
        {
            "ok": True,
            "from": from_d.isoformat(),
            "to": to_d.isoformat(),
            "week": week_label,
            "count": len(rows),
            "cached_at": datetime.fromtimestamp(cached_at, tz=None).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "queued_ps_bases": queued_ps_bases,
            "rows": rows,
        }
    )
