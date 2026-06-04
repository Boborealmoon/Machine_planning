-- Manual produced qty for planner BOM variation steps (no ERP WO stage).
CREATE TABLE IF NOT EXISTS public.planner_ps_bom_step_qty (
    planner_ps_id   TEXT         NOT NULL REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    op_seq_id       BIGINT       NOT NULL,
    qty_produced    NUMERIC      NOT NULL DEFAULT 0,
    qty_rejected    NUMERIC      NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (planner_ps_id, op_seq_id)
);

CREATE INDEX IF NOT EXISTS idx_planner_ps_bom_step_qty_ps
    ON public.planner_ps_bom_step_qty(planner_ps_id);
