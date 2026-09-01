-- RFQ part master: assignment and operation cycle time keyed by part no.

CREATE TABLE IF NOT EXISTS public.planner_rfq_part_master (
    part_key         TEXT         PRIMARY KEY,
    part_no          TEXT         NOT NULL DEFAULT '',
    assignment       TEXT         NOT NULL DEFAULT '',
    opns             TEXT         NOT NULL DEFAULT '',
    machines         TEXT         NOT NULL DEFAULT '',
    total_ct_mins    NUMERIC,
    last_rfq         TEXT         NOT NULL DEFAULT '',
    customer         TEXT         NOT NULL DEFAULT '',
    salesperson      TEXT         NOT NULL DEFAULT '',
    sheet_tag        TEXT         NOT NULL DEFAULT '',
    source_batch_id  BIGINT,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfq_part_master_part_no
    ON public.planner_rfq_part_master (UPPER(TRIM(part_no)));

CREATE INDEX IF NOT EXISTS idx_rfq_part_master_updated
    ON public.planner_rfq_part_master (updated_at DESC);

NOTIFY pgrst, 'reload schema';
