-- RFQ checker: tag a whole upload (APS/NPS/PPS/...) and fill RFQ / customer / salesperson once.

ALTER TABLE public.planner_rfq_batch
    ADD COLUMN IF NOT EXISTS sheet_tag TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_rfq_batch
    ADD COLUMN IF NOT EXISTS default_rfq TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_rfq_batch
    ADD COLUMN IF NOT EXISTS default_customer TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_rfq_batch
    ADD COLUMN IF NOT EXISTS default_salesperson TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_rfq_line
    ADD COLUMN IF NOT EXISTS sheet_tag TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_rfq_batch_sheet_tag
    ON public.planner_rfq_batch (UPPER(TRIM(sheet_tag)));

CREATE INDEX IF NOT EXISTS idx_rfq_line_sheet_tag
    ON public.planner_rfq_line (UPPER(TRIM(sheet_tag)));

NOTIFY pgrst, 'reload schema';
