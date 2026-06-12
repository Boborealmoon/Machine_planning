"""Shared SQL fragments for catalog queries over pp_vouchers_cache."""


def catalog_voucher_partials_cte(*, include_current_stage: bool) -> str:
    stage_cols = (
        """
                       MAX(current_stage_no) AS current_stage_no,
                       MAX(current_stage_desc) AS current_stage_desc,
                       MAX(current_stage_status) AS current_stage_status,"""
        if include_current_stage
        else ""
    )
    return f"""
            voucher_partials AS (
                SELECT ps_id, pp_partial_no,
                       MAX(part_no) AS part_no,
                       MAX(description) AS description,
                       MIN(due_date) AS due_date,
                       MAX(status) AS erp_status,
                       MAX(execution_status) AS execution_status,{stage_cols}
                       MAX(total_qty) AS total_qty,
                       MAX(partial_qty) AS partial_qty,
                       MAX(source_line_item_no) AS source_line_item_no,
                       MAX(wo_qty_produced) AS wo_qty_produced,
                       MAX(wo_qty_rejected) AS wo_qty_rejected,
                       MAX(qty_shipped) AS qty_shipped,
                       MAX(bom_code) AS erp_bom_code
                FROM pp_vouchers_cache
                GROUP BY ps_id, pp_partial_no
            )"""


CATALOG_VOUCHER_STAGE_OUTPUTS_CTE = """
            voucher_stage_outputs AS (
                SELECT ps_id, pp_partial_no, stage_no, stage_desc,
                       MAX(wo_qty_required) AS wo_qty_required,
                       MAX(wo_qty_produced) AS wo_qty_produced,
                       MAX(wo_qty_rejected) AS wo_qty_rejected,
                       MAX(execution_status) AS execution_status
                FROM pp_vouchers_cache
                WHERE stage_no IS NOT NULL
                GROUP BY ps_id, pp_partial_no, stage_no, stage_desc
            )"""


CATALOG_VOUCHER_OP_OUTPUTS_CTE = """
            voucher_op_outputs AS (
                SELECT ps_id, pp_partial_no,
                       TRIM(COALESCE(op_no::text, '')) AS op_no_text,
                       MAX(wo_qty_produced) AS wo_qty_produced,
                       MAX(wo_qty_rejected) AS wo_qty_rejected,
                       MAX(execution_status) AS execution_status
                FROM pp_vouchers_cache
                WHERE NULLIF(TRIM(COALESCE(op_no::text, '')), '') IS NOT NULL
                GROUP BY ps_id, pp_partial_no, TRIM(COALESCE(op_no::text, ''))
            )"""


def catalog_source_totals_cte(*, include_current_stage: bool) -> str:
    stage_cols = (
        """
                       MAX(current_stage_no) AS current_stage_no,
                       MAX(current_stage_desc) AS current_stage_desc,
                       MAX(current_stage_status) AS current_stage_status,"""
        if include_current_stage
        else ""
    )
    return f"""
            source_totals AS (
                SELECT ps_id,
                       COALESCE(
                           MAX(NULLIF(total_qty, 0)),
                           SUM(COALESCE(NULLIF(partial_qty, 0), 0))
                       ) AS rolled_total_qty,
                       MAX(wo_qty_produced) AS wo_qty_produced,
                       MAX(wo_qty_rejected) AS wo_qty_rejected,
                       MAX(source_line_item_no) AS source_line_item_no,
                       MAX(part_no) AS part_no,
                       MAX(description) AS description,
                       MIN(due_date) AS due_date,
                       MAX(erp_status) AS erp_status,
                       MAX(execution_status) AS execution_status,{stage_cols}
                       MAX(qty_shipped) AS qty_shipped
                FROM voucher_partials
                GROUP BY ps_id
            )"""


CATALOG_PLANNER_SOURCE_TOTALS_CTE = """
            planner_source_totals AS (
                SELECT source_ps_id, SUM(COALESCE(planned_qty, 0)) AS planned_qty
                FROM planner_process_sheet
                GROUP BY source_ps_id
            )"""


def catalog_erp_cache_with_clause(*, assigned: bool) -> str:
    """WITH clause prefix for trial_catalog_items ERP rollups."""
    parts = [
        catalog_voucher_partials_cte(include_current_stage=assigned),
    ]
    if assigned:
        parts.extend([CATALOG_VOUCHER_STAGE_OUTPUTS_CTE, CATALOG_VOUCHER_OP_OUTPUTS_CTE])
    parts.extend(
        [
            catalog_source_totals_cte(include_current_stage=assigned),
            CATALOG_PLANNER_SOURCE_TOTALS_CTE,
        ]
    )
    return "WITH " + ",\n".join(parts)
