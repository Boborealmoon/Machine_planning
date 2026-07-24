-- CNC selection + stock-in/out operators for material calc entries.

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS cnc_machines TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS stock_in_operator TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS stock_out_operator TEXT NOT NULL DEFAULT '';
