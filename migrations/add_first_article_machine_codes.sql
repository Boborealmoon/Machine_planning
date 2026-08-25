-- First Article Tracker: editable CNC machine tags on flagged process sheets.

ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS machine_codes TEXT[];

NOTIFY pgrst, 'reload schema';
