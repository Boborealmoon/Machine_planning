-- Per-operation MPP pallet profile for frame agreement parts.
-- One row per (part_no, bom_code, op_no) — matches spreadsheet line items.

CREATE TABLE IF NOT EXISTS public.planner_frame_agreement_op_config (
    part_no              TEXT         NOT NULL,
    bom_code             TEXT         NOT NULL DEFAULT '',
    op_no                TEXT         NOT NULL DEFAULT '',
    stage_no             INTEGER,
    stage_desc           TEXT         NOT NULL DEFAULT '',
    cycle_min_per_piece  NUMERIC      NOT NULL DEFAULT 0,
    pcs_per_pallet       NUMERIC      NOT NULL DEFAULT 0,
    run_min_per_pallet   NUMERIC      NOT NULL DEFAULT 0,
    pallets_count        NUMERIC      NOT NULL DEFAULT 0,
    setup_minutes        NUMERIC      NOT NULL DEFAULT 0,
    mpp_machine_no       TEXT         NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (part_no, bom_code, op_no)
);

CREATE INDEX IF NOT EXISTS idx_planner_fa_op_config_part_bom
    ON public.planner_frame_agreement_op_config (part_no, bom_code);

COMMENT ON TABLE public.planner_frame_agreement_op_config IS
    'MPP pallet profile per FA part + BOM route + operation — applied to matching process sheet jobs.';
