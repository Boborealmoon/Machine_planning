-- MPP cycle-level timing (setup / load / unload on the cycle card).
ALTER TABLE public.planner_mpp_cycle
    ADD COLUMN IF NOT EXISTS setup_minutes NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.planner_mpp_cycle
    ADD COLUMN IF NOT EXISTS load_min_per_cycle NUMERIC;

ALTER TABLE public.planner_mpp_cycle
    ADD COLUMN IF NOT EXISTS unload_min_per_cycle NUMERIC;

ALTER TABLE public.planner_mpp_cycle
    ADD COLUMN IF NOT EXISTS sequential_ops BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.planner_mpp_cycle
    ADD COLUMN IF NOT EXISTS setup_per_op BOOLEAN NOT NULL DEFAULT FALSE;
