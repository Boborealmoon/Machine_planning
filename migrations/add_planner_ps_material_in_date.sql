-- Date raw material was marked in for a process sheet (planner overlay).
ALTER TABLE public.planner_process_sheet
    ADD COLUMN IF NOT EXISTS material_in_date DATE;
