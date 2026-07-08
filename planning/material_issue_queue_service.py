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
    assembly = material_issue_assembly_stage_sql_match
    prefix_sql = _queue_ps_prefix_sql("c.ps_id")
    open_wo = "COALESCE(ws0.execution_status, '') NOT IN ('C', 'Completed')"
    sql = f"""
WITH tagged_partials AS (
    SELECT DISTINCT ON (c.ps_id, c.pp_partial_no)
        c.ps_id,
        c.pp_partial_no,
        COALESCE(
            CASE WHEN {assembly("c.current_stage_desc")} THEN c.current_stage_no END,
            (
                SELECT ws0.stage_no
                FROM mfg_wo_status ws0
                WHERE ws0.source_mps_no = c.ps_id
                  AND ws0.pp_partial_no = c.pp_partial_no
                  AND {assembly("ws0.stage_desc")}
                  AND {open_wo}
                ORDER BY
                    CASE ws0.execution_status
                        WHEN 'I' THEN 0 WHEN 'R' THEN 1 WHEN 'P' THEN 2 ELSE 3
                    END,
                    ws0.stage_no
                LIMIT 1
            )
        ) AS current_stage_no,
        COALESCE(
            NULLIF(
                CASE WHEN {assembly("c.current_stage_desc")}
                     THEN TRIM(COALESCE(c.current_stage_desc, '')) END,
                ''
            ),
            (
                SELECT TRIM(COALESCE(ws0.stage_desc, ''))
                FROM mfg_wo_status ws0
                WHERE ws0.source_mps_no = c.ps_id
                  AND ws0.pp_partial_no = c.pp_partial_no
                  AND {assembly("ws0.stage_desc")}
                  AND {open_wo}
                ORDER BY
                    CASE ws0.execution_status
                        WHEN 'I' THEN 0 WHEN 'R' THEN 1 WHEN 'P' THEN 2 ELSE 3
                    END,
                    ws0.stage_no
                LIMIT 1
            )
        ) AS current_stage_desc,
        COALESCE(
            NULLIF(
                CASE WHEN {assembly("c.current_stage_desc")}
                     THEN c.current_stage_status END,
                ''
            ),
            (
                SELECT ws0.execution_status
                FROM mfg_wo_status ws0
                WHERE ws0.source_mps_no = c.ps_id
                  AND ws0.pp_partial_no = c.pp_partial_no
                  AND {assembly("ws0.stage_desc")}
                  AND {open_wo}
                ORDER BY
                    CASE ws0.execution_status
                        WHEN 'I' THEN 0 WHEN 'R' THEN 1 WHEN 'P' THEN 2 ELSE 3
                    END,
                    ws0.stage_no
                LIMIT 1
            )
        ) AS current_stage_status,
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
    WHERE {prefix_sql}
      AND (
          c.so_det_qty IS NULL
          OR COALESCE(c.qty_shipped, 0) < (c.so_det_qty - {SHIPPED_QTY_TOLERANCE})
      )
      AND (
          {assembly("c.current_stage_desc")}
          OR EXISTS (
              SELECT 1
              FROM mfg_wo_status ws0
              WHERE ws0.source_mps_no = c.ps_id
                AND ws0.pp_partial_no = c.pp_partial_no
                AND {assembly("ws0.stage_desc")}
                AND {open_wo}
          )
      )
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
)
SELECT
    tp.ps_id,
    tp.pp_partial_no,
    tp.current_stage_no,
    tp.current_stage_desc,
    tp.current_stage_status,
    ws.wo_qty_required AS stage_qty_required,
    ws.total_acc_qty_produced AS stage_qty_produced,
    ws.total_rej_qty_produced AS stage_qty_rejected,
    tp.part_no,
    tp.part_desc,
    tp.bom_code,
    tp.sales_order_no,
    tp.sales_order_line,
    tp.due_date,
    tp.qty,
    tp.qty_shipped,
    tp.so_det_qty,
    tp.pp_status,
    p.coway_proposed_edd,
    p.material_in,
    p.remarks
FROM tagged_partials tp
LEFT JOIN mfg_wo_status ws
       ON ws.source_mps_no = tp.ps_id
      AND ws.pp_partial_no = tp.pp_partial_no
      AND ws.stage_no = tp.current_stage_no
LEFT JOIN planner_process_sheet p
       ON p.source_ps_id = tp.ps_id
      AND p.pp_partial_no = tp.pp_partial_no
ORDER BY
    CASE tp.current_stage_status
        WHEN 'I' THEN 0
        WHEN 'R' THEN 1
        WHEN 'P' THEN 2
        ELSE 3
    END,
    tp.due_date NULLS LAST,
    tp.ps_id,
    tp.pp_partial_no
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
