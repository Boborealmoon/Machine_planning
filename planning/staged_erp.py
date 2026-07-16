"""Read ERP report data from Supabase staging tables (no live COMAIN on page load)."""
from __future__ import annotations

import os
import re
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable

from .helpers import planner_db, rows

# Set ERP_LIVE_READ=1 to force live COMAIN reads for all report routes.
_USE_STAGING = os.getenv("ERP_LIVE_READ", "").strip().lower() not in {"1", "true", "yes", "on"}

# These planning-data screens always read live COMAIN (never Supabase report staging).
_LIVE_READ_DOMAINS = frozenset({
    "new_orders",
    "sales_orders",
    "delivery_schedule",
    "inventory_enquiry",
    "inventory_bom",
    "bom_variation",
    "material_inspection",
    "qc_quality_queue",
    "accounts",
})

_staging_populated_cache: tuple[float, bool] | None = None
_STAGING_POPULATED_CACHE_SEC = 60
_staging_table_populated_cache: dict[str, tuple[float, bool]] = {}
_STAGING_TABLE_POPULATED_CACHE_SEC = 60
_STAGING_FROM_RE = re.compile(r"FROM\s+public\.(\w+)", re.I | re.MULTILINE)
_STAGING_TABLE_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def use_staging_reads(domain: str | None = None) -> bool:
    if domain and domain in _LIVE_READ_DOMAINS:
        return False
    return _USE_STAGING


def live_read_domain(domain: str) -> bool:
    return domain in _LIVE_READ_DOMAINS or not _USE_STAGING


def _staging_tables_populated() -> bool:
    """True once report staging has been loaded at least once (pp_voucher_hdr non-empty)."""
    global _staging_populated_cache
    if not _USE_STAGING:
        return True
    now = time.monotonic()
    if _staging_populated_cache and (now - _staging_populated_cache[0]) < _STAGING_POPULATED_CACHE_SEC:
        return _staging_populated_cache[1]
    try:
        fetched = staged_query(
            "SELECT EXISTS (SELECT 1 FROM public.pp_voucher_hdr LIMIT 1) AS populated"
        )
        populated = bool(fetched and fetched[0].get("populated"))
    except Exception:
        populated = False
    _staging_populated_cache = (now, populated)
    return populated


def _infer_staging_table(sql: str) -> str | None:
    match = _STAGING_FROM_RE.search(sql)
    return match.group(1) if match else None


