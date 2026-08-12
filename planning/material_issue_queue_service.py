"""PP partials at an assembly-related ERP WO stage (Mat issue & assy tab).

Includes jobs whose current stage tag or any open WO stage contains the word
assembly. Not filtered by planner machine-lane queue.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from planning.erp_wo_merge import (
    is_material_issue_assembly_stage_desc,
    material_issue_assembly_stage_sql_match,
)
from planning.helpers import rows
from planning.process_sheets import format_planner_ps_id
from planning.utils import SHIPPED_QTY_TOLERANCE, compact_text, shipped_quantity_completed
from sync import _pp_ps_id_prefix_params, _pp_ps_id_prefix_sql

_TEMP_PS_PREFIX_LIKE = "[Temp]%"


def _queue_ps_prefix_sql(column: str) -> str:
    return f"({_pp_ps_id_prefix_sql(column)} OR {column} LIKE %s)"


def _queue_ps_prefix_params() -> tuple:
    return _pp_ps_id_prefix_params() + (_TEMP_PS_PREFIX_LIKE,)


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


def _is_open_for_material_issue_list(item: dict[str, Any]) -> bool:
    if not is_material_issue_assembly_stage_desc(item.get("current_stage_desc")):
        return False
    so_qty = item.get("so_det_qty")
    if so_qty is None:
        return True
    return not shipped_quantity_completed(so_qty, item.get("qty_shipped"))


def _build_material_issue_list_sql() -> tuple[str, tuple]:
    """Open assembly-stage partials — start from mfg_wo_status (not full voucher scan)."""
    assembly = material_issue_assembly_stage_sql_match
    prefix_sql = _queue_ps_prefix_sql("ws.source_mps_no")
    sql = f"""
WITH assembly_open AS (
    SELECT DISTINCT ON (ws.source_mps_no, ws.pp_partial_no)
        ws.source_mps_no AS ps_id,
        ws.pp_partial_no,
        ws.stage_no AS current_stage_no,
        TRIM(COALESCE(ws.stage_desc, '')) AS current_stage_desc,
        ws.execution_status AS current_stage_status,
        ws.wo_qty_required AS stage_qty_required,
        ws.total_acc_qty_produced AS stage_qty_produced,
        ws.total_rej_qty_produced AS stage_qty_rejected
    FROM mfg_wo_status ws
    WHERE COALESCE(ws.execution_status, '') NOT IN ('C', 'Completed', '')
      AND ws.stage_no IS NOT NULL
      AND NULLIF(TRIM(COALESCE(ws.stage_desc, '')), '') IS NOT NULL
      AND {assembly("ws.stage_desc")}
      AND {prefix_sql}
    ORDER BY
        ws.source_mps_no,
        ws.pp_partial_no,
        CASE ws.execution_status
            WHEN 'I' THEN 0
            WHEN 'R' THEN 1
            WHEN 'P' THEN 2
            ELSE 3
        END,
        COALESCE(ws.total_acc_qty_produced, 0) DESC,
        ws.stage_no ASC
),
partial_meta AS (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.ps_id,
        c.pp_partial_no,
        c.part_no,
        c.description AS part_desc,
        c.bom_code,
        c.source_voucher_no AS sales_order_no,
        c.source_line_item_no AS sales_order_line,
        c.due_date,
        COALESCE(NULLIF(c.partial_qty, 0), c.total_qty) AS qty,
        c.qty_shipped,
        c.so_det_qty,
        c.status AS pp_status
    FROM pp_vouchers_cache c
    INNER JOIN assembly_open ao
            ON ao.ps_id = c.ps_id
           AND ao.pp_partial_no = c.pp_partial_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
)
SELECT
    ao.ps_id,
    ao.pp_partial_no,
    ao.current_stage_no,
    ao.current_stage_desc,
    ao.current_stage_status,
    ao.stage_qty_required,
    ao.stage_qty_produced,
    ao.stage_qty_rejected,
    m.part_no,
    m.part_desc,
    m.bom_code,
    m.sales_order_no,
    m.sales_order_line,
    m.due_date,
    m.qty,
    m.qty_shipped,
    m.so_det_qty,
    m.pp_status,
    p.coway_proposed_edd,
    p.material_in,
    p.remarks
FROM assembly_open ao
LEFT JOIN partial_meta m
       ON m.ps_id = ao.ps_id
      AND m.pp_partial_no = ao.pp_partial_no
LEFT JOIN planner_process_sheet p
       ON p.source_ps_id = ao.ps_id
      AND p.pp_partial_no = ao.pp_partial_no
WHERE m.so_det_qty IS NULL
   OR COALESCE(m.qty_shipped, 0) < (m.so_det_qty - {SHIPPED_QTY_TOLERANCE})
ORDER BY
    CASE ao.current_stage_status
        WHEN 'I' THEN 0
        WHEN 'R' THEN 1
        WHEN 'P' THEN 2
        ELSE 3
    END,
    m.due_date NULLS LAST,
    ao.ps_id,
    ao.pp_partial_no
"""
    return sql, _queue_ps_prefix_params()


def fetch_material_issue_queue(con) -> list[dict[str, Any]]:
    sql, params = _build_material_issue_list_sql()
    items: list[dict[str, Any]] = []
    for row in rows(con.execute(sql, params)):
        item = _serialize_row(dict(row))
        if not _is_open_for_material_issue_list(item):
            continue
        ps_id = compact_text(item.get("ps_id"))
        partial = int(item.get("pp_partial_no") or 1)
        item["planner_ps_id"] = format_planner_ps_id(ps_id, partial)
        so_qty = item.get("so_det_qty")
        shipped = float(item.get("qty_shipped") or 0)
        item["shipped_completed"] = (
            so_qty is not None and shipped_quantity_completed(so_qty, shipped)
        )
        items.append(item)
    return items
