-- Versioned history when master cycle times are published (never auto-applied to scheduled jobs).
-- Apply in Supabase SQL editor once. Requires planner_cycle_time_master.

CREATE TABLE IF NOT EXISTS public.planner_cycle_time_snapshot (
    snapshot_id          BIGSERIAL    PRIMARY KEY,
    master_id            BIGINT       REFERENCES public.planner_cycle_time_master(id) ON DELETE SET NULL,
    part_no              TEXT         NOT NULL,
    bom_code             TEXT         NOT NULL DEFAULT '',
    stage_no             INTEGER      NOT NULL DEFAULT 0,
    stage_name           TEXT         NOT NULL DEFAULT '',
    op_no                INTEGER,
    op_type              TEXT         NOT NULL DEFAULT '',
    program_no           TEXT         NOT NULL DEFAULT '',
    program_file         TEXT         NOT NULL DEFAULT '',
    tool_list_file       TEXT         NOT NULL DEFAULT '',
    cycle_time_old       NUMERIC,
    cycle_time_new       NUMERIC      NOT NULL,
    set_up_time_old      NUMERIC,
    set_up_time_new      NUMERIC      NOT NULL DEFAULT 0,
    source_kind          TEXT         NOT NULL DEFAULT 'MANUAL',
    source_block_id      BIGINT,
    source_operation_id  BIGINT,
    quantum_from         DATE,
    quantum_to           DATE,
    sample_count         INTEGER,
    notes                TEXT         NOT NULL DEFAULT '',
    published_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_ct_snapshot_part_bom
    ON public.planner_cycle_time_snapshot (part_no, bom_code);

CREATE INDEX IF NOT EXISTS idx_planner_ct_snapshot_master
    ON public.planner_cycle_time_snapshot (master_id);

CREATE INDEX IF NOT EXISTS idx_planner_ct_snapshot_published
    ON public.planner_cycle_time_snapshot (published_at DESC);

COMMENT ON TABLE public.planner_cycle_time_snapshot IS
    'Audit trail for published master cycle times. Does not change planner_operation on existing jobs.';
