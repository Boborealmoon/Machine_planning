-- Run once against the planner Postgres database (Supabase SQL editor or psql).

ALTER TABLE public.planner_schedule_run
    ADD COLUMN IF NOT EXISTS change_summary JSONB;