def _staging_table_populated(table: str) -> bool:
    """True when a specific report staging table has been loaded at least once."""
    if not _USE_STAGING:
        return True
    if not _STAGING_TABLE_NAME_RE.fullmatch(table or ""):
        return False
    now = time.monotonic()
    cached = _staging_table_populated_cache.get(table)
    if cached and (now - cached[0]) < _STAGING_TABLE_POPULATED_CACHE_SEC:
        return cached[1]
    try:
        fetched = staged_query(
            f"SELECT EXISTS (SELECT 1 FROM public.{table} LIMIT 1) AS populated"
        )
        populated = bool(fetched and fetched[0].get("populated"))
    except Exception:
        populated = False
    _staging_table_populated_cache[table] = (now, populated)
    return populated


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, tuple):
        return [_serialize_value(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bool):
        return value
    return value


def serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


def staged_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with planner_db() as con:
        fetched = rows(con.execute(sql, params))
    return [serialize_row(dict(row)) for row in fetched]


def live_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    import psycopg2.extras
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [serialize_row(dict(row)) for row in cur.fetchall()]
    finally:
        release_conn(conn)


def fetch_rows(
    sql: str,
    params: tuple = (),
    *,
    live_sql: str | None = None,
    staging_table: str | None = None,
    domain: str | None = None,
) -> list[dict[str, Any]]:
    if domain and domain in _LIVE_READ_DOMAINS:
        return live_query(live_sql or sql, params)
    if _USE_STAGING:
        if live_sql and not _staging_tables_populated():
            return live_query(live_sql, params)
        table = staging_table or _infer_staging_table(sql)
        if live_sql and table and not _staging_table_populated(table):
            return live_query(live_sql, params)
        try:
            return staged_query(sql, params)
        except Exception as exc:
            # During rollout, staging tables may not exist yet on the planner DB.
            # Fall back to COMAIN live reads so pages keep working until Sync ERP rebuilds them.
            msg = str(exc).lower()
            if live_sql and (
                "does not exist" in msg
                or "undefinedtable" in msg
                or "undefinedcolumn" in msg
            ):
                return live_query(live_sql, params)
            raise
    return live_query(live_sql or sql, params)


def fetch_cached(
    cache_key: str,
    loader: Callable[[], Any],
    *,
    ttl_sec: int = 300,
    refresh: bool = False,
) -> Any:
    from .erp_route_cache import cached_fetch

    return cached_fetch(cache_key, loader, ttl_sec=ttl_sec, refresh=refresh)


# ── Sales orders (S/O Management) ───────────────────────────────────────────

STAGED_MFG_PP_VCH_SQL = """
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
FROM public.pp_voucher_hdr pp
LEFT JOIN public.part_desc pd
       ON pd.inventory_code = pp.inventory_code
LEFT JOIN public.so_order_header hdr
       ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.so_order_line det
       ON det.sales_order_no = pp.source_voucher_no
      AND det.line_item_no = pp.source_line_item_no
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND sq.line_item_no = pp.source_line_item_no
LEFT JOIN (
    SELECT
        sales_order_no,
        line_item_no,
        MAX(shipment_date) AS last_shipment_date
    FROM public.lg_out_shipment_line
    WHERE COALESCE(qty_issued, 0) > 0
    GROUP BY sales_order_no, line_item_no
) shipped
       ON shipped.sales_order_no = pp.source_voucher_no
      AND shipped.line_item_no = pp.source_line_item_no
LEFT JOIN (
    SELECT pp_voucher_no, MAX(customer_po_no) AS customer_po_no
    FROM public.pp_partial_detail
    GROUP BY pp_voucher_no
) part ON part.pp_voucher_no = pp.pp_voucher_no
WHERE pp.source_voucher_no IS NOT NULL
ORDER BY pp.source_voucher_no, pp.pp_voucher_no
"""

STAGED_MFG_PP_PARTIAL_SQL = """
SELECT
    pp_voucher_no,
    pp_partial_no,
    inventory_code,
    customer_code,
    party_name,
    customer_po_no
FROM public.pp_partial_detail
ORDER BY pp_voucher_no, pp_partial_no
"""

STAGED_SO_ORDER_HEADER_SQL = """
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
FROM public.so_order_header
"""

STAGED_SO_POSTED_DATES_SQL = """
SELECT
    sales_order_no,
    first_posted_datetime,
    latest_posted_datetime
FROM public.so_order_posted
"""

# ── Sales report / job ratio pricing macros (staged so_order_line) ────────────

_UNIT_FC_STAGED = "COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price)"
_EXCH_STAGED = "COALESCE(det.exch_rate, 1)"
_UNIT_HOME_STAGED = f"""
CASE
    WHEN COALESCE(det.qty, 0) > 0 AND det.pre_tax_extended_home_amt IS NOT NULL
        THEN det.pre_tax_extended_home_amt / det.qty
    ELSE {_UNIT_FC_STAGED} * {_EXCH_STAGED}
END
"""
_REMAINING_HOME_STAGED = f"""
CASE
    WHEN COALESCE(det.qty, 0) > 0 AND det.pre_tax_extended_home_amt IS NOT NULL
        THEN det.pre_tax_extended_home_amt
            * GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) / det.qty
    ELSE GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0))
        * {_UNIT_FC_STAGED} * {_EXCH_STAGED}
END
"""
_LINE_HOME_STAGED = f"""
CASE
    WHEN COALESCE(det.qty, 0) > 0 AND det.pre_tax_extended_home_amt IS NOT NULL
        THEN det.pre_tax_extended_home_amt
    ELSE det.qty * {_UNIT_FC_STAGED} * {_EXCH_STAGED}
END
"""

STAGED_SO_LINES_SQL = f"""
SELECT
    det.sales_order_no,
    det.line_item_no,
    det.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), '')
    ) AS description,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS qty_shipped,
    GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) AS remaining_qty,
    {_UNIT_HOME_STAGED.strip()} AS unit_selling_price,
    ({_REMAINING_HOME_STAGED.strip()}) AS remaining_value,
    {_UNIT_FC_STAGED} AS unit_selling_price_fc,
    {_EXCH_STAGED} AS exch_rate,
    det.order_currency_code,
    det.required_shipment_date::date AS due_date,
    det.customer_code,
    det.customer_name,
    det.sales_person_name,
    det.sbu_desc,
    COALESCE(det.first_posted_datetime, det.posted_datetime) AS first_posted_datetime
FROM public.so_order_line det
LEFT JOIN public.part_desc pd
       ON pd.inventory_code = det.inventory_code
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = det.sales_order_no
      AND sq.line_item_no = det.line_item_no
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(det.ost_status, '') <> 'V'
  AND GREATEST(0, det.qty - COALESCE(sq.qty_shipped, 0)) > 0.0001
ORDER BY det.required_shipment_date NULLS LAST, det.sales_order_no, det.line_item_no
"""

STAGED_PP_JOBS_SQL = """
SELECT
    pp.pp_voucher_no,
    COALESCE(ps.process_sheet_no, pp.pp_voucher_no) AS process_sheet_no,
    pp.source_voucher_no AS sales_order_no,
    pp.source_line_item_no AS line_item_no,
    COALESCE(ps.inventory_code, pp.inventory_code) AS inventory_code,
    pp.pp_qty,
    pp.proposed_edd::date AS proposed_edd,
    pp.production_due_date::date AS production_due_date,
    COALESCE(det.required_shipment_date, pp.source_rsd)::date AS so_due_date,
    COALESCE(NULLIF(det.display_unit_price, 0), det.base_unit_selling_price) AS unit_selling_price,
    det.qty AS so_det_qty,
    COALESCE(sq.qty_shipped, 0) AS so_line_qty_shipped
FROM public.pp_voucher_hdr pp
LEFT JOIN (
    SELECT DISTINCT ON (pp_voucher_no)
        pp_voucher_no,
        process_sheet_no,
        inventory_code
    FROM public.mfg_process_sheet_info
    ORDER BY pp_voucher_no, process_sheet_no
) ps ON ps.pp_voucher_no = pp.pp_voucher_no
LEFT JOIN public.so_order_line det
       ON det.sales_order_no = pp.source_voucher_no
      AND det.line_item_no = pp.source_line_item_no
LEFT JOIN public.sum_qty_shipped_by_sales_order sq
       ON sq.sales_order_no = pp.source_voucher_no
      AND sq.line_item_no = pp.source_line_item_no
WHERE pp.source_voucher_no LIKE 'SO/%%'
ORDER BY pp.source_voucher_no, pp.line_item_no, pp.pp_voucher_no
"""

STAGED_PP_PARTIALS_SQL = """
SELECT
    pp_voucher_no,
    pp_partial_no,
    partial_qty,
    production_due_date::date AS production_due_date,
    proposed_edd::date AS proposed_edd
FROM public.pp_partial_detail
ORDER BY pp_voucher_no, pp_partial_no
"""

STAGED_SHIPMENTS_SQL = """
SELECT
    sales_order_no,
    line_item_no,
    inventory_code,
    description,
    qty_issued,
    unit_selling_price_fc,
    (unit_selling_price_fc * qty_issued) AS line_fc_amt,
    exch_rate,
    (unit_selling_price_fc * qty_issued * exch_rate) AS total_home_amt,
    order_currency_code,
    shipment_voucher_no,
    invoice_no,
    invoice_line_item_no,
    shipment_datetime,
    shipment_date,
    due_date,
    customer_code,
    customer_name,
    sales_person_name,
    sbu_desc,
    first_posted_datetime,
    (first_posted_datetime::date < %s::date) AS is_backlog_clear
FROM public.lg_out_shipment_line
WHERE sales_order_no LIKE 'SO/%%'
  AND shipment_date BETWEEN %s AND %s
ORDER BY shipment_datetime DESC, sales_order_no, line_item_no
"""

STAGED_BOOKED_SQL = f"""
SELECT
    det.sales_order_no,
    det.line_item_no,
    det.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), '')
    ) AS description,
    det.qty,
    {_UNIT_FC_STAGED} AS unit_selling_price_fc,
    {_EXCH_STAGED} AS exch_rate,
    det.order_currency_code,
    {_UNIT_HOME_STAGED.strip()} AS unit_selling_price,
    ({_LINE_HOME_STAGED.strip()}) AS line_amount,
    det.required_shipment_date::date AS due_date,
    COALESCE(det.first_posted_datetime, det.posted_datetime) AS first_posted_datetime,
    det.customer_code,
    det.customer_name,
    det.sales_person_name,
    det.sbu_desc
FROM public.so_order_line det
LEFT JOIN public.part_desc pd
       ON pd.inventory_code = det.inventory_code
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(det.ost_status, '') <> 'V'
  AND COALESCE(det.first_posted_datetime, det.posted_datetime)::date BETWEEN %s AND %s
ORDER BY first_posted_datetime DESC, det.sales_order_no, det.line_item_no
"""

STAGED_SO_LINE_PRICING_SQL = f"""
SELECT
    det.sales_order_no,
    det.line_item_no,
    det.inventory_code,
    COALESCE(
        NULLIF(TRIM(pd.main_desc), ''),
        NULLIF(TRIM(det.line_item_description), '')
    ) AS description,
    det.qty,
    {_UNIT_HOME_STAGED.strip()} AS unit_selling_price,
    ({_LINE_HOME_STAGED.strip()}) AS line_amount,
    det.required_shipment_date::date AS due_date,
    COALESCE(det.first_posted_datetime, det.posted_datetime) AS first_posted_datetime,
    COALESCE(det.first_posted_datetime, det.posted_datetime)::date AS so_posted_date,
    COALESCE(det.order_date, det.posted_datetime::date) AS so_header_order_date,
    det.customer_code,
    det.customer_name,
    det.sales_person_name,
    det.sbu_desc
FROM public.so_order_line det
LEFT JOIN public.part_desc pd
       ON pd.inventory_code = det.inventory_code
WHERE det.sales_order_no LIKE 'SO/%%'
  AND COALESCE(det.qty, 0) > 0
  AND COALESCE(det.ost_status, '') <> 'V'
ORDER BY det.sales_order_no, det.line_item_no
"""

# ── New orders ───────────────────────────────────────────────────────────────

STAGED_RECENT_SO_HDR_SQL = """
SELECT sales_order_no, posted_datetime, customer_code, reference_no
FROM public.so_order_posted
WHERE sales_order_no LIKE 'SO/%%'
  AND COALESCE(first_posted_datetime, posted_datetime)::date >= %s
"""

STAGED_FIRST_POSTED_FOR_SOS_SQL = """
SELECT sales_order_no, first_posted_datetime
FROM public.so_order_posted
WHERE sales_order_no = ANY(%s)
"""

STAGED_NEW_ORDERS_LINES_SQL = """
SELECT
    pp.source_voucher_no AS source_voucher_no,
    pp.source_line_item_no AS source_voucher_line_item_no,
    pp.pp_voucher_no AS process_sheet_no,
    COALESCE(pp.inventory_code, det.inventory_code) AS inventory_code,
    COALESCE(
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
FROM public.pp_voucher_hdr pp
LEFT JOIN public.so_order_line det
    ON det.sales_order_no = pp.source_voucher_no
    AND det.line_item_no = pp.source_line_item_no
LEFT JOIN public.so_order_header hdr
    ON hdr.sales_order_no = pp.source_voucher_no
LEFT JOIN public.part_desc pd
    ON pd.inventory_code = COALESCE(pp.inventory_code, det.inventory_code)
LEFT JOIN (
    SELECT pp_voucher_no, MAX(customer_po_no) AS customer_po_no
    FROM public.pp_partial_detail
    GROUP BY pp_voucher_no
) part ON part.pp_voucher_no = pp.pp_voucher_no
WHERE pp.source_voucher_no = ANY(%s)
ORDER BY pp.source_voucher_no, source_voucher_line_item_no, pp.pp_voucher_no
"""

STAGED_NEW_ORDERS_SHIPMENT_SQL = """
SELECT
    sales_order_no AS source_voucher_no,
    line_item_no AS source_voucher_line_item_no,
    detail_status AS status,
    qty_issued,
    invoice_no,
    invoice_line_item_no,
    shipment_voucher_no,
    unit_selling_price_fc AS unit_selling_price,
    shipment_datetime AS arrival_date,
    exch_rate,
    do_no,
    do_generation_datetime,
    (unit_selling_price_fc * qty_issued * exch_rate) AS total_home_amt
FROM public.lg_out_shipment_line
WHERE sales_order_no = ANY(%s)
ORDER BY shipment_datetime DESC NULLS LAST
"""
