-- Frame agreement part numbers — master list for S/O flags and MPP planner intake.
CREATE TABLE IF NOT EXISTS public.planner_frame_agreement_part (
    part_no     TEXT         PRIMARY KEY,
    notes       TEXT         NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_frame_agreement_part_updated
    ON public.planner_frame_agreement_part (updated_at DESC);

COMMENT ON TABLE public.planner_frame_agreement_part IS
    'Inventory codes flagged as OSS frame agreement parts (S/O identifier + MPP planner intake).';
