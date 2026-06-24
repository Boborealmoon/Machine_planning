-- Planner overlays for post-machining queue (remarks, QA assignment, due dates).

CREATE TABLE IF NOT EXISTS public.planner_finishing_queue_inspector (
    inspector_id   BIGSERIAL    PRIMARY KEY,
    name           TEXT         NOT NULL,
    active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.planner_finishing_queue_overlay (
    ps_id           TEXT         NOT NULL,
    pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
    stage_desc      TEXT         NOT NULL DEFAULT '',
    remarks         TEXT         NOT NULL DEFAULT '',
    inspector_id    BIGINT       REFERENCES public.planner_finishing_queue_inspector(inspector_id) ON DELETE SET NULL,
    qa_due_date     DATE,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ps_id, pp_partial_no, stage_desc)
);

CREATE INDEX IF NOT EXISTS idx_fq_overlay_inspector
    ON public.planner_finishing_queue_overlay (inspector_id)
    WHERE inspector_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
