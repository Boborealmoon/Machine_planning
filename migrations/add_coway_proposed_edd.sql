-- Planner-managed proposed EDD (Coway) per process sheet partial.
ALTER TABLE public.planner_process_sheet
    ADD COLUMN IF NOT EXISTS coway_proposed_edd DATE;
