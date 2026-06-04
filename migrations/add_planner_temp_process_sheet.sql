-- Reject / rework "[Temp]" process sheets — durable registry (Supabase / SUPA_DB_URL).
-- Each row links 1:1 to planner_process_sheet.planner_ps_id ([Temp]… id).

CREATE TABLE IF NOT EXISTS public.planner_temp_process_sheet (
    planner_ps_id           TEXT         PRIMARY KEY
        REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    source_ps_id            TEXT         NOT NULL,
    source_pp_partial_no    INTEGER      NOT NULL DEFAULT 1,
    reject_qty              NUMERIC      NOT NULL DEFAULT 0,
    inventory_code          TEXT         NOT NULL DEFAULT '',
    part_no                 TEXT         NOT NULL DEFAULT '',
    part_desc               TEXT         NOT NULL DEFAULT '',
    due_date                DATE,
    erp_bom_code            TEXT         NOT NULL DEFAULT '',
    selected_bom_id         BIGINT
        REFERENCES public.planner_bom_variation(bom_id) ON DELETE SET NULL,
    selected_bom_code       TEXT         NOT NULL DEFAULT '',
    remarks                 TEXT         NOT NULL DEFAULT '',
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_temp_process_sheet_source
    ON public.planner_temp_process_sheet (source_ps_id);

CREATE INDEX IF NOT EXISTS idx_planner_temp_process_sheet_created
    ON public.planner_temp_process_sheet (created_at DESC);
