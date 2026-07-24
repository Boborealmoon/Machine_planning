-- Store material UOM for calc entries (mm vs pcs, etc.).

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS material_uom TEXT NOT NULL DEFAULT 'mm';
