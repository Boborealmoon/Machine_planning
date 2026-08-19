-- First Article Tracker (Archive): flagged process sheets + PIC roster.

CREATE TABLE IF NOT EXISTS public.planner_first_article_pic (
    pic_id     BIGSERIAL    PRIMARY KEY,
    name       TEXT         NOT NULL,
    active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_pic_name_active_unique
    ON public.planner_first_article_pic (LOWER(TRIM(name)))
    WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS public.planner_first_article (
    first_article_id BIGSERIAL    PRIMARY KEY,
    process_sheet_no TEXT         NOT NULL,
    pp_voucher_no    TEXT         NOT NULL DEFAULT '',
    pic_ids          BIGINT[]     NOT NULL DEFAULT '{}',
    tooling_mode     TEXT         NOT NULL DEFAULT 'tick',
    tooling_tick     BOOLEAN      NOT NULL DEFAULT FALSE,
    tooling_text     TEXT         NOT NULL DEFAULT '',
    fixture_mode     TEXT         NOT NULL DEFAULT 'tick',
    fixture_tick     BOOLEAN      NOT NULL DEFAULT FALSE,
    fixture_text     TEXT         NOT NULL DEFAULT '',
    gauges_mode      TEXT         NOT NULL DEFAULT 'tick',
    gauges_tick      BOOLEAN      NOT NULL DEFAULT FALSE,
    gauges_text      TEXT         NOT NULL DEFAULT '',
    remarks          TEXT         NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_first_article_tooling_mode_chk
        CHECK (tooling_mode IN ('tick', 'text')),
    CONSTRAINT planner_first_article_fixture_mode_chk
        CHECK (fixture_mode IN ('tick', 'text')),
    CONSTRAINT planner_first_article_gauges_mode_chk
        CHECK (gauges_mode IN ('tick', 'text'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_process_sheet_unique
    ON public.planner_first_article (LOWER(TRIM(process_sheet_no)));

CREATE INDEX IF NOT EXISTS idx_fa_updated_at
    ON public.planner_first_article (updated_at DESC);

NOTIFY pgrst, 'reload schema';
