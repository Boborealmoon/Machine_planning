-- Tooling is assumed ready by default; tooling_ready = FALSE flags an exception.
ALTER TABLE public.planner_operation
    ADD COLUMN IF NOT EXISTS tooling_ready BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.planner_operation
    ADD COLUMN IF NOT EXISTS tooling_ready_date DATE;

ALTER TABLE public.planner_operation
    ALTER COLUMN tooling_ready SET DEFAULT TRUE;

-- Existing rows: assume tooling present unless someone flagged an exception (date set).
UPDATE public.planner_operation
SET tooling_ready = TRUE,
    tooling_ready_date = NULL
WHERE tooling_ready IS NOT TRUE
  AND tooling_ready_date IS NULL;
