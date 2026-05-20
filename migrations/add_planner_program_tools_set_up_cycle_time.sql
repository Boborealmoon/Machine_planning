-- Add setup and cycle time columns to planner_program_tools (Supabase).
-- Run in Supabase SQL editor, then Project Settings → API → Reload schema.

ALTER TABLE public.planner_program_tools
    ADD COLUMN IF NOT EXISTS set_up_time INTEGER NOT NULL DEFAULT 180;

ALTER TABLE public.planner_program_tools
    ADD COLUMN IF NOT EXISTS cycle_time INTEGER;

-- Backfill: existing rows get default setup time; cycle_time stays NULL until next sync.
UPDATE public.planner_program_tools
SET set_up_time = 180
WHERE set_up_time IS NULL;
