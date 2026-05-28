-- Sheet columns: operation_type (col 16), program_no (col 6).
-- Run in Supabase SQL editor, then Project Settings → API → Reload schema.

ALTER TABLE public.planner_program_tools
    ADD COLUMN IF NOT EXISTS operation_type TEXT;

ALTER TABLE public.planner_program_tools
    ADD COLUMN IF NOT EXISTS program_no TEXT;

COMMENT ON COLUMN public.planner_program_tools.operation_type IS
    'Sheet operation type (Turning / Milling / Turnmill); pairs with operation_no (10, 20, 40).';

COMMENT ON COLUMN public.planner_program_tools.program_no IS
    'Sheet program identifier (e.g. CV25-00915-3-OP40); distinct from operation_no.';
