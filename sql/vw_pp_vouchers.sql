-- Canonical vw_pp_vouchers definition (PP voucher pipeline join).
-- Applied by planning.pp_staging_sql.apply_vw_pp_vouchers() — not on every sync.

CREATE OR REPLACE VIEW public.vw_pp_vouchers AS
WITH
joined AS (
    SELECT
        b.pp_voucher_no,
        b.inventory_code,
        b.bom_code,
        b.pp_qty,
        b.source_voucher_no,
        b.source_rsd,
        regexp_replace(b.source_line_item_no::TEXT, '\.0+$', '') AS source_line_item_no,
        b.status,
        b.stage_no,
        b.stage_desc,
        b.op_no,
        ps.process_sheet_no                                 AS ps_id_raw,
        ps.inventory_code                                   AS ps_inventory_code,
        ps.total_qty                                        AS ps_total_qty,
        ps.sales_order_date                                 AS ps_order_date,
        COALESCE(ps.process_sheet_no, b.pp_voucher_no)      AS ps_id,
        CASE WHEN ps.process_sheet_no IS NOT NULL
             THEN ps.inventory_code
             ELSE b.inventory_code
        END                                                 AS final_inventory_code
    FROM public.pp_voucher b
    LEFT JOIN public.mfg_process_sheet_info ps
           ON b.pp_voucher_no = ps.pp_voucher_no
),
filtered AS (
    SELECT *
    FROM joined
    WHERE ps_id LIKE '%MPS%'
       OR ps_id LIKE '%APS%'
       OR ps_id LIKE '%NPS%'
       OR ps_id LIKE '%PPS%'
       OR ps_id LIKE '%CPS%'
       OR ps_id LIKE '%[SR]%'
),
with_workorder AS (
    SELECT
        f.*,
        wa.ws_item_qty,
        wa.ws_status
    FROM filtered f
    LEFT JOIN (
        SELECT
            source_voucher_no,
            source_voucher_line_item_no,
            MIN(item_qty) AS ws_item_qty,
            MIN(status)   AS ws_status
        FROM public.workorder_status
        GROUP BY source_voucher_no, source_voucher_line_item_no
    ) wa
           ON f.source_voucher_no  = wa.source_voucher_no
          AND f.source_line_item_no = wa.source_voucher_line_item_no
),
with_shipped AS (
    SELECT
        ww.*,
        sq.qty_shipped
    FROM with_workorder ww
    LEFT JOIN public.sum_qty_shipped_by_sales_order sq
           ON ww.source_voucher_no = sq.sales_order_no
          AND regexp_replace(ww.source_line_item_no::TEXT, '\.0+$', '') = regexp_replace(sq.line_item_no::TEXT, '\.0+$', '')
),
so_detail_by_line AS (
    SELECT
        sales_order_no,
        regexp_replace(line_item_no::TEXT, '\.0+$', '') AS line_item_no,
        MAX(qty) AS so_qty,
        MAX(required_shipment_date) AS required_shipment_date
    FROM public.so_detail
    WHERE sales_order_no IS NOT NULL
      AND line_item_no IS NOT NULL
    GROUP BY sales_order_no, regexp_replace(line_item_no::TEXT, '\.0+$', '')
),
with_so_detail AS (
    SELECT
        ww.*,
        sd.so_qty,
        sd.required_shipment_date
    FROM with_shipped ww
    LEFT JOIN so_detail_by_line sd
           ON sd.sales_order_no = ww.source_voucher_no
          AND sd.line_item_no = regexp_replace(ww.source_line_item_no::TEXT, '\.0+$', '')
),
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw,
        COALESCE(
            NULLIF(TRIM(ppd.customer_po_no), ''),
            NULLIF(TRIM(hdr.customer_po_no), '')
        ) AS customer_po_no
    FROM with_so_detail ww
    LEFT JOIN public.pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
    LEFT JOIN public.pp_partial_detail ppd
           ON ppd.pp_voucher_no = ww.pp_voucher_no
          AND ppd.pp_partial_no = COALESCE(p.pp_partial_no, 1)
    LEFT JOIN public.so_order_header hdr
           ON hdr.sales_order_no = ww.source_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.main_desc AS description
    FROM with_partial wp
    LEFT JOIN public.part_desc pd ON wp.final_inventory_code = pd.inventory_code
),
current_execution_stage AS (
    -- Active stage: prefer In Process with the most output (skips stale admin stages
    -- like Stock Issue that stay I while Turning is running). Else first open stage.
    SELECT DISTINCT ON (source_mps_no, pp_partial_no)
        source_mps_no,
        pp_partial_no,
        stage_no         AS current_stage_no,
        stage_desc       AS current_stage_desc,
        execution_status AS current_stage_status
    FROM public.mfg_wo_status
    WHERE COALESCE(execution_status, '') <> 'C'
      AND stage_no IS NOT NULL
    ORDER BY
        source_mps_no,
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
with_wo_status AS (
    SELECT
        wd.*,
        ws.execution_status,
        ws.wo_qty_required,
        ws.total_acc_qty_produced,
        ws.total_rej_qty_produced
    FROM with_desc wd
    LEFT JOIN public.mfg_wo_status ws
           ON ws.source_mps_no = wd.ps_id
          AND ws.pp_partial_no = wd.pp_partial_no
          AND (
              (
                  NULLIF(TRIM(COALESCE(ws.stage_desc, '')), '') IS NOT NULL
                  AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(wd.stage_desc, ''))
              )
              OR (
                  NULLIF(TRIM(COALESCE(ws.stage_desc, '')), '') IS NULL
                  AND ws.stage_no IS NOT NULL
                  AND wd.stage_no IS NOT NULL
                  AND ws.stage_no = wd.stage_no
              )
          )
),
with_current_stage AS (
    SELECT
        w.*,
        ces.current_stage_no,
        ces.current_stage_desc,
        ces.current_stage_status
    FROM with_wo_status w
    LEFT JOIN current_execution_stage ces
           ON ces.source_mps_no = w.ps_id
          AND ces.pp_partial_no = w.pp_partial_no
),
computed AS (
    SELECT DISTINCT
        ps_id,
        pp_partial_no,
        final_inventory_code    AS part_no,
        description,
        CASE
            WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
            WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
            ELSE ws_item_qty
        END                     AS total_qty,
        COALESCE(
            NULLIF(partial_qty_raw, 0),
            CASE
                WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
                ELSE ws_item_qty
            END
        )                       AS partial_qty,
        so_qty                  AS so_det_qty,
        COALESCE(required_shipment_date, source_rsd) AS due_date,
        ps_order_date           AS order_date,
        bom_code,
        source_voucher_no,
        source_line_item_no,
        customer_po_no,
        qty_shipped,
        CASE
            WHEN status = 'H'          THEN 'History'
            WHEN ws_status IS NOT NULL THEN ws_status
            WHEN status = 'O'          THEN 'Outstanding'
            ELSE status
        END                     AS status,
        CASE execution_status
            WHEN 'P' THEN 'Pending SI'
            WHEN 'R' THEN 'Ready to Start'
            WHEN 'I' THEN 'In Process'
            WHEN 'C' THEN 'Completed'
            ELSE execution_status
        END                     AS execution_status,
        wo_qty_required,
        total_acc_qty_produced  AS wo_qty_produced,
        total_rej_qty_produced  AS wo_qty_rejected,
        stage_no,
        stage_desc,
        op_no,
        current_stage_no,
        current_stage_desc,
        current_stage_status
    FROM with_current_stage
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no, stage_no;
