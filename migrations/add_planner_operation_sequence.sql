-- Run once against the planner Postgres database (Supabase SQL editor or psql).

CREATE TABLE IF NOT EXISTS public.planner_operation_sequence (
    operation_sequence_id  BIGSERIAL    PRIMARY KEY,
    machine_id             BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    block_id               BIGINT       NOT NULL REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    sequence_no            INTEGER      NOT NULL,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (block_id)
);

CREATE INDEX IF NOT EXISTS idx_planner_operation_sequence_machine
    ON public.planner_operation_sequence(machine_id, sequence_no);

ALTER TABLE public.planner_run_block
    ADD COLUMN IF NOT EXISTS operation_sequence_id BIGINT
        REFERENCES public.planner_operation_sequence(operation_sequence_id) ON DELETE SET NULL;

-- Backfill sequence rows from current queue order.
INSERT INTO public.planner_operation_sequence (machine_id, block_id, sequence_no, created_at, updated_at)
SELECT b.machine_id, b.block_id,
       ROW_NUMBER() OVER (PARTITION BY b.machine_id ORDER BY b.queue_position, b.block_id)::INTEGER,
       NOW(), NOW()
FROM public.planner_run_block b
WHERE COALESCE(b.active, TRUE) = TRUE
ON CONFLICT (block_id) DO UPDATE SET
  machine_id = EXCLUDED.machine_id,
  sequence_no = EXCLUDED.sequence_no,
  updated_at = NOW();

UPDATE public.planner_run_block b
SET operation_sequence_id = os.operation_sequence_id
FROM public.planner_operation_sequence os
WHERE os.block_id = b.block_id;
