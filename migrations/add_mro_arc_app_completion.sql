-- Local app completion flag for MRO ARC rows.
-- Effective completion = ERP arc_status 'C' OR a row in this table.

CREATE TABLE IF NOT EXISTS public.mro_arc_app_completion (
    sales_order_no        TEXT         NOT NULL,
    sales_line_item_no    TEXT         NOT NULL DEFAULT '',
    process_sheet_no      TEXT         NOT NULL DEFAULT '',
    history_id            BIGINT       UNIQUE,
    completed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sales_order_no, sales_line_item_no, process_sheet_no)
);
