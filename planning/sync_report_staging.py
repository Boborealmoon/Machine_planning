"""COMAIN → Supabase staging for ERP report routes (S/O, sales report, etc.)."""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

SYNC_COOLDOWN_SECS = 300

_PP_VOUCHER_HDR_SQL = """
SELECT
    pp_voucher_no,
    inventory_code,
    bom_code,
    bom_desc,
    pp_qty,
    source_voucher_no,
    source_rsd::date,
    regexp_replace(source_line_item_no::TEXT, '\\.0+$', '') AS source_line_item_no,
    status,
    segment_1_code,
    proposed_edd::date,
    production_due_date::date,
    remarks,
    customer_code,
    mark_as_complete
FROM public.mfg_pp_vch
WHERE source_voucher_no IS NOT NULL
ORDER BY pp_voucher_no
"""
_PP_VOUCHER_HDR_COLS = [
    "pp_voucher_no", "inventory_code", "bom_code", "bom_desc", "pp_qty",
    "source_voucher_no", "source_rsd", "source_line_item_no", "status",
    "segment_1_code", "proposed_edd", "production_due_date", "remarks",
    "customer_code", "mark_as_complete",
]

_PP_PARTIAL_DETAIL_SQL = """
SELECT
    v.pp_voucher_no,
    v.pp_partial_no,
    p.partial_qty,
    v.inventory_code,
    v.customer_code,
    v.party_name,
    v.customer_po_no,
    p.production_due_date::date,
    p.proposed_edd::date
FROM public.mfg_pp_partial_view v
LEFT JOIN public.mfg_pp_partial p
       ON p.pp_voucher_no = v.pp_voucher_no
      AND p.pp_partial_no = v.pp_partial_no
ORDER BY v.pp_voucher_no, v.pp_partial_no
"""
_PP_PARTIAL_DETAIL_COLS = [
    "pp_voucher_no", "pp_partial_no", "partial_qty", "inventory_code",
    "customer_code", "party_name", "customer_po_no",
    "production_due_date", "proposed_edd",
]

_SO_ORDER_HEADER_SQL = """
SELECT
    v.sales_order_no,
    v.status,
    v.voucher_status,
    v.order_date::date,
    v.customer_code,
    v.customer_name,
    v.customer_short_name,
    v.customer_po_no,
    v.sales_person_code,
    v.sales_person_name,
    v.sbu_code,
    v.sbu_desc,
    v.reference_no,
    v.sales_quotation_no,
    v.total_after_tax_home_amt,
    v.total_pre_tax_home_amt,
    v.created_datetime,
    v.created_by_alias,
    v.last_updated_datetime,
    v.last_updated_by_alias,
    v.remarks,
    v.external_remarks,
    v.subject,
    h.posted_datetime,
    h.order_currency_code
FROM public.so_order_view v
LEFT JOIN public.so_order_ost_hdr h ON h.sales_order_no = v.sales_order_no
WHERE v.sales_order_no LIKE 'SO/%%'
ORDER BY v.sales_order_no
"""
_SO_ORDER_HEADER_COLS = [
    "sales_order_no", "status", "voucher_status", "order_date", "customer_code",
    "customer_name", "customer_short_name", "customer_po_no", "sales_person_code",
    "sales_person_name", "sbu_code", "sbu_desc", "reference_no", "sales_quotation_no",
    "total_after_tax_home_amt", "total_pre_tax_home_amt", "created_datetime",
    "created_by_alias", "last_updated_datetime", "last_updated_by_alias",
    "remarks", "external_remarks", "subject", "posted_datetime", "order_currency_code",
]

_SO_ORDER_LINE_SQL = """
SELECT
    det.sales_order_no,
    regexp_replace(det.line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    det.inventory_code,
    NULLIF(TRIM(det.line_item_description), '') AS line_item_description,
    det.qty,
    det.display_unit_price,
    det.base_unit_selling_price,
    det.pre_tax_extended_home_amt,
    det.required_shipment_date::date,
    ost.status AS ost_status,
    ost.posted_datetime,
    ost.order_currency_code,
    ost.exch_rate,
    v.customer_code,
    v.customer_name,
    v.sales_person_name,
    v.sbu_desc,
    v.order_date::date,
    COALESCE(rev.first_posted_datetime, ost.posted_datetime) AS first_posted_datetime
FROM public.so_order_ost_det det
JOIN public.so_order_ost_hdr ost ON ost.sales_order_no = det.sales_order_no
LEFT JOIN public.so_order_view v ON v.sales_order_no = det.sales_order_no
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = det.sales_order_no
WHERE det.sales_order_no LIKE 'SO/%%'
ORDER BY det.sales_order_no, line_item_no
"""
_SO_ORDER_LINE_COLS = [
    "sales_order_no", "line_item_no", "inventory_code", "line_item_description", "qty",
    "display_unit_price", "base_unit_selling_price", "pre_tax_extended_home_amt",
    "required_shipment_date", "ost_status", "posted_datetime", "order_currency_code",
    "exch_rate", "customer_code", "customer_name", "sales_person_name", "sbu_desc",
    "order_date", "first_posted_datetime",
]

