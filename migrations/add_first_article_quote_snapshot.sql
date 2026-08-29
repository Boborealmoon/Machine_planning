-- NPI Tracker quotation snapshot: keep Excel part/qty/due until the PO posts.

ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS quote_part_no TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS quote_part_description TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS quote_qty TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS quote_po_due_date TEXT NOT NULL DEFAULT '';

NOTIFY pgrst, 'reload schema';
