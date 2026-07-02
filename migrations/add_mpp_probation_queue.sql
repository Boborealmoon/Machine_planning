-- MPP planner probation / holding queue — unscheduled ops that still reserve machine capacity.
-- Run once against the planner Postgres database.

CREATE TABLE IF NOT EXISTS public.planner_mpp_probation_op (
    probation_op_id   BIGSERIAL    PRIMARY KEY,
    client_entry_id   TEXT         NOT NULL UNIQUE,
    machine_id        BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    queue_index       INTEGER      NOT NULL DEFAULT 0,
    job_id            TEXT         NOT NULL,
    source_ps_id      TEXT         NOT NULL DEFAULT '',
    source_op_seq_id  BIGINT       NOT NULL DEFAULT 0,
    source_op_no      TEXT         NOT NULL DEFAULT '',
    pp_partial_no     INTEGER      NOT NULL DEFAULT 1,
    pallet_count      INTEGER      NOT NULL DEFAULT 1,
    shift             TEXT         NOT NULL DEFAULT 'night',
    note              TEXT         NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_mpp_probation_machine
    ON public.planner_mpp_probation_op (machine_id, queue_index);
