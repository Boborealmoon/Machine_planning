-- Deburring cycle time (min/pc) on frame agreement parts (MPP + normal lanes).
ALTER TABLE public.planner_frame_agreement_part
    ADD COLUMN IF NOT EXISTS deburring_cycle_min_per_piece NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.planner_frame_agreement_normal_part
    ADD COLUMN IF NOT EXISTS deburring_cycle_min_per_piece NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.planner_frame_agreement_part.deburring_cycle_min_per_piece IS
    'Deburring cycle time in minutes per piece for this frame agreement part.';

COMMENT ON COLUMN public.planner_frame_agreement_normal_part.deburring_cycle_min_per_piece IS
    'Deburring cycle time in minutes per piece for this frame agreement part.';
