-- Include MPS, PPS, and CPS process sheets in vw_pp_vouchers (plus existing APS, NPS, [SR]).
-- ERROR* and other short prefixes (M24, PS24, etc.) remain excluded.

DROP VIEW IF EXISTS public.vw_pp_vouchers;

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
        MAX(qty) AS so_qty
    FROM public.so_detail
    WHERE sales_order_no IS NOT NULL
      AND line_item_no IS NOT NULL
    GROUP BY sales_order_no, regexp_replace(line_item_no::TEXT, '\.0+$', '')
),
with_so_detail AS (
    SELECT
        ww.*,
        sd.so_qty
    FROM with_shipped ww
    LEFT JOIN so_detail_by_line sd
           ON sd.sales_order_no = ww.source_voucher_no
          AND sd.line_item_no = regexp_replace(ww.source_line_item_no::TEXT, '\.0+$', '')
),
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw
    FROM with_so_detail ww
    LEFT JOIN public.pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.main_desc AS description
    FROM with_partial wp
    LEFT JOIN public.part_desc pd ON wp.final_inventory_code = pd.inventory_code
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
          AND ws.stage_no = wd.stage_no
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
        source_rsd              AS due_date,
        ps_order_date           AS order_date,
        bom_code,
        source_voucher_no,
        source_line_item_no,
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
        op_no
    FROM with_wo_status
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no, stage_no;