_SO_ORDER_POSTED_SQL = """
SELECT
    h.sales_order_no,
    COALESCE(rev.first_posted_datetime, h.posted_datetime) AS first_posted_datetime,
    h.posted_datetime AS latest_posted_datetime,
    h.customer_code,
    h.reference_no,
    h.posted_datetime
FROM public.so_order_ost_hdr h
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = h.sales_order_no
WHERE h.sales_order_no LIKE 'SO/%%'
ORDER BY h.sales_order_no
"""
_SO_ORDER_POSTED_COLS = [
    "sales_order_no", "first_posted_datetime", "latest_posted_datetime",
    "customer_code", "reference_no", "posted_datetime",
]

_LG_OUT_SHIPMENT_SQL = """
SELECT
    d.source_voucher_no AS sales_order_no,
    regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    d.shipment_voucher_no,
    COALESCE(d.invoice_line_item_no::TEXT, '') AS invoice_line_item_no,
    d.inventory_code,
    NULLIF(TRIM(d.main_desc), '') AS description,
    d.qty_issued,
    d.unit_selling_price AS unit_selling_price_fc,
    COALESCE(h.exch_rate, 1) AS exch_rate,
    hdr.order_currency_code,
    d.invoice_no,
    COALESCE(h.arrival_date, h.do_generation_datetime) AS shipment_datetime,
    COALESCE(h.arrival_date, h.do_generation_datetime)::date AS shipment_date,
    so_det.required_shipment_date::date AS due_date,
    v.customer_code,
    v.customer_name,
    v.sales_person_name,
    v.sbu_desc,
    COALESCE(rev.first_posted_datetime, hdr.posted_datetime) AS first_posted_datetime,
    d.status AS detail_status,
    h.do_no,
    h.do_generation_datetime
FROM public.lg_out_shm_detail d
LEFT JOIN public.lg_out_shm_hst_hdr h
       ON d.shipment_voucher_no = h.shipment_voucher_no
LEFT JOIN public.so_order_ost_hdr hdr
       ON hdr.sales_order_no = d.source_voucher_no
LEFT JOIN public.so_order_view v
       ON v.sales_order_no = d.source_voucher_no
LEFT JOIN public.so_order_ost_det so_det
       ON so_det.sales_order_no = d.source_voucher_no
      AND regexp_replace(so_det.line_item_no::TEXT, '\\.0+$', '')
          = regexp_replace(d.source_voucher_line_item_no::TEXT, '\\.0+$', '')
LEFT JOIN (
    SELECT sales_order_no, MIN(posted_datetime) AS first_posted_datetime
    FROM public.so_order_rev_hst_hdr
    GROUP BY sales_order_no
) rev ON rev.sales_order_no = d.source_voucher_no
WHERE d.source_voucher_no LIKE 'SO/%%'
  AND NOT (d.status = 'History' AND COALESCE(d.qty_issued, 0) = 0)
ORDER BY shipment_datetime DESC NULLS LAST
"""
_LG_OUT_SHIPMENT_COLS = [
    "sales_order_no", "line_item_no", "shipment_voucher_no", "invoice_line_item_no",
    "inventory_code", "description", "qty_issued", "unit_selling_price_fc", "exch_rate",
    "order_currency_code", "invoice_no", "shipment_datetime", "shipment_date", "due_date",
    "customer_code", "customer_name", "sales_person_name", "sbu_desc",
    "first_posted_datetime", "detail_status", "do_no", "do_generation_datetime",
]

_STG_INVENTORY_BOM_STAGE_SQL = """
SELECT inventory_code, bom_code, stage_no, stage_desc
FROM public.mt_inventory_bom_stage
ORDER BY inventory_code, bom_code, stage_no
"""
_STG_INVENTORY_BOM_STAGE_COLS = ["inventory_code", "bom_code", "stage_no", "stage_desc"]

