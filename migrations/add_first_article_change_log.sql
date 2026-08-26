-- First Article Tracker: audit trail for PIC, remarks, programme finish, etc.

CREATE TABLE IF NOT EXISTS public.planner_first_article_change_log (
    change_id          BIGSERIAL    PRIMARY KEY,
    source             TEXT         NOT NULL,
    process_sheet_no   TEXT         NOT NULL,
    first_article_id   BIGINT,
    field_name         TEXT         NOT NULL,
    old_value          TEXT         NOT NULL DEFAULT '',
    new_value          TEXT         NOT NULL DEFAULT '',
    changed_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_first_article_change_log_source_chk
        CHECK (source IN ('new_part', 'flagged'))
);

CREATE INDEX IF NOT EXISTS idx_fa_change_log_ps_at
    ON public.planner_first_article_change_log (LOWER(TRIM(process_sheet_no)), changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_fa_change_log_source_ps
    ON public.planner_first_article_change_log (source, LOWER(TRIM(process_sheet_no)), changed_at DESC);

NOTIFY pgrst, 'reload schema';
