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

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS customer_po_no TEXT;

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

CREATE TABLE IF NOT EXISTS public.pp_voucher_hdr (
    pp_voucher_no           TEXT        NOT NULL PRIMARY KEY,
    inventory_code          TEXT,
    bom_code                TEXT,
    bom_desc                TEXT,
    pp_qty                  NUMERIC,
    source_voucher_no       TEXT,
    source_rsd              DATE,
    source_line_item_no     TEXT,
    status                  TEXT,
    segment_1_code          TEXT,
    proposed_edd            DATE,
    production_due_date     DATE,
    remarks                 TEXT,
    customer_code           TEXT,
    mark_as_complete        BOOLEAN,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pp_voucher_hdr_source
    ON public.pp_voucher_hdr (source_voucher_no, source_line_item_no);

CREATE TABLE IF NOT EXISTS public.pp_partial_detail (
    pp_voucher_no           TEXT        NOT NULL,
    pp_partial_no           INTEGER     NOT NULL,
    partial_qty             NUMERIC,
    inventory_code          TEXT,
    customer_code           TEXT,
    party_name              TEXT,
    customer_po_no          TEXT,
    production_due_date     DATE,
    proposed_edd            DATE,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pp_voucher_no, pp_partial_no)
);

CREATE TABLE IF NOT EXISTS public.so_order_header (
    sales_order_no              TEXT        NOT NULL PRIMARY KEY,
    status                      TEXT,
    voucher_status              TEXT,
    order_date                  DATE,
    customer_code               TEXT,
    customer_name               TEXT,
    customer_short_name         TEXT,
    customer_po_no              TEXT,
    sales_person_code           TEXT,
    sales_person_name           TEXT,
    sbu_code                    TEXT,
    sbu_desc                    TEXT,
    reference_no                TEXT,
    sales_quotation_no          TEXT,
    total_after_tax_home_amt    NUMERIC,
    total_pre_tax_home_amt      NUMERIC,
    created_datetime            TIMESTAMPTZ,
    created_by_alias            TEXT,
    last_updated_datetime       TIMESTAMPTZ,
    last_updated_by_alias       TEXT,
    remarks                     TEXT,
    external_remarks            TEXT,
    subject                     TEXT,
    posted_datetime             TIMESTAMPTZ,
    order_currency_code         TEXT,
    _loaded_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.so_order_line (
    sales_order_no              TEXT        NOT NULL,
    line_item_no                TEXT        NOT NULL,
    inventory_code              TEXT,
    line_item_description       TEXT,
    qty                         NUMERIC,
    display_unit_price          NUMERIC,
    base_unit_selling_price     NUMERIC,
    pre_tax_extended_home_amt   NUMERIC,
    required_shipment_date      DATE,
    ost_status                  TEXT,
    posted_datetime             TIMESTAMPTZ,
    order_currency_code         TEXT,
    exch_rate                   NUMERIC,
    customer_code               TEXT,
    customer_name               TEXT,
    sales_person_name           TEXT,
    sbu_desc                    TEXT,
    order_date                  DATE,
    first_posted_datetime       TIMESTAMPTZ,
    _loaded_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no)
);

CREATE INDEX IF NOT EXISTS idx_so_order_line_sales_order
    ON public.so_order_line (sales_order_no);

CREATE TABLE IF NOT EXISTS public.so_order_posted (
    sales_order_no              TEXT        NOT NULL PRIMARY KEY,
    first_posted_datetime       TIMESTAMPTZ,
    latest_posted_datetime      TIMESTAMPTZ,
    customer_code               TEXT,
    reference_no                TEXT,
    posted_datetime             TIMESTAMPTZ,
    _loaded_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lg_out_shipment_line (
    sales_order_no              TEXT        NOT NULL,
    line_item_no                TEXT        NOT NULL,
    shipment_voucher_no         TEXT        NOT NULL,
    invoice_line_item_no        TEXT        NOT NULL DEFAULT '',
    inventory_code              TEXT,
    description                 TEXT,
    qty_issued                  NUMERIC,
    unit_selling_price_fc       NUMERIC,
    exch_rate                   NUMERIC,
    order_currency_code         TEXT,
    invoice_no                  TEXT,
    shipment_datetime           TIMESTAMPTZ,
    shipment_date               DATE,
    due_date                    DATE,
    customer_code               TEXT,
    customer_name               TEXT,
    sales_person_name           TEXT,
    sbu_desc                    TEXT,
    first_posted_datetime       TIMESTAMPTZ,
    detail_status               TEXT,
    do_no                       TEXT,
    do_generation_datetime      TIMESTAMPTZ,
    _loaded_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shipment_voucher_no, invoice_line_item_no, sales_order_no, line_item_no)
);

