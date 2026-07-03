"""Live COMAIN reads for PP voucher partial summaries (delivery schedule)."""
from __future__ import annotations

from typing import Any

from .staged_erp import live_query
from .utils import compact_text, SHIPPED_QTY_TOLERANCE

# Partial-level aggregates matching delivery schedule needs (same shape as pp_vouchers_cache CTE).
_LIVE_VOUCHER_PARTIALS_SQL = """
WITH ps_info AS (
    SELECT
        pp_voucher_no,
        process_sheet_no AS ps_id,
        inventory_code,
        total_qty,
        sales_order_date
    FROM public.mfg_process_sheet_info_v1_view
),
pp_base AS (
    SELECT
        COALESCE(ps.ps_id, v.pp_voucher_no) AS ps_id,
        COALESCE(prt.pp_partial_no, 1) AS pp_partial_no,
        COALESCE(ps.inventory_code, v.inventory_code) AS part_no,
        COALESCE(
            NULLIF(TRIM(pd.main_desc), ''),
            NULLIF(TRIM(v.bom_desc), '')
        ) AS description,
        COALESCE(det.required_shipment_date, v.source_rsd) AS due_date,
        v.status AS pp_status,
        COALESCE(
            NULLIF(prt.partial_qty, 0),
            ps.total_qty,
            v.pp_qty
        ) AS partial_qty,
        COALESCE(ps.total_qty, v.pp_qty) AS total_qty,
        det.qty AS so_det_qty,
        COALESCE(sq.qty_shipped, 0) AS qty_shipped
    FROM public.mfg_pp_vch v
    LEFT JOIN ps_info ps ON ps.pp_voucher_no = v.pp_voucher_no
    LEFT JOIN public.mfg_pp_partial prt ON prt.pp_voucher_no = v.pp_voucher_no
    LEFT JOIN public.so_order_ost_det det
           ON det.sales_order_no = v.source_voucher_no
          AND regexp_replace(det.line_item_no::TEXT, '\\.0+$', '')
              = regexp_replace(v.source_line_item_no::TEXT, '\\.0+$', '')
    LEFT JOIN public.sum_qty_shipped_by_sales_order sq
           ON sq.sales_order_no = v.source_voucher_no
          AND regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
              = regexp_replace(v.source_line_item_no::TEXT, '\\.0+$', '')
    LEFT JOIN public.mt_inventory pd ON pd.inventory_code = COALESCE(ps.inventory_code, v.inventory_code)
    WHERE COALESCE(ps.ps_id, v.pp_voucher_no) IS NOT NULL
      AND (
          COALESCE(ps.ps_id, v.pp_voucher_no) LIKE '%%MPS%%'
          OR COALESCE(ps.ps_id, v.pp_voucher_no) LIKE '%%APS%%'
          OR COALESCE(ps.ps_id, v.pp_voucher_no) LIKE '%%NPS%%'
          OR COALESCE(ps.ps_id, v.pp_voucher_no) LIKE '%%PPS%%'
          OR COALESCE(ps.ps_id, v.pp_voucher_no) LIKE '%%CPS%%'
          OR COALESCE(ps.ps_id, v.pp_voucher_no) LIKE '%%[SR]%%'
      )
),
wo_rows AS (
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
        t3.total_acc_qty_produced
    FROM mfg_mps_vch t2
    JOIN mfg_wo_vch t3
      ON t2.wo_voucher_no = t3.voucher_no
     AND t2.stage_no = t3.stage_no
    LEFT JOIN (
        SELECT DISTINCT ON (pp_voucher_no, partial_qty)
            pp_voucher_no,
            partial_qty,
            pp_partial_no
        FROM public.mfg_pp_partial
        WHERE pp_voucher_no IS NOT NULL
        ORDER BY pp_voucher_no, partial_qty, pp_partial_no
    ) pp
      ON pp.pp_voucher_no = t2.source_pp_no
     AND pp.partial_qty = t3.wo_qty_required
     AND COALESCE(t2.source_pp_partial_no, 0) = 0
    WHERE t2.source_pp_no IS NOT NULL
      AND t2.stage_no IS NOT NULL
),
wo_by_partial AS (
    SELECT
        b.ps_id,
        b.pp_partial_no,
        MAX(
            CASE wr.execution_status
                WHEN 'P' THEN 'Pending SI'
                WHEN 'R' THEN 'Ready to Start'
                WHEN 'I' THEN 'In Process'
                WHEN 'C' THEN 'Completed'
                ELSE wr.execution_status
            END
        ) AS execution_status,
        BOOL_AND(UPPER(COALESCE(wr.execution_status, '')) IN ('C', 'COMPLETED')) AS execution_completed
    FROM pp_base b
    LEFT JOIN wo_rows wr
           ON wr.ps_base = b.ps_id
          AND wr.pp_partial_no = b.pp_partial_no
    GROUP BY b.ps_id, b.pp_partial_no
),
current_stage AS (
    SELECT DISTINCT ON (ps_base, pp_partial_no)
        ps_base AS ps_id,
        pp_partial_no,
        stage_no AS current_stage_no,
        stage_desc AS current_stage_desc,
        execution_status AS current_stage_status
    FROM wo_rows
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
)
SELECT
    b.ps_id,
    b.pp_partial_no,
    MAX(b.part_no) AS part_no,
    MAX(b.description) AS description,
    MIN(b.due_date) AS due_date,
    MAX(b.pp_status) AS status,
    MAX(w.execution_status) AS execution_status,
    MAX(b.total_qty) AS total_qty,
    MAX(b.partial_qty) AS partial_qty,
    MAX(b.qty_shipped) AS qty_shipped,
    MAX(b.so_det_qty) AS so_det_qty,
    MAX(cs.current_stage_no) AS current_stage_no,
    MAX(cs.current_stage_desc) AS current_stage_desc,
    MAX(cs.current_stage_status) AS current_stage_status,
    COALESCE(BOOL_AND(w.execution_completed), FALSE) AS execution_completed
FROM pp_base b
LEFT JOIN wo_by_partial w
       ON w.ps_id = b.ps_id
      AND w.pp_partial_no = b.pp_partial_no
LEFT JOIN current_stage cs
       ON cs.ps_id = b.ps_id
      AND cs.pp_partial_no = b.pp_partial_no
{where_clause}
GROUP BY b.ps_id, b.pp_partial_no
ORDER BY b.ps_id, b.pp_partial_no
"""


