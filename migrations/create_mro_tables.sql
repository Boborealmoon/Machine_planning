-- Create MRO Supabase tables (public schema).
-- Safe to re-run: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.mro_certifying_staff (
    staff_id               BIGSERIAL    PRIMARY KEY,
    name                   TEXT         NOT NULL,
    active                 BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    signature_image        BYTEA,
    signature_mime         TEXT,
    signature_updated_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.mro_arc_serial_seq (
    variant      TEXT         PRIMARY KEY,
    next_value   BIGINT       NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.mro_arc_history (
    history_id            BIGSERIAL    PRIMARY KEY,
    caas_doc_no           TEXT         UNIQUE,
    faa_doc_no            TEXT         UNIQUE,
    easa_doc_no           TEXT         UNIQUE,
    jcab_doc_no          TEXT         UNIQUE,
    caac_doc_no          TEXT         UNIQUE,
    order_date            DATE,
    process_sheet_no      TEXT,
    part_no               TEXT,
    description           TEXT,
    serial_no             TEXT,
    customer_code         TEXT,
    customer_po_no        TEXT,
    po_item_no            TEXT,
    so_qty                NUMERIC,
    sales_order_no        TEXT,
    sales_line_item_no    TEXT,
    certifying_staff      TEXT,
    cert_date             DATE,
    variants              TEXT[]       NOT NULL DEFAULT '{}',
    payload_json          JSONB,
    pdf_bytes             BYTEA,
    pdf_filename          TEXT,
    pdf_content_type      TEXT,
    created_by            TEXT,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Local "submitted in this app" completion flag.
-- Independent of ERP arc_status; cleared when the linked history row is deleted (testing).
CREATE TABLE IF NOT EXISTS public.mro_arc_app_completion (
    sales_order_no        TEXT         NOT NULL,
    sales_line_item_no    TEXT         NOT NULL DEFAULT '',
    process_sheet_no      TEXT         NOT NULL DEFAULT '',
    history_id            BIGINT       UNIQUE,
    completed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sales_order_no, sales_line_item_no, process_sheet_no)
);

INSERT INTO public.mro_arc_serial_seq (variant, next_value)
VALUES
    ('CAAS', 1),
    ('FAA', 1),
    ('EASA', 1),
    ('JCAB', 1),
    ('CAAC', 1)
ON CONFLICT (variant) DO NOTHING;
