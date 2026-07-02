-- MPP planner job overrides: setup + load/unload per pallet (minutes).
ALTER TABLE public.planner_mpp_job_override
    ADD COLUMN IF NOT EXISTS setup_minutes NUMERIC;

ALTER TABLE public.planner_mpp_job_override
    ADD COLUMN IF NOT EXISTS load_min_per_pallet NUMERIC;

ALTER TABLE public.planner_mpp_job_override
    ADD COLUMN IF NOT EXISTS unload_min_per_pallet NUMERIC;
