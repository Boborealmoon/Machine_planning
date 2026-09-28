-- Op-sheet quote snapshot on each RFQ line, so a repeat RFQ can look up the last quote.

ALTER TABLE public.planner_rfq_line
    ADD COLUMN IF NOT EXISTS quote JSONB NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
