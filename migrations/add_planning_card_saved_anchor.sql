-- Preserve machine-lane anchor when a done op is auto-returned to the catalog.
ALTER TABLE public.planner_planning_card
    ADD COLUMN IF NOT EXISTS saved_anchor_datetime TIMESTAMPTZ;
