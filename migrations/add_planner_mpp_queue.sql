-- MPP planner live queue: cycles, ops, lane anchors, job timing overrides.
-- Run once against the planner Postgres database.

CREATE TABLE IF NOT EXISTS public.planner_mpp_lane (
    machine_id        BIGINT       PRIMARY KEY REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    lane_anchor       TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.planner_mpp_cycle (
    cycle_id          BIGSERIAL    PRIMARY KEY,
    client_cycle_id   TEXT         NOT NULL UNIQUE,
    machine_id        BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    queue_index       INTEGER      NOT NULL DEFAULT 0,
    shift             TEXT         NOT NULL DEFAULT 'night',
    anchor_datetime   TIMESTAMPTZ,
    cycle_label       TEXT         NOT NULL DEFAULT '',
    group_id          BIGINT       REFERENCES public.planner_run_block_group(group_id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_mpp_cycle_machine
    ON public.planner_mpp_cycle (machine_id, queue_index);

CREATE TABLE IF NOT EXISTS public.planner_mpp_cycle_op (
    cycle_op_id       BIGSERIAL    PRIMARY KEY,
    client_op_id      TEXT         NOT NULL UNIQUE,
    cycle_id          BIGINT       NOT NULL REFERENCES public.planner_mpp_cycle(cycle_id) ON DELETE CASCADE,
    block_id          BIGINT       REFERENCES public.planner_run_block(block_id) ON DELETE SET NULL,
    job_id            TEXT         NOT NULL,
    source_ps_id      TEXT         NOT NULL DEFAULT '',
    source_op_seq_id  BIGINT       NOT NULL DEFAULT 0,
    source_op_no      TEXT         NOT NULL DEFAULT '',
    pp_partial_no     INTEGER      NOT NULL DEFAULT 1,
    pallet_count      INTEGER      NOT NULL DEFAULT 1,
    min_per_pallet    NUMERIC      NOT NULL DEFAULT 90,
    pcs_per_pallet    NUMERIC      NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_mpp_cycle_op_cycle
    ON public.planner_mpp_cycle_op (cycle_id);

CREATE INDEX IF NOT EXISTS idx_planner_mpp_cycle_op_block
    ON public.planner_mpp_cycle_op (block_id);

CREATE TABLE IF NOT EXISTS public.planner_mpp_job_override (
    job_id            TEXT         PRIMARY KEY,
    min_per_pallet    NUMERIC      NOT NULL DEFAULT 90,
    pcs_per_pallet    NUMERIC      NOT NULL DEFAULT 1,
    qty               NUMERIC      NOT NULL DEFAULT 0,
    out_qty           NUMERIC      NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
