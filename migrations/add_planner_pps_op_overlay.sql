-- PPS per-op planner overlays (remarks, red flag, material date, delivery week).

CREATE TABLE IF NOT EXISTS public.planner_pps_op_overlay (
    ps_id           TEXT         NOT NULL,
    pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
    stage_no        INTEGER      NOT NULL,
    stage_desc      TEXT         NOT NULL DEFAULT '',
    remarks         TEXT         NOT NULL DEFAULT '',
    flagged         BOOLEAN      NOT NULL DEFAULT FALSE,
    material_date   DATE,
    delivery_week   TEXT         NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ps_id, pp_partial_no, stage_no)
);

CREATE INDEX IF NOT EXISTS idx_pps_op_overlay_flagged
    ON public.planner_pps_op_overlay (ps_id, pp_partial_no)
    WHERE flagged = TRUE;

NOTIFY pgrst, 'reload schema';
