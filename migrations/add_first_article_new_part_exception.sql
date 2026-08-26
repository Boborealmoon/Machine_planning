-- First Article Tracker: manually added NEW-part exceptions.

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS is_exception BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
