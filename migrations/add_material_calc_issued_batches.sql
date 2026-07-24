-- Simplify material calc: buffer length + issued batches (length + batch_no).

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS material_per_unit_mm NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.planner_ps_material_calc
    ADD COLUMN IF NOT EXISTS buffer_length_mm NUMERIC NOT NULL DEFAULT 0;

-- Backfill from legacy columns when new cols are still zero.
UPDATE public.planner_ps_material_calc
SET material_per_unit_mm = finished_part_length_mm
WHERE COALESCE(material_per_unit_mm, 0) = 0
  AND COALESCE(finished_part_length_mm, 0) <> 0;

UPDATE public.planner_ps_material_calc
SET buffer_length_mm = clamp_length_op1_mm
WHERE COALESCE(buffer_length_mm, 0) = 0
  AND COALESCE(clamp_length_op1_mm, 0) <> 0;

CREATE TABLE IF NOT EXISTS public.planner_ps_material_issued (
    issued_id     BIGSERIAL    PRIMARY KEY,
    calc_id       BIGINT       NOT NULL
        REFERENCES public.planner_ps_material_calc(calc_id) ON DELETE CASCADE,
    batch_no      TEXT         NOT NULL DEFAULT '',
    length_mm     NUMERIC      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_ps_material_issued_calc
    ON public.planner_ps_material_issued (calc_id);
