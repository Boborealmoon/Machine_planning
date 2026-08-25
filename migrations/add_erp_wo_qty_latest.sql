-- Compact last-seen ERP accepted qty per WO stage. Used by the 5-minute
-- COMAIN poll so it can detect jumps without rewriting mfg_wo_status.

CREATE TABLE IF NOT EXISTS public.planner_erp_wo_qty_latest (
    source_mps_no        TEXT         NOT NULL,
    pp_partial_no        INTEGER      NOT NULL DEFAULT 1,
    stage_no             INTEGER      NOT NULL,
    acc_qty_produced     NUMERIC      NOT NULL DEFAULT 0,
    acc_rej_qty_produced NUMERIC      NOT NULL DEFAULT 0,
    seen_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_mps_no, pp_partial_no, stage_no)
);
