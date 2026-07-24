-- Allow multiple materials on the same process sheet for material calc / issue slips.
-- One row per (planner_ps_id, material_type_grade).

ALTER TABLE public.planner_ps_material_calc
    DROP CONSTRAINT IF EXISTS planner_ps_material_calc_planner_ps_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_ps_material_calc_ps_material
    ON public.planner_ps_material_calc (
        planner_ps_id,
        lower(btrim(material_type_grade))
    );
