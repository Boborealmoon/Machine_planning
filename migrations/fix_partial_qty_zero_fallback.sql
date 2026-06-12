-- Staged so_detail is loaded from so_order_new_* + so_order_ost_det (see sync.py).
-- Joins staged so_detail by source_voucher_no + source_line_item_no for so_det_qty (so_detail.qty).

CREATE TABLE IF NOT EXISTS public.so_detail (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    inventory_code  TEXT        NOT NULL,
    item_code       TEXT,
    qty             NUMERIC,
    item_qty        NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no, inventory_code)
);

CREATE INDEX IF NOT EXISTS idx_so_detail_sales_order
    ON public.so_detail (sales_order_no, line_item_no);

DROP VIEW IF EXISTS public.vw_pp_vouchers;

-- View body: sql/vw_pp_vouchers.sql (run _ensure_pp_staging_schema(apply_view=True) to apply).
