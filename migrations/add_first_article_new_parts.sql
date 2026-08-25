-- First Article Tracker: editable notes for NEW-part progress (Archive).

CREATE TABLE IF NOT EXISTS public.planner_first_article_new_part (
    process_sheet_no   TEXT         PRIMARY KEY,
    pp_voucher_no      TEXT         NOT NULL DEFAULT '',
    bom_updated        BOOLEAN      NOT NULL DEFAULT FALSE,
    remarks            TEXT         NOT NULL DEFAULT '',
    program_finish_at  TEXT         NOT NULL DEFAULT '',
    program_pic_ids    BIGINT[]     NOT NULL DEFAULT '{}',
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fa_new_part_updated_at
    ON public.planner_first_article_new_part (updated_at DESC);

NOTIFY pgrst, 'reload schema';
