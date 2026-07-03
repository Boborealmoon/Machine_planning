-- Per-part MPP planner defaults (machine + run time) for frame agreement parts.
ALTER TABLE public.planner_frame_agreement_part
    ADD COLUMN IF NOT EXISTS mpp_machine_no TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_frame_agreement_part
    ADD COLUMN IF NOT EXISTS mpp_run_min_per_pallet NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.planner_frame_agreement_part
    ADD COLUMN IF NOT EXISTS mpp_setup_minutes NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.planner_frame_agreement_part.mpp_machine_no IS
    'Preferred MPP lane for this FA part (CNC 35, CNC 36, or CNC 41).';

COMMENT ON COLUMN public.planner_frame_agreement_part.mpp_run_min_per_pallet IS
    'MPP planner run minutes per pallet — overrides planner_cycle_time_master for this part only.';

COMMENT ON COLUMN public.planner_frame_agreement_part.mpp_setup_minutes IS
    'MPP planner setup minutes — overrides BOM setup for this part only.';
