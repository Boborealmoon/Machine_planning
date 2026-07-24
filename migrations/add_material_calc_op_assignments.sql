-- Per-operation CNC + operator assignments for material calc / issue slips.

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS op_assignments JSONB NOT NULL DEFAULT '[]'::jsonb;
