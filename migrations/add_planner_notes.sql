-- Standalone planner notes with optional links to process sheets.
CREATE TABLE IF NOT EXISTS public.planner_note (
    note_id      BIGSERIAL    PRIMARY KEY,
    body         TEXT         NOT NULL CHECK (LENGTH(BTRIM(body)) > 0),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.planner_note_process_sheet (
    note_id        BIGINT  NOT NULL
        REFERENCES public.planner_note(note_id) ON DELETE CASCADE,
    planner_ps_id  TEXT    NOT NULL
        REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, planner_ps_id)
);

CREATE INDEX IF NOT EXISTS idx_planner_note_created_at
    ON public.planner_note (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_planner_note_process_sheet_ps
    ON public.planner_note_process_sheet (planner_ps_id);
