-- First Article Tracker: persist New parts completion ticks.

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS npi_complete BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
