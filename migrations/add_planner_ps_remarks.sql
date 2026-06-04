-- Planner-managed remarks per process sheet partial (Process Sheets page).
ALTER TABLE public.planner_process_sheet
    ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT '';
