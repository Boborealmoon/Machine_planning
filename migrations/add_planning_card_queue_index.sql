-- Mirror the machine-lane queue order on planner_planning_card for Supabase views.

ALTER TABLE public.planner_planning_card
    ADD COLUMN IF NOT EXISTS machine_queue_index INTEGER;

ALTER TABLE public.planner_planning_card
    ADD COLUMN IF NOT EXISTS operation_sequence_id BIGINT
        REFERENCES public.planner_operation_sequence(operation_sequence_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_planner_planning_card_machine_queue
    ON public.planner_planning_card(machine_id, machine_queue_index);

WITH card_order AS (
    SELECT DISTINCT ON (pc.card_id)
           pc.card_id,
           b.machine_id,
           b.group_id,
           os.operation_sequence_id,
           COALESCE(os.sequence_no, b.queue_position)::INTEGER AS machine_queue_index
    FROM public.planner_planning_card pc
    JOIN public.planner_planning_card_operation pco ON pco.card_id = pc.card_id
    JOIN public.planner_operation o
      ON o.source_ps_id = pco.source_ps_id
     AND COALESCE(o.source_op_no, '') = COALESCE(pco.source_op_no, '')
     AND COALESCE(o.source_op_seq_id, 0) = COALESCE(pco.source_op_seq_id, 0)
    JOIN public.planner_run_block b ON b.operation_id = o.operation_id
    LEFT JOIN public.planner_operation_sequence os ON os.block_id = b.block_id
    WHERE COALESCE(b.active, TRUE) = TRUE
    ORDER BY pc.card_id, COALESCE(os.sequence_no, b.queue_position), b.block_id
)
UPDATE public.planner_planning_card pc
SET planning_status = 'SCHEDULED',
    machine_id = co.machine_id,
    scheduled_block_group_id = COALESCE(co.group_id, pc.scheduled_block_group_id),
    operation_sequence_id = co.operation_sequence_id,
    machine_queue_index = co.machine_queue_index,
    updated_at = NOW()
FROM card_order co
WHERE co.card_id = pc.card_id;
