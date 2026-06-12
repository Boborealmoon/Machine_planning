"""Join pp_vouchers_cache with mfg_wo_status for authoritative per-partial WO fields."""

MFG_WO_STATUS_STAGE_JOIN = """
       ON ws.source_mps_no = c.ps_id
      AND ws.pp_partial_no = c.pp_partial_no
      AND ws.stage_no = c.stage_no
      AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
"""

ERP_STAGE_OUTPUTS_CTE = """
    erp_stage_outputs AS (
        SELECT c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc,
               MAX(COALESCE(ws.wo_qty_required, c.wo_qty_required)) AS wo_qty_required,
               MAX(COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced)) AS wo_qty_produced,
               MAX(COALESCE(ws.total_rej_qty_produced, c.wo_qty_rejected)) AS wo_qty_rejected,
               MAX(COALESCE(NULLIF(TRIM(ws.execution_status), ''), c.execution_status)) AS execution_status
        FROM pp_vouchers_cache c
        LEFT JOIN mfg_wo_status ws
               ON ws.source_mps_no = c.ps_id
              AND ws.pp_partial_no = c.pp_partial_no
              AND ws.stage_no = c.stage_no
              AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
        WHERE c.stage_no IS NOT NULL
        GROUP BY c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc
    )
"""

PP_VOUCHERS_CACHE_DIRECT_FROM = """
FROM pp_vouchers_cache c
"""

PP_VOUCHERS_CACHE_DIRECT_SELECT = """
    c.ps_id,
    c.pp_partial_no,
    c.part_no,
    c.description,
    c.total_qty,
    c.partial_qty,
    c.due_date,
    c.order_date,
    c.bom_code,
    c.source_voucher_no,
    c.source_line_item_no,
    c.qty_shipped,
    c.so_det_qty,
    c.status,
    c.execution_status,
    c.wo_qty_required,
    c.wo_qty_produced,
    c.wo_qty_rejected,
    c.stage_no,
    c.stage_desc,
    c.op_no,
    c.current_stage_no,
    c.current_stage_desc,
    c.current_stage_status
"""

PP_VOUCHERS_CACHE_WO_MERGE_FROM = """
FROM pp_vouchers_cache c
LEFT JOIN mfg_wo_status ws
       ON ws.source_mps_no = c.ps_id
      AND ws.pp_partial_no = c.pp_partial_no
      AND ws.stage_no = c.stage_no
      AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
"""

PP_VOUCHERS_CACHE_WO_MERGE_SELECT = """
    c.ps_id,
    c.pp_partial_no,
    c.part_no,
    c.description,
    c.total_qty,
    c.partial_qty,
    c.due_date,
    c.order_date,
    c.bom_code,
    c.source_voucher_no,
    c.source_line_item_no,
    c.qty_shipped,
    c.so_det_qty,
    c.status,
    COALESCE(NULLIF(TRIM(ws.execution_status), ''), c.execution_status) AS execution_status,
    COALESCE(ws.wo_qty_required, c.wo_qty_required) AS wo_qty_required,
    COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced) AS wo_qty_produced,
    COALESCE(ws.total_rej_qty_produced, c.wo_qty_rejected) AS wo_qty_rejected,
    c.stage_no,
    c.stage_desc,
    c.op_no,
    c.current_stage_no,
    c.current_stage_desc,
    c.current_stage_status
"""

ERP_CACHE_STEPS_SELECT = """
    SELECT c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc, c.op_no,
           MAX(COALESCE(ws.wo_qty_required, c.wo_qty_required)) AS wo_qty_required,
           MAX(COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced)) AS wo_qty_produced,
           MAX(COALESCE(ws.total_rej_qty_produced, c.wo_qty_rejected)) AS wo_qty_rejected,
           MAX(COALESCE(NULLIF(TRIM(ws.execution_status), ''), c.execution_status)) AS execution_status
    FROM pp_vouchers_cache c
    LEFT JOIN mfg_wo_status ws
           ON ws.source_mps_no = c.ps_id
          AND ws.pp_partial_no = c.pp_partial_no
          AND ws.stage_no = c.stage_no
          AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
"""

ERP_CACHE_STEPS_WHERE_PARTIALS = """
    WHERE (c.ps_id, c.pp_partial_no) IN ({values_sql})
      AND NULLIF(TRIM(COALESCE(c.stage_desc, '')), '') IS NOT NULL
    GROUP BY c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc, c.op_no
    ORDER BY c.ps_id, c.pp_partial_no, c.stage_no, c.op_no
"""

ERP_CACHE_STEPS_WHERE_SINGLE = """
    WHERE c.ps_id = %s
      AND c.pp_partial_no = %s
      AND NULLIF(TRIM(COALESCE(c.stage_desc, '')), '') IS NOT NULL
    GROUP BY c.ps_id, c.pp_partial_no, c.stage_no, c.stage_desc, c.op_no
    ORDER BY c.stage_no, c.op_no
"""
