-- Idempotent staging-table patches (safe to run on every ERP sync).
-- Canonical source — applied by planning.pp_staging_sql.ensure_pp_staging_schema().

ALTER TABLE public.pp_voucher
    ADD COLUMN IF NOT EXISTS source_voucher_no TEXT;

ALTER TABLE public.pp_voucher
    ADD COLUMN IF NOT EXISTS source_line_item_no TEXT;

ALTER TABLE public.pp_voucher
    ALTER COLUMN source_voucher_no TYPE TEXT USING source_voucher_no::TEXT;

ALTER TABLE public.pp_voucher
    ALTER COLUMN source_line_item_no TYPE TEXT USING source_line_item_no::TEXT;

CREATE INDEX IF NOT EXISTS idx_pp_voucher_source_voucher
    ON public.pp_voucher (source_voucher_no, source_line_item_no);

CREATE TABLE IF NOT EXISTS public.sum_qty_shipped_by_sales_order (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    qty_shipped     NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no)
);

ALTER TABLE public.sum_qty_shipped_by_sales_order
    ALTER COLUMN sales_order_no TYPE TEXT USING sales_order_no::TEXT;

ALTER TABLE public.sum_qty_shipped_by_sales_order
    ALTER COLUMN line_item_no TYPE TEXT USING line_item_no::TEXT;

CREATE INDEX IF NOT EXISTS idx_qty_shipped_sales_order
    ON public.sum_qty_shipped_by_sales_order (sales_order_no, line_item_no);

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS source_voucher_no TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS source_line_item_no TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS qty_shipped NUMERIC;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS so_det_qty NUMERIC;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_no INTEGER;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_desc TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_status TEXT;

CREATE TABLE IF NOT EXISTS public.so_detail (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    inventory_code  TEXT        NOT NULL,
    item_code       TEXT,
    qty             NUMERIC,
    item_qty        NUMERIC,
    required_shipment_date DATE,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no, inventory_code)
);

ALTER TABLE public.so_detail
    ADD COLUMN IF NOT EXISTS required_shipment_date DATE;

CREATE INDEX IF NOT EXISTS idx_so_detail_sales_order
    ON public.so_detail (sales_order_no, line_item_no);