_QC_INSPECTION_SQL = """
SELECT
    inspection_voucher_no,
    status,
    inspector_code,
    inspector_name,
    po_no,
    supplier_code,
    supplier_name,
    source_voucher_no AS shipment_voucher_no,
    grn_no,
    item_no AS shipment_line_item_no,
    inventory_code,
    inventory_desc,
    uom,
    receiving_qty,
    inspected_qty,
    accepted_qty,
    rejected_qty,
    actual_arrival_date,
    goods_receipt_date,
    created_by_employee_code,
    created_by_employee_name,
    last_udpated_by_employee_code AS last_updated_by_employee_code,
    last_udpated_by_employee_name AS last_updated_by_employee_name,
    created_datetime,
    last_updated_datetime,
    internal_remarks,
    line_item_remarks,
    ncr_voucher_no,
    shipment_supplier_name,
    shipment_receiving_location_name,
    contact_person_name,
    generate_ncr,
    (source_voucher_no IS NOT NULL AND BTRIM(source_voucher_no) <> '') AS has_shipment
FROM public.zz_jasper_th5_quality_inspection_control_header
WHERE inspection_voucher_no ~ '^QI[0-9]+$'
ORDER BY created_datetime DESC NULLS LAST
"""
_QC_INSPECTION_COLS = [
    "inspection_voucher_no", "status", "inspector_code", "inspector_name", "po_no",
    "supplier_code", "supplier_name", "shipment_voucher_no", "grn_no",
    "shipment_line_item_no", "inventory_code", "inventory_desc", "uom",
    "receiving_qty", "inspected_qty", "accepted_qty", "rejected_qty",
    "actual_arrival_date", "goods_receipt_date", "created_by_employee_code",
    "created_by_employee_name", "last_updated_by_employee_code",
    "last_updated_by_employee_name", "created_datetime", "last_updated_datetime",
    "internal_remarks", "line_item_remarks", "ncr_voucher_no",
    "shipment_supplier_name", "shipment_receiving_location_name",
    "contact_person_name", "generate_ncr", "has_shipment",
]

_INVENTORY_ENQUIRY_SQL = """
SELECT inventory_code, row_to_json(v)::text AS payload_json
FROM public.ic_inventory_enquiry_summary_view v
WHERE inventory_code IS NOT NULL
  AND BTRIM(inventory_code) <> ''
ORDER BY inventory_code
"""

_KOBELCO_MPS_ARCHIVE_SQL = """
SELECT
    so.sales_order_no          AS pk_so,
    so.order_date::date         AS posted_date,
    so.reference_no              AS sales_quotation_no,
    so.customer_code,
    so.line_item_no,
    so.inventory_code            AS dwg_pn,
    so.main_desc                 AS description,
    COALESCE(mafs.sn_remarks, 'N/A') AS sn,
    so.customer_po_no,
    so.qty,
    shm.requested_shipment_date::date AS due_date,
    'IR-' || mafs.pk_key_pp_voucher_no   AS inspection_report_no,
    'COC-' || mafs.pk_key_pp_voucher_no  AS coc_no,
    mafs.pk_key_pp_voucher_no    AS ps_number,
    so.line_item_description,
    so.segment_1_code
FROM public.so_order_kobelco_view so
LEFT JOIN public.so_shm_detail shm
    ON shm.sales_order_no = so.sales_order_no
   AND shm.line_item_no   = so.line_item_no
LEFT JOIN public.mfg_arc_format_sourcing_v1_view mafs
    ON mafs.pk_key_sales_order_no      = so.sales_order_no
   AND mafs.pk_key_sales_line_item_no  = so.line_item_no
WHERE so.segment_1_code = 'MPS'
  AND so.order_date > DATE '2025-01-01'
ORDER BY mafs.pk_key_pp_voucher_no DESC NULLS LAST
"""
_KOBELCO_MPS_ARCHIVE_COLS = [
    "pk_so", "posted_date", "sales_quotation_no", "customer_code", "line_item_no",
    "dwg_pn", "description", "sn", "customer_po_no", "qty", "due_date",
    "inspection_report_no", "coc_no", "ps_number", "line_item_description", "segment_1_code",
]


def _domain_fetch(sql: str) -> list:
    from db import get_conn, release_conn

    src = get_conn()
    try:
        with src.cursor() as scur:
            scur.execute(sql)
            return scur.fetchall()
    finally:
        release_conn(src)