ALTER TABLE public.lg_out_shipment_line
    ADD COLUMN IF NOT EXISTS do_no TEXT;

ALTER TABLE public.lg_out_shipment_line
    ADD COLUMN IF NOT EXISTS do_generation_datetime TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_lg_out_shipment_line_date
    ON public.lg_out_shipment_line (shipment_date);

CREATE TABLE IF NOT EXISTS public.stg_inventory_bom_stage (
    inventory_code  TEXT        NOT NULL,
    bom_code        TEXT        NOT NULL,
    stage_no        INTEGER     NOT NULL,
    stage_desc      TEXT,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (inventory_code, bom_code, stage_no)
);

CREATE TABLE IF NOT EXISTS public.stg_qc_inspection (
    inspection_voucher_no               TEXT        NOT NULL PRIMARY KEY,
    status                              TEXT,
    inspector_code                      TEXT,
    inspector_name                      TEXT,
    po_no                               TEXT,
    supplier_code                       TEXT,
    supplier_name                       TEXT,
    shipment_voucher_no                 TEXT,
    grn_no                              TEXT,
    shipment_line_item_no               TEXT,
    inventory_code                      TEXT,
    inventory_desc                      TEXT,
    uom                                 TEXT,
    receiving_qty                       NUMERIC,
    inspected_qty                       NUMERIC,
    accepted_qty                        NUMERIC,
    rejected_qty                        NUMERIC,
    actual_arrival_date                 DATE,
    goods_receipt_date                  DATE,
    created_by_employee_code            TEXT,
    created_by_employee_name            TEXT,
    last_updated_by_employee_code       TEXT,
    last_updated_by_employee_name       TEXT,
    created_datetime                    TIMESTAMPTZ,
    last_updated_datetime               TIMESTAMPTZ,
    internal_remarks                    TEXT,
    line_item_remarks                   TEXT,
    ncr_voucher_no                      TEXT,
    shipment_supplier_name              TEXT,
    shipment_receiving_location_name    TEXT,
    contact_person_name                 TEXT,
    generate_ncr                        BOOLEAN,
    has_shipment                        BOOLEAN NOT NULL DEFAULT false,
    _loaded_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stg_inventory_enquiry (
    inventory_code          TEXT        NOT NULL PRIMARY KEY,
    payload                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stg_kobelco_mps_archive (
    row_id                  BIGSERIAL   PRIMARY KEY,
    pk_so                   TEXT,
    posted_date             DATE,
    sales_quotation_no      TEXT,
    customer_code           TEXT,
    line_item_no            TEXT,
    dwg_pn                  TEXT,
    description             TEXT,
    sn                      TEXT,
    customer_po_no          TEXT,
    qty                     NUMERIC,
    due_date                DATE,
    inspection_report_no    TEXT,
    coc_no                  TEXT,
    ps_number               TEXT,
    line_item_description   TEXT,
    segment_1_code          TEXT,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Finishing / material-issue queues: avoid DISTINCT ON over every open WO row.
CREATE INDEX IF NOT EXISTS idx_mfg_wo_status_open_stage_desc
    ON public.mfg_wo_status (stage_desc)
    WHERE execution_status IS NOT NULL
      AND execution_status <> ''
      AND execution_status NOT IN ('C', 'Completed')
      AND stage_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mfg_wo_status_open_partial
    ON public.mfg_wo_status (source_mps_no, pp_partial_no, stage_no)
    WHERE execution_status IS NOT NULL
      AND execution_status <> ''
      AND execution_status NOT IN ('C', 'Completed')
      AND stage_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pp_vouchers_cache_ps_partial
    ON public.pp_vouchers_cache (ps_id, pp_partial_no, stage_no);
