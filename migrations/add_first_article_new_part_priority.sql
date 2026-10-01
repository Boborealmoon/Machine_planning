-- NPI/FA New parts: priority (critical, high, medium, low).

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT '';

NOTIFY pgrst, 'reload schema';
