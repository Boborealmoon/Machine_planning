-- RFQ tracker: days and lead time are planner-entered unless the workbook already has them.
-- Store upload-level defaults so one edit can fill every line in a grouped upload.

ALTER TABLE public.planner_rfq_batch
    ADD COLUMN IF NOT EXISTS default_days NUMERIC;

ALTER TABLE public.planner_rfq_batch
    ADD COLUMN IF NOT EXISTS default_lead_time TEXT NOT NULL DEFAULT '';

NOTIFY pgrst, 'reload schema';
