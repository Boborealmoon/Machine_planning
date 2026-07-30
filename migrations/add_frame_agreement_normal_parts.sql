-- Frame agreement parts that run on normal (non-MPP) machines.
-- Separate from planner_frame_agreement_part (MPP lane). A part may exist on one or both lists.
-- Cycle times are not stored here � look up planner_cycle_time_master.

CREATE TABLE IF NOT EXISTS public.planner_frame_agreement_normal_part (
    part_no     TEXT         PRIMARY KEY,
    notes       TEXT         NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_frame_agreement_normal_part_updated
    ON public.planner_frame_agreement_normal_part (updated_at DESC);

COMMENT ON TABLE public.planner_frame_agreement_normal_part IS
    'Inventory codes flagged as OSS frame agreement parts for normal (non-MPP) machines; S/O FA badge; times from master cycle table.';
