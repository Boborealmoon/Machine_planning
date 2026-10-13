-- CMM technician queue. Separate from NEW-part rows and from NPI History.
-- Active queue: status IN ('PENDING', 'IN_PROGRESS')
-- CMM History: status = 'COMPLETED' only.

CREATE TABLE IF NOT EXISTS public.planner_cmm_job (
    cmm_job_id            BIGSERIAL    PRIMARY KEY,
    process_sheet_no      TEXT         NOT NULL,
    part_no               TEXT         NOT NULL DEFAULT '',
    part_description      TEXT         NOT NULL DEFAULT '',
    technician_pic_id     BIGINT,
    status                TEXT         NOT NULL DEFAULT 'PENDING',
    jig_requirements      TEXT         NOT NULL DEFAULT '',
    jigs_ready            BOOLEAN      NOT NULL DEFAULT FALSE,
    jigs_ready_at         TIMESTAMPTZ,
    programme_count       INTEGER      NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at            TIMESTAMPTZ,
    overall_completed_at  TIMESTAMPTZ,
    completed_by          TEXT         NOT NULL DEFAULT '',
    CONSTRAINT planner_cmm_job_status_chk
        CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
    CONSTRAINT planner_cmm_job_programme_count_chk
        CHECK (programme_count >= 0),
    CONSTRAINT planner_cmm_job_complete_chk
        CHECK (
            (status = 'COMPLETED' AND overall_completed_at IS NOT NULL)
            OR (status <> 'COMPLETED' AND overall_completed_at IS NULL)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cmm_job_open_ps
    ON public.planner_cmm_job (LOWER(BTRIM(process_sheet_no)))
    WHERE status <> 'COMPLETED';

CREATE INDEX IF NOT EXISTS idx_cmm_job_queue
    ON public.planner_cmm_job (created_at, cmm_job_id)
    WHERE status IN ('PENDING', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS idx_cmm_job_history
    ON public.planner_cmm_job (overall_completed_at DESC, cmm_job_id)
    WHERE status = 'COMPLETED';

CREATE TABLE IF NOT EXISTS public.planner_cmm_subtask (
    subtask_id        BIGSERIAL    PRIMARY KEY,
    cmm_job_id        BIGINT       NOT NULL
        REFERENCES public.planner_cmm_job (cmm_job_id) ON DELETE CASCADE,
    programme_number  INTEGER      NOT NULL,
    completed_at      TIMESTAMPTZ,
    completed_by      TEXT         NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_cmm_subtask_number_chk
        CHECK (programme_number > 0),
    CONSTRAINT planner_cmm_subtask_job_number_uniq
        UNIQUE (cmm_job_id, programme_number)
);

CREATE TABLE IF NOT EXISTS public.planner_cmm_event (
    event_id     BIGSERIAL    PRIMARY KEY,
    cmm_job_id   BIGINT       NOT NULL
        REFERENCES public.planner_cmm_job (cmm_job_id) ON DELETE CASCADE,
    subtask_id   BIGINT
        REFERENCES public.planner_cmm_subtask (subtask_id) ON DELETE SET NULL,
    event_type   TEXT         NOT NULL,
    payload      JSONB        NOT NULL DEFAULT '{}',
    actor        TEXT         NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cmm_event_job_at
    ON public.planner_cmm_event (cmm_job_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
