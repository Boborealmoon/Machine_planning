"""Supply Chain View overview: one row per PR line, with PO and receipt filled in.

A line starts as a current purchase request (draft, or the latest posted revision).
A purchase order attaches when its header names that PR, or when the PO line
was raised against an existing PO (the PR sits on the line, not the header).
Cancelled POs stay off; completed POs stay so a posted GRN remains.
Inbound shipments, GRNs, and QI attach by PO number and PO line. Several
receipts become several rows that repeat the same PR and PO.

Status is the latest stage reached:
  PR, PO draft, PO pushed, PO under variation, PO completed,
  Waiting for GRN, GRN, QI.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, request

from .staged_erp import live_query
from .utils import compact_text

logger = logging.getLogger(__name__)

material_tracking_overview_bp = Blueprint("material_tracking_overview", __name__)

_CACHE_TTL_SEC = 300
_QUERY_TIMEOUT_MS = 90000
_SBU_CODE_RE = re.compile(r"[A-Z0-9_-]{1,20}")
_rows_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_sbus_cache: tuple[float, list[str]] | None = None

_SOURCE = (
    "pr_req_new + pr_req_hst, po_order_new + po_order_ost, "
    "lg_in_shm_ost + lg_in_shm_hst (live COMAIN)"
)

_SQL = """
WITH pr_union AS (
    SELECT
        BTRIM(h.purchase_requisition_no) AS purchase_requisition_no,
        regexp_replace(COALESCE(d.line_item_no::text, ''), '\\.0+$', '') AS line_item_no,
        h.purchase_requisition_date AS pr_date,
        COALESCE(
            NULLIF(BTRIM(d.inventory_code), ''),
            NULLIF(BTRIM(d.service_code), ''),
            NULLIF(BTRIM(d.fixed_asset_code), '')
        ) AS item_code,
        COALESCE(
            NULLIF(BTRIM(d.line_item_description), ''),
            NULLIF(BTRIM(d.item_description), ''),
            inv.main_desc,
            srv.service_desc
        ) AS description,
        d.qty,
        NULLIF(BTRIM(h.default_supplier_code), '') AS supplier_code,
        p.party_name AS supplier_name,
        NULLIF(BTRIM(h.sbu_code), '') AS sbu_code,
        NULLIF(BTRIM(h.segment_1_code), '') AS segment_1_code,
        NULLIF(BTRIM(seg.segment_desc), '') AS segment_desc,
        COALESCE(
            NULLIF(BTRIM(h.project_no), ''),
            NULLIF(BTRIM(h.source_project_no), ''),
            NULLIF(BTRIM(h.source_voucher_no), '')
        ) AS project_no,
        1 AS src_rank
    FROM pr_req_new_hdr h
    JOIN pr_req_new_det d
      ON d.purchase_requisition_no = h.purchase_requisition_no
    LEFT JOIN mt_inventory inv
      ON inv.inventory_code = d.inventory_code
    LEFT JOIN mt_service srv
      ON srv.service_code = d.service_code
    LEFT JOIN mt_party p
      ON p.party_code = h.default_supplier_code
    LEFT JOIN public.mt_segment1 seg
      ON seg.segment_code = h.segment_1_code
    WHERE NULLIF(BTRIM(h.purchase_requisition_no), '') IS NOT NULL

    UNION ALL

    SELECT
        BTRIM(h.purchase_requisition_no) AS purchase_requisition_no,
        regexp_replace(COALESCE(d.line_item_no::text, ''), '\\.0+$', '') AS line_item_no,
        h.purchase_requisition_date AS pr_date,
        COALESCE(
            NULLIF(BTRIM(d.inventory_code), ''),
            NULLIF(BTRIM(d.service_code), ''),
            NULLIF(BTRIM(d.fixed_asset_code), '')
        ) AS item_code,
        COALESCE(
            NULLIF(BTRIM(d.line_item_description), ''),
            NULLIF(BTRIM(d.item_description), ''),
            inv.main_desc,
            srv.service_desc
        ) AS description,
        d.qty,
        NULLIF(BTRIM(h.default_supplier_code), '') AS supplier_code,
        p.party_name AS supplier_name,
        NULLIF(BTRIM(h.sbu_code), '') AS sbu_code,
        NULLIF(BTRIM(h.segment_1_code), '') AS segment_1_code,
        NULLIF(BTRIM(seg.segment_desc), '') AS segment_desc,
        COALESCE(
            NULLIF(BTRIM(h.project_no), ''),
            NULLIF(BTRIM(h.source_project_no), ''),
            NULLIF(BTRIM(h.source_voucher_no), '')
        ) AS project_no,
        0 AS src_rank
    FROM pr_req_hst_hdr h
    JOIN pr_req_hst_max_revision mx
      ON mx.purchase_requisition_no = h.purchase_requisition_no
     AND mx.max_revision_no = h.revision_no
    JOIN pr_req_hst_det d
      ON d.purchase_requisition_no = h.purchase_requisition_no
     AND d.revision_no = h.revision_no
    LEFT JOIN mt_inventory inv
      ON inv.inventory_code = d.inventory_code
    LEFT JOIN mt_service srv
      ON srv.service_code = d.service_code
    LEFT JOIN mt_party p
      ON p.party_code = h.default_supplier_code
    LEFT JOIN public.mt_segment1 seg
      ON seg.segment_code = h.segment_1_code
    WHERE NULLIF(BTRIM(h.purchase_requisition_no), '') IS NOT NULL
),
pr_lines AS (
    SELECT DISTINCT ON (purchase_requisition_no, line_item_no, item_key)
        purchase_requisition_no,
        line_item_no,
        pr_date,
        item_code,
        description,
        qty,
        supplier_code,
        supplier_name,
        sbu_code,
        segment_1_code,
        segment_desc,
        project_no,
        item_key
    FROM (
        SELECT
            pr_union.*,
            UPPER(BTRIM(COALESCE(item_code, ''))) AS item_key
        FROM pr_union
    ) tagged
    WHERE (%s OR UPPER(BTRIM(COALESCE(sbu_code, ''))) = ANY(%s))
    ORDER BY purchase_requisition_no, line_item_no, item_key, src_rank
),
po_union AS (
    SELECT
        COALESCE(
            NULLIF(BTRIM(d.source_voucher_no), ''),
            NULLIF(BTRIM(h.purchase_requisition_no), '')
        ) AS purchase_requisition_no,
        BTRIM(h.purchase_order_no) AS purchase_order_no,
        h.order_date AS po_date,
        h.status AS po_status,
        regexp_replace(COALESCE(d.line_item_no::text, ''), '\\.0+$', '') AS line_item_no,
        NULLIF(
            regexp_replace(COALESCE(d.source_voucher_line_item_no::text, ''), '\\.0+$', ''),
            '0'
        ) AS source_line_item_no,
        COALESCE(
            NULLIF(BTRIM(d.inventory_code), ''),
            NULLIF(BTRIM(d.service_code), ''),
            NULLIF(BTRIM(d.fixed_asset_code), '')
        ) AS item_code,
        d.qty AS po_qty,
        NULLIF(BTRIM(h.supplier_code), '') AS supplier_code,
        p.party_name AS supplier_name,
        0 AS src_rank
    FROM po_order_ost_hdr h
    JOIN po_order_ost_det d
      ON d.purchase_order_no = h.purchase_order_no
    LEFT JOIN mt_party p
      ON p.party_code = h.supplier_code
    WHERE h.status IN ('O', 'U', 'C')
      AND COALESCE(
            NULLIF(BTRIM(d.source_voucher_no), ''),
            NULLIF(BTRIM(h.purchase_requisition_no), '')
          ) IS NOT NULL
      AND NULLIF(BTRIM(h.purchase_order_no), '') IS NOT NULL

    UNION ALL

    SELECT
        COALESCE(
            NULLIF(BTRIM(d.source_voucher_no), ''),
            NULLIF(BTRIM(h.purchase_requisition_no), '')
        ) AS purchase_requisition_no,
        BTRIM(h.purchase_order_no) AS purchase_order_no,
        h.order_date AS po_date,
        'DRAFT' AS po_status,
        regexp_replace(COALESCE(d.line_item_no::text, ''), '\\.0+$', '') AS line_item_no,
        NULLIF(
            regexp_replace(COALESCE(d.source_voucher_line_item_no::text, ''), '\\.0+$', ''),
            '0'
        ) AS source_line_item_no,
        COALESCE(
            NULLIF(BTRIM(d.inventory_code), ''),
            NULLIF(BTRIM(d.service_code), ''),
            NULLIF(BTRIM(d.fixed_asset_code), '')
        ) AS item_code,
        d.qty AS po_qty,
        NULLIF(BTRIM(h.supplier_code), '') AS supplier_code,
        p.party_name AS supplier_name,
        1 AS src_rank
    FROM po_order_new_hdr h
    JOIN po_order_new_det d
      ON d.purchase_order_no = h.purchase_order_no
    LEFT JOIN mt_party p
      ON p.party_code = h.supplier_code
    WHERE COALESCE(
            NULLIF(BTRIM(d.source_voucher_no), ''),
            NULLIF(BTRIM(h.purchase_requisition_no), '')
          ) IS NOT NULL
      AND NULLIF(BTRIM(h.purchase_order_no), '') IS NOT NULL
),
po_lines AS (
    SELECT DISTINCT ON (purchase_order_no, line_item_no, item_key)
        purchase_requisition_no,
        purchase_order_no,
        po_date,
        po_status,
        line_item_no,
        source_line_item_no,
        item_code,
        po_qty,
        supplier_code,
        supplier_name,
        item_key
    FROM (
        SELECT
            po_union.*,
            UPPER(BTRIM(COALESCE(item_code, ''))) AS item_key
        FROM po_union
    ) tagged
    ORDER BY purchase_order_no, line_item_no, item_key, src_rank
),
po_candidates AS (
    SELECT
        pr.purchase_requisition_no,
        pr.line_item_no AS pr_line_item_no,
        pr.item_key AS pr_item_key,
        po.purchase_order_no,
        po.po_date,
        po.po_status,
        po.line_item_no,
        po.po_qty,
        po.supplier_code,
        po.supplier_name,
        po.item_key,
        CASE
            WHEN COALESCE(po.source_line_item_no, '') <> ''
             AND po.source_line_item_no = pr.line_item_no
             AND (
                po.item_key = pr.item_key
                OR pr.item_key = ''
                OR po.item_key = ''
             )
            THEN 0
            WHEN COALESCE(po.source_line_item_no, '') = ''
             AND po.line_item_no = pr.line_item_no
             AND (
                po.item_key = pr.item_key
                OR (pr.item_key = '' AND po.item_key = '')
             )
            THEN 1
            WHEN COALESCE(po.source_line_item_no, '') = ''
             AND pr.item_key <> ''
             AND po.item_key = pr.item_key
            THEN 2
            ELSE NULL
        END AS match_rank
    FROM pr_lines pr
    JOIN po_lines po
      ON po.purchase_requisition_no = pr.purchase_requisition_no
),
po_best AS (
    SELECT
        purchase_requisition_no,
        pr_line_item_no,
        pr_item_key,
        purchase_order_no,
        po_date,
        po_status,
        line_item_no,
        po_qty,
        supplier_code,
        supplier_name,
        item_key
    FROM (
        SELECT
            c.*,
            MIN(c.match_rank) OVER (
                PARTITION BY c.purchase_requisition_no, c.pr_line_item_no, c.pr_item_key
            ) AS best_rank
        FROM po_candidates c
        WHERE c.match_rank IS NOT NULL
    ) ranked
    WHERE match_rank = best_rank
),
qi_ship AS (
    SELECT DISTINCT ON (source_voucher_no)
        source_voucher_no,
        inspection_voucher_no,
        status
    FROM public.zz_jasper_th5_quality_inspection_control_header
    WHERE inspection_voucher_no ~ '^QI[0-9]+$'
      AND source_voucher_no IS NOT NULL
      AND BTRIM(source_voucher_no) <> ''
    ORDER BY source_voucher_no, created_datetime DESC NULLS LAST
),
qi_grn AS (
    SELECT DISTINCT ON (grn_no)
        grn_no,
        inspection_voucher_no,
        status
    FROM public.zz_jasper_th5_quality_inspection_control_header
    WHERE inspection_voucher_no ~ '^QI[0-9]+$'
      AND grn_no IS NOT NULL
      AND BTRIM(grn_no) <> ''
    ORDER BY grn_no, created_datetime DESC NULLS LAST
),
inbound_union AS (
    SELECT
        BTRIM(h.source_voucher_no) AS purchase_order_no,
        h.shipment_voucher_no,
        h.supplier_do_no,
        h.grn_no,
        h.goods_receipt_date,
        regexp_replace(COALESCE(d.line_item_no::text, ''), '\\.0+$', '') AS ship_line_no,
        NULLIF(
            regexp_replace(COALESCE(d.source_voucher_line_item_no::text, ''), '\\.0+$', ''),
            '0'
        ) AS po_line_no,
        UPPER(BTRIM(COALESCE(
            NULLIF(BTRIM(d.inventory_code), ''),
            NULLIF(BTRIM(d.service_code), ''),
            ''
        ))) AS item_key,
        d.qty_received,
        COALESCE(q_ship.inspection_voucher_no, q_grn.inspection_voucher_no) AS qi_voucher_no,
        COALESCE(q_ship.status, q_grn.status) AS qi_status,
        0 AS src_rank
    FROM public.lg_in_shm_ost_hdr h
    JOIN public.lg_in_shm_ost_det d
      ON d.shipment_voucher_no = h.shipment_voucher_no
    LEFT JOIN qi_ship q_ship
      ON q_ship.source_voucher_no = h.shipment_voucher_no
    LEFT JOIN qi_grn q_grn
      ON q_grn.grn_no = h.grn_no
    WHERE COALESCE(BTRIM(h.status), '') <> 'X'
      AND NULLIF(BTRIM(h.source_voucher_no), '') IS NOT NULL
      AND BTRIM(h.source_voucher_no) IN (SELECT purchase_order_no FROM po_best)

    UNION ALL

    SELECT
        BTRIM(h.source_voucher_no) AS purchase_order_no,
        h.shipment_voucher_no,
        h.supplier_do_no,
        h.grn_no,
        h.goods_receipt_date,
        regexp_replace(COALESCE(d.line_item_no::text, ''), '\\.0+$', '') AS ship_line_no,
        NULLIF(
            regexp_replace(COALESCE(d.source_voucher_line_item_no::text, ''), '\\.0+$', ''),
            '0'
        ) AS po_line_no,
        UPPER(BTRIM(COALESCE(
            NULLIF(BTRIM(d.inventory_code), ''),
            NULLIF(BTRIM(d.service_code), ''),
            ''
        ))) AS item_key,
        d.qty_received,
        COALESCE(q_ship.inspection_voucher_no, q_grn.inspection_voucher_no) AS qi_voucher_no,
        COALESCE(q_ship.status, q_grn.status) AS qi_status,
        1 AS src_rank
    FROM public.lg_in_shm_hst_hdr h
    JOIN public.lg_in_shm_hst_det d
      ON d.shipment_voucher_no = h.shipment_voucher_no
    LEFT JOIN qi_ship q_ship
      ON q_ship.source_voucher_no = h.shipment_voucher_no
    LEFT JOIN qi_grn q_grn
      ON q_grn.grn_no = h.grn_no
    WHERE COALESCE(BTRIM(h.status), '') <> 'X'
      AND NULLIF(BTRIM(h.source_voucher_no), '') IS NOT NULL
      AND BTRIM(h.source_voucher_no) IN (SELECT purchase_order_no FROM po_best)
),
inbound AS (
    SELECT DISTINCT ON (purchase_order_no, shipment_voucher_no, ship_line_no, item_key)
        purchase_order_no,
        shipment_voucher_no,
        supplier_do_no,
        grn_no,
        goods_receipt_date,
        po_line_no,
        item_key,
        qty_received,
        qi_voucher_no,
        qi_status
    FROM inbound_union
    ORDER BY purchase_order_no, shipment_voucher_no, ship_line_no, item_key, src_rank
)
SELECT
    pr.purchase_requisition_no,
    pr.line_item_no,
    pr.pr_date,
    pr.item_code,
    pr.description,
    pr.qty,
    COALESCE(po.supplier_code, pr.supplier_code) AS supplier_code,
    COALESCE(po.supplier_name, pr.supplier_name) AS supplier_name,
    pr.sbu_code,
    pr.segment_1_code,
    pr.segment_desc,
    pr.project_no,
    po.purchase_order_no,
    po.po_date,
    po.po_status,
    po.po_qty,
    ib.shipment_voucher_no,
    ib.supplier_do_no,
    ib.grn_no,
    ib.goods_receipt_date,
    ib.qty_received,
    ib.qi_voucher_no,
    ib.qi_status
