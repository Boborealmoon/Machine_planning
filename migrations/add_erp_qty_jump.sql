-- Capture each increase in ERP accepted qty produced (scan jump), with machine at detection time.

CREATE TABLE IF NOT EXISTS public.planner_erp_qty_jump (
    jump_id              BIGSERIAL    PRIMARY KEY,
    source_mps_no        TEXT         NOT NULL,
    pp_partial_no        INTEGER      NOT NULL DEFAULT 1,
    stage_no             INTEGER      NOT NULL,
    stage_desc           TEXT         NOT NULL DEFAULT '',
    op_no                TEXT         NOT NULL DEFAULT '',
    part_no              TEXT         NOT NULL DEFAULT '',
    part_desc            TEXT         NOT NULL DEFAULT '',
    job_no               TEXT         NOT NULL DEFAULT '',
    so_no                TEXT         NOT NULL DEFAULT '',
    prev_acc_qty         NUMERIC      NOT NULL DEFAULT 0,
    new_acc_qty          NUMERIC      NOT NULL DEFAULT 0,
    qty_jump             NUMERIC      NOT NULL DEFAULT 0,
    prev_rej_qty         NUMERIC      NOT NULL DEFAULT 0,
    new_rej_qty          NUMERIC      NOT NULL DEFAULT 0,
    rej_jump             NUMERIC      NOT NULL DEFAULT 0,
    scanned_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    scanned_date         DATE         NOT NULL,
    machine_id           BIGINT,
    machine_no           TEXT         NOT NULL DEFAULT '',
    machine_category     TEXT         NOT NULL DEFAULT '',
    UNIQUE (source_mps_no, pp_partial_no, stage_no, prev_acc_qty, new_acc_qty, scanned_date)
);

CREATE INDEX IF NOT EXISTS idx_planner_erp_qty_jump_date
    ON public.planner_erp_qty_jump (scanned_date DESC, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_planner_erp_qty_jump_machine
    ON public.planner_erp_qty_jump (machine_no, scanned_date DESC);

CREATE INDEX IF NOT EXISTS idx_planner_erp_qty_jump_wo
    ON public.planner_erp_qty_jump (source_mps_no, pp_partial_no, stage_no, scanned_at DESC);
