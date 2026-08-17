-- Daily ERP cumulative snapshots for per-day qty delta (shop actual reconciliation).

CREATE TABLE IF NOT EXISTS public.planner_erp_wo_qty_snapshot (
    snapshot_id          BIGSERIAL    PRIMARY KEY,
    source_mps_no        TEXT         NOT NULL,
    pp_partial_no        INTEGER      NOT NULL DEFAULT 1,
    stage_no             INTEGER      NOT NULL,
    snapshot_date        DATE         NOT NULL,
    snapshot_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    acc_qty_produced     NUMERIC      NOT NULL DEFAULT 0,
    acc_rej_qty_produced NUMERIC      NOT NULL DEFAULT 0,
    UNIQUE (source_mps_no, pp_partial_no, stage_no, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_planner_erp_wo_qty_snapshot_lookup
    ON public.planner_erp_wo_qty_snapshot (source_mps_no, pp_partial_no, stage_no, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_planner_erp_wo_qty_snapshot_date
    ON public.planner_erp_wo_qty_snapshot (snapshot_date DESC);