def _run_simple_staging_sync(
    *,
    table: str,
    sql: str,
    columns: list[str],
    lock: threading.Lock,
    last_at: list[float],
    force: bool,
    label: str,
) -> dict:
    if not force and (time.monotonic() - last_at[0]) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from sync import _staging_reload

        t0 = time.monotonic()
        rows = _domain_fetch(sql)
        reload_mode = _staging_reload(table, "_loaded_at", columns, rows)
        last_at[0] = time.monotonic()
        log.info("%s sync complete (%s) - %d rows in %dms", label, reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
            "reload": reload_mode,
        }
    finally:
        lock.release()


_pp_voucher_hdr_lock = threading.Lock()
_last_pp_voucher_hdr_sync_at = [0.0]
_pp_partial_detail_lock = threading.Lock()
_last_pp_partial_detail_sync_at = [0.0]
_so_order_header_lock = threading.Lock()
_last_so_order_header_sync_at = [0.0]
_so_order_line_lock = threading.Lock()
_last_so_order_line_sync_at = [0.0]
_so_order_posted_lock = threading.Lock()
_last_so_order_posted_sync_at = [0.0]
_lg_out_shipment_lock = threading.Lock()
_last_lg_out_shipment_sync_at = [0.0]
_stg_inventory_bom_stage_lock = threading.Lock()
_last_stg_inventory_bom_stage_sync_at = [0.0]
_stg_qc_inspection_lock = threading.Lock()
_last_stg_qc_inspection_sync_at = [0.0]
_stg_inventory_enquiry_lock = threading.Lock()
_last_stg_inventory_enquiry_sync_at = [0.0]
_stg_kobelco_mps_archive_lock = threading.Lock()
_last_stg_kobelco_mps_archive_sync_at = [0.0]


def run_pp_voucher_hdr_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="pp_voucher_hdr",
        sql=_PP_VOUCHER_HDR_SQL,
        columns=_PP_VOUCHER_HDR_COLS,
        lock=_pp_voucher_hdr_lock,
        last_at=_last_pp_voucher_hdr_sync_at,
        force=force,
        label="pp_voucher_hdr",
    )


def run_pp_partial_detail_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="pp_partial_detail",
        sql=_PP_PARTIAL_DETAIL_SQL,
        columns=_PP_PARTIAL_DETAIL_COLS,
        lock=_pp_partial_detail_lock,
        last_at=_last_pp_partial_detail_sync_at,
        force=force,
        label="pp_partial_detail",
    )


def run_so_order_header_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="so_order_header",
        sql=_SO_ORDER_HEADER_SQL,
        columns=_SO_ORDER_HEADER_COLS,
        lock=_so_order_header_lock,
        last_at=_last_so_order_header_sync_at,
        force=force,
        label="so_order_header",
    )


def run_so_order_line_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="so_order_line",
        sql=_SO_ORDER_LINE_SQL,
        columns=_SO_ORDER_LINE_COLS,
        lock=_so_order_line_lock,
        last_at=_last_so_order_line_sync_at,
        force=force,
        label="so_order_line",
    )


def run_so_order_posted_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="so_order_posted",
        sql=_SO_ORDER_POSTED_SQL,
        columns=_SO_ORDER_POSTED_COLS,
        lock=_so_order_posted_lock,
        last_at=_last_so_order_posted_sync_at,
        force=force,
        label="so_order_posted",
    )


def run_lg_out_shipment_line_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="lg_out_shipment_line",
        sql=_LG_OUT_SHIPMENT_SQL,
        columns=_LG_OUT_SHIPMENT_COLS,
        lock=_lg_out_shipment_lock,
        last_at=_last_lg_out_shipment_sync_at,
        force=force,
        label="lg_out_shipment_line",
    )


def run_stg_inventory_bom_stage_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="stg_inventory_bom_stage",
        sql=_STG_INVENTORY_BOM_STAGE_SQL,
        columns=_STG_INVENTORY_BOM_STAGE_COLS,
        lock=_stg_inventory_bom_stage_lock,
        last_at=_last_stg_inventory_bom_stage_sync_at,
        force=force,
        label="stg_inventory_bom_stage",
    )


def run_stg_qc_inspection_sync(force: bool = False) -> dict:
    return _run_simple_staging_sync(
        table="stg_qc_inspection",
        sql=_QC_INSPECTION_SQL,
        columns=_QC_INSPECTION_COLS,
        lock=_stg_qc_inspection_lock,
        last_at=_last_stg_qc_inspection_sync_at,
        force=force,
        label="stg_qc_inspection",
    )


