-- Capture when Deburring was scanned / pushed into QC (Final Inspection).
CREATE TABLE IF NOT EXISTS public.planner_deburr_qc_push (
    source_mps_no   TEXT         NOT NULL,
    pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
    pushed_at       TIMESTAMPTZ  NOT NULL,
    source          TEXT         NOT NULL DEFAULT 'qty_jump',
    qty_jump        NUMERIC,
    stage_no        INTEGER,
    jump_id         BIGINT,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_mps_no, pp_partial_no)
);

CREATE INDEX IF NOT EXISTS idx_deburr_qc_push_pushed_at
    ON public.planner_deburr_qc_push (pushed_at DESC);

COMMENT ON TABLE public.planner_deburr_qc_push IS
    'Latest Deburring ERP scan (or first seen at Final Inspection) used as the QC wait clock.';
