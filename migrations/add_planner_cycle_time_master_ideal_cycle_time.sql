-- Split master cycle time into machine ideal vs production (planner) cycle time.
-- ideal_cycle_time = from machine / program tools sheet (authoritative machine estimate).
-- cycle_time       = production cycle time used for scheduling (defaults to ideal; editable).
-- Apply in Supabase SQL editor once.

ALTER TABLE public.planner_cycle_time_master
    ADD COLUMN IF NOT EXISTS ideal_cycle_time NUMERIC NOT NULL DEFAULT 0;

-- Existing rows: treat current cycle_time as both ideal and production.
UPDATE public.planner_cycle_time_master
SET ideal_cycle_time = cycle_time
WHERE ideal_cycle_time = 0 AND cycle_time <> 0;

COMMENT ON COLUMN public.planner_cycle_time_master.ideal_cycle_time IS
    'Machine ideal cycle time (minutes/pc) from program tools; updated on sheet sync.';
COMMENT ON COLUMN public.planner_cycle_time_master.cycle_time IS
    'Production cycle time (minutes/pc) used for new schedules; defaults to ideal, editable.';