def run_stg_inventory_enquiry_sync(force: bool = False) -> dict:
    if not force and (time.monotonic() - _last_stg_inventory_enquiry_sync_at[0]) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _stg_inventory_enquiry_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from psycopg2.extras import Json
        from sync import _staging_reload

        t0 = time.monotonic()
        raw = _domain_fetch(_INVENTORY_ENQUIRY_SQL)
        rows = [(code, Json(json.loads(payload))) for code, payload in raw if code]
        reload_mode = _staging_reload(
            "stg_inventory_enquiry",
            "_loaded_at",
            ["inventory_code", "payload"],
            rows,
        )
        _last_stg_inventory_enquiry_sync_at[0] = time.monotonic()
        log.info("stg_inventory_enquiry sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
            "reload": reload_mode,
        }
    finally:
        _stg_inventory_enquiry_lock.release()


def run_stg_kobelco_mps_archive_sync(force: bool = False) -> dict:
    if not force and (time.monotonic() - _last_stg_kobelco_mps_archive_sync_at[0]) < SYNC_COOLDOWN_SECS:
        return {"skipped": True, "reason": "within cooldown"}
    if not _stg_kobelco_mps_archive_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "sync already in progress"}
    try:
        from sync import _staging_reload

        t0 = time.monotonic()
        rows = _domain_fetch(_KOBELCO_MPS_ARCHIVE_SQL)
        reload_mode = _staging_reload(
            "stg_kobelco_mps_archive",
            "_loaded_at",
            _KOBELCO_MPS_ARCHIVE_COLS,
            rows,
        )
        _last_stg_kobelco_mps_archive_sync_at[0] = time.monotonic()
        log.info("stg_kobelco_mps_archive sync complete (%s) - %d rows in %dms", reload_mode, len(rows), int((time.monotonic() - t0) * 1000))
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "row_count": len(rows),
            "reload": reload_mode,
        }
    finally:
        _stg_kobelco_mps_archive_lock.release()


REPORT_STAGING_STEP_ORDER = [
    "pp_voucher_hdr",
    "pp_partial_detail",
    "so_order_header",
    "so_order_line",
    "so_order_posted",
    "lg_out_shipment_line",
    "stg_inventory_bom_stage",
    "stg_qc_inspection",
    "stg_inventory_enquiry",
    "stg_kobelco_mps_archive",
]

REPORT_STAGING_STEP_LABELS = {
    "pp_voucher_hdr": "PP voucher headers",
    "pp_partial_detail": "PP partial details",
    "so_order_header": "SO headers",
    "so_order_line": "SO lines (pricing)",
    "so_order_posted": "SO posted dates",
    "lg_out_shipment_line": "Outbound shipments",
    "stg_inventory_bom_stage": "BOM stages (all)",
    "stg_qc_inspection": "QC inspections",
    "stg_inventory_enquiry": "Inventory enquiry",
    "stg_kobelco_mps_archive": "Kobelco MPS archive",
}

REPORT_STAGING_RUNNERS = {
    "pp_voucher_hdr": run_pp_voucher_hdr_sync,
    "pp_partial_detail": run_pp_partial_detail_sync,
    "so_order_header": run_so_order_header_sync,
    "so_order_line": run_so_order_line_sync,
    "so_order_posted": run_so_order_posted_sync,
    "lg_out_shipment_line": run_lg_out_shipment_line_sync,
    "stg_inventory_bom_stage": run_stg_inventory_bom_stage_sync,
    "stg_qc_inspection": run_stg_qc_inspection_sync,
    "stg_inventory_enquiry": run_stg_inventory_enquiry_sync,
    "stg_kobelco_mps_archive": run_stg_kobelco_mps_archive_sync,
}

REPORT_STAGING_LOCKS = {
    "pp_voucher_hdr": _pp_voucher_hdr_lock,
    "pp_partial_detail": _pp_partial_detail_lock,
    "so_order_header": _so_order_header_lock,
    "so_order_line": _so_order_line_lock,
    "so_order_posted": _so_order_posted_lock,
    "lg_out_shipment_line": _lg_out_shipment_lock,
    "stg_inventory_bom_stage": _stg_inventory_bom_stage_lock,
    "stg_qc_inspection": _stg_qc_inspection_lock,
    "stg_inventory_enquiry": _stg_inventory_enquiry_lock,
    "stg_kobelco_mps_archive": _stg_kobelco_mps_archive_lock,
}
