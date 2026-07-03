-- Historical log when a scheduled op naturally leaves a machine lane queue (auto-unschedule / MPP dequeue).
-- Apply in Supabase SQL editor once.

CREATE TABLE IF NOT EXISTS public.planner_queue_exit_history (
    exit_id           BIGSERIAL    PRIMARY KEY,
    block_id          BIGINT       NOT NULL,
    machine_id        BIGINT       NOT NULL,
    machine_no        TEXT         NOT NULL DEFAULT '',
    queue_position    NUMERIC,
    sequence_no       INTEGER,
    exit_reason       TEXT         NOT NULL DEFAULT '',
    exit_kind         TEXT         NOT NULL DEFAULT 'STANDARD',

    source_ps_id      TEXT         NOT NULL DEFAULT '',
    planner_ps_id     TEXT         NOT NULL DEFAULT '',
    pp_partial_no     INTEGER      NOT NULL DEFAULT 1,
    source_op_no      TEXT         NOT NULL DEFAULT '',
    op_seq_id         BIGINT,
    part_no           TEXT         NOT NULL DEFAULT '',
    bom_code          TEXT         NOT NULL DEFAULT '',
    stage_no          INTEGER      NOT NULL DEFAULT 0,
    stage_desc        TEXT         NOT NULL DEFAULT '',
    op_type           TEXT         NOT NULL DEFAULT '',

    scheduled_qty     NUMERIC      NOT NULL DEFAULT 0,
    good_qty          NUMERIC      NOT NULL DEFAULT 0,
    reject_qty        NUMERIC      NOT NULL DEFAULT 0,

    group_id          BIGINT,
    cycle_id          BIGINT,
    exited_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_queue_exit_part_stage_machine
    ON public.planner_queue_exit_history (part_no, stage_no, machine_no);

CREATE INDEX IF NOT EXISTS idx_planner_queue_exit_exited_at
    ON public.planner_queue_exit_history (exited_at DESC);

CREATE INDEX IF NOT EXISTS idx_planner_queue_exit_machine_no
    ON public.planner_queue_exit_history (machine_no);

COMMENT ON TABLE public.planner_queue_exit_history IS
    'One row per op that naturally leaves a machine lane (DONE auto-unschedule or MPP dequeue).';
