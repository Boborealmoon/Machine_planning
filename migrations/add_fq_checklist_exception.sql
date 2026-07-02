-- QAQC checklist + exception flags on finishing queue overlays
ALTER TABLE public.planner_finishing_queue_overlay
    ADD COLUMN IF NOT EXISTS checklist_done BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.planner_finishing_queue_overlay
    ADD COLUMN IF NOT EXISTS exception_flag BOOLEAN NOT NULL DEFAULT FALSE;
