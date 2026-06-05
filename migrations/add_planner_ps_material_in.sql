-- Planner flag: raw material available for this process sheet partial (scheduler sidebar).
ALTER TABLE public.planner_process_sheet
    ADD COLUMN IF NOT EXISTS material_in BOOLEAN NOT NULL DEFAULT FALSE;
