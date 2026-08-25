-- RFQ checker: uploaded workbooks + Archive-format line items.

CREATE TABLE IF NOT EXISTS public.planner_rfq_batch (
    batch_id       BIGSERIAL    PRIMARY KEY,
    filename       TEXT         NOT NULL DEFAULT '',
    sheet_name     TEXT         NOT NULL DEFAULT '',
    status         TEXT         NOT NULL DEFAULT 'draft',
    llm_used       BOOLEAN      NOT NULL DEFAULT FALSE,
    llm_model      TEXT         NOT NULL DEFAULT '',
    mapping        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    mapping_notes  TEXT         NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_rfq_batch_status_chk
        CHECK (status IN ('draft', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_rfq_batch_updated_at
    ON public.planner_rfq_batch (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.planner_rfq_line (
    line_id          BIGSERIAL    PRIMARY KEY,
    batch_id         BIGINT       NOT NULL
        REFERENCES public.planner_rfq_batch(batch_id) ON DELETE CASCADE,
    line_no          INTEGER      NOT NULL DEFAULT 0,
    part_no          TEXT         NOT NULL DEFAULT '',
    rfq              TEXT         NOT NULL DEFAULT '',
    customer         TEXT         NOT NULL DEFAULT '',
    salesperson      TEXT         NOT NULL DEFAULT '',
    qty              NUMERIC,
    opns             TEXT         NOT NULL DEFAULT '',
    assignment       TEXT         NOT NULL DEFAULT '',
    machines         TEXT         NOT NULL DEFAULT '',
    total_ct_mins    NUMERIC,
    machine_hours    NUMERIC,
    total_hours      NUMERIC,
    days             NUMERIC,
    lead_time        TEXT         NOT NULL DEFAULT '',
    need_tooling     TEXT         NOT NULL DEFAULT '',
    need_fixture     TEXT         NOT NULL DEFAULT '',
    remark           TEXT         NOT NULL DEFAULT '',
    match_status     TEXT         NOT NULL DEFAULT 'new',
    matched_part_no  TEXT         NOT NULL DEFAULT '',
    source_row       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfq_line_batch
    ON public.planner_rfq_line (batch_id, line_no);

CREATE INDEX IF NOT EXISTS idx_rfq_line_part_no
    ON public.planner_rfq_line (UPPER(TRIM(part_no)));

NOTIFY pgrst, 'reload schema';