FROM pr_lines pr
LEFT JOIN po_best po
  ON po.purchase_requisition_no = pr.purchase_requisition_no
 AND po.pr_line_item_no = pr.line_item_no
 AND po.pr_item_key = pr.item_key
LEFT JOIN inbound ib
  ON ib.purchase_order_no = po.purchase_order_no
 AND (
      (
        NULLIF(ib.po_line_no, '') IS NOT NULL
        AND ib.po_line_no = po.line_item_no
      )
      OR (
        NULLIF(ib.po_line_no, '') IS NULL
        AND po.item_key <> ''
        AND ib.item_key = po.item_key
      )
 )
ORDER BY
    pr.pr_date DESC NULLS LAST,
    pr.purchase_requisition_no,
    pr.line_item_no,
    po.purchase_order_no,
    ib.grn_no
"""

_SBU_SQL = """
SELECT DISTINCT NULLIF(BTRIM(sbu_code), '') AS sbu_code
FROM mt_sbu
WHERE NULLIF(BTRIM(sbu_code), '') IS NOT NULL
  AND COALESCE(NULLIF(BTRIM(status), ''), 'A') = 'A'
ORDER BY 1
"""


def overview_sql() -> str:
    return _SQL


def parse_sbus(raw: str | None) -> tuple[bool, list[str]]:
    """Return (all_sbus, codes). Blank means the page default, MFG. '*' is every SBU."""
    text = compact_text(raw)
    if not text:
        return False, ["MFG"]
    if text == "*":
        return True, []
    codes: list[str] = []
    seen: set[str] = set()
    for part in text.split(","):
        code = part.strip().upper()
        if not code or code in seen:
            continue
        if not _SBU_CODE_RE.fullmatch(code):
            raise ValueError(code)
        seen.add(code)
        codes.append(code)
    if not codes:
        return False, ["MFG"]
    if len(codes) > 20:
        raise ValueError("too many")
    return False, codes


OVERVIEW_STAGES = (
    "PR",
    "PO draft",
    "PO pushed",
    "PO under variation",
    "PO completed",
    "Waiting for GRN",
    "GRN",
    "QI",
)


def chain_status(row: dict[str, Any]) -> str:
    """Latest document on the line, in purchasing order."""
    if compact_text(row.get("qi_voucher_no")):
        return "QI"
    if compact_text(row.get("grn_no")):
        return "GRN"
    if compact_text(row.get("shipment_voucher_no")):
        return "Waiting for GRN"
    if compact_text(row.get("purchase_order_no")):
        code = compact_text(row.get("po_status")).upper()
        if code == "U":
            return "PO under variation"
        if code == "C":
            return "PO completed"
        if code == "O":
            return "PO pushed"
        return "PO draft"
    return "PR"


def _with_status(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for row in rows:
        row["status"] = chain_status(row)
    return rows


def _status_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {stage: 0 for stage in OVERVIEW_STAGES}
    for row in rows:
        status = chain_status(row)
        counts[status] = counts.get(status, 0) + 1
    return counts


def cache_key(all_sbus: bool, codes: list[str]) -> str:
    if all_sbus:
        return "*"
    return ",".join(codes)


def invalidate_material_tracking_overview_cache() -> None:
    global _sbus_cache
    _rows_cache.clear()
    _sbus_cache = None


def _fetch_rows(all_sbus: bool, codes: list[str], *, refresh: bool = False) -> list[dict[str, Any]]:
    key = cache_key(all_sbus, codes)
    now = time.time()
    cached = _rows_cache.get(key)
    if not refresh and cached and (now - cached[0]) < _CACHE_TTL_SEC:
        return cached[1]

    fetched = live_query(
        overview_sql(),
        (all_sbus, codes or [""]),
        timeout_ms=_QUERY_TIMEOUT_MS,
    )
    rows = _with_status(fetched)
    _rows_cache[key] = (now, rows)
    return rows


def _fetch_sbus(*, refresh: bool = False) -> list[str]:
    global _sbus_cache
    now = time.time()
    if not refresh and _sbus_cache and (now - _sbus_cache[0]) < _CACHE_TTL_SEC:
        return _sbus_cache[1]
    try:
        fetched = live_query(_SBU_SQL, timeout_ms=30000)
    except Exception:
        logger.exception("material tracking overview SBU list failed")
        return _sbus_cache[1] if _sbus_cache else []
    codes = []
    seen: set[str] = set()
    for row in fetched:
        code = compact_text(row.get("sbu_code")).upper()
        if not code or code in seen:
            continue
        seen.add(code)
        codes.append(code)
    codes.sort()
    _sbus_cache = (now, codes)
    return codes


@material_tracking_overview_bp.get("/api/material-tracking/overview")
def api_material_tracking_overview():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    try:
        all_sbus, codes = parse_sbus(request.args.get("sbu"))
    except ValueError as exc:
        return jsonify({"error": f"invalid sbu '{exc}'"}), 400

    try:
        rows = _fetch_rows(all_sbus, codes, refresh=refresh)
    except Exception as exc:
        logger.exception("material tracking overview ERP query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    sbus = _fetch_sbus(refresh=refresh)
    key = cache_key(all_sbus, codes)
    cached = _rows_cache.get(key)
    cached_at = cached[0] if cached else time.time()

    return jsonify(
        {
            "ok": True,
            "sbu": ["*"] if all_sbus else codes,
            "source": _SOURCE,
            "count": len(rows),
            "counts": _status_counts(rows),
            "sbus": sbus,
            "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": rows,
        }
    )