def _shipped_complete(row: dict[str, Any]) -> bool:
    so_qty = row.get("so_det_qty")
    if so_qty is None:
        return False
    try:
        shipped = float(row.get("qty_shipped") or 0)
        required = float(so_qty)
    except (TypeError, ValueError):
        return False
    return shipped >= required - SHIPPED_QTY_TOLERANCE


def fetch_live_voucher_partials(
    *,
    ps_ids: list[str] | None = None,
    search: str = "",
    include_completed: bool = False,
) -> dict[tuple[str, int], dict[str, Any]]:
    """Return {(ps_id, pp_partial_no): row} from live COMAIN."""
    where_parts: list[str] = []
    params: list[Any] = []

    if ps_ids:
        where_parts.append("b.ps_id = ANY(%s)")
        params.append([compact_text(ps_id) for ps_id in ps_ids if compact_text(ps_id)])

    needle = compact_text(search).lower()
    if needle:
        pattern = f"%{needle}%"
        where_parts.append(
            """(
                LOWER(b.ps_id) LIKE %s
                OR LOWER(COALESCE(b.part_no, '')) LIKE %s
                OR LOWER(COALESCE(b.description, '')) LIKE %s
                OR LOWER(b.pp_partial_no::TEXT) LIKE %s
            )"""
        )
        params.extend([pattern, pattern, pattern, pattern])

    where_clause = ""
    if where_parts:
        where_clause = "WHERE " + " AND ".join(where_parts)

    sql = _LIVE_VOUCHER_PARTIALS_SQL.format(where_clause=where_clause)
    rows = live_query(sql, tuple(params))

    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows:
        ps_id = compact_text(row.get("ps_id"))
        if not ps_id:
            continue
        try:
            partial_no = max(1, int(row.get("pp_partial_no") or 1))
        except (TypeError, ValueError):
            partial_no = 1
        if not include_completed and _shipped_complete(row):
            continue
        out[(ps_id, partial_no)] = row
    return out
