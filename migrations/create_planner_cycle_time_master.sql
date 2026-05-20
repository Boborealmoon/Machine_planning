-- Master cycle times (authoritative planner copy; minutes).
-- part_no = ERP inventory code. Row identity = id (BIGSERIAL) only — many rows can share
-- the same part_no with different bom_code / program / stage.
-- Apply in Supabase SQL editor once. API: /api/planner/cycle-times (Flask + service role).

CREATE TABLE IF NOT EXISTS public.planner_cycle_time_master (
    id                 BIGSERIAL    PRIMARY KEY,
    bom_code           TEXT         NOT NULL DEFAULT '',
    part_no            TEXT         NOT NULL,
    part_description   TEXT         NOT NULL DEFAULT '',
    stage_no           INTEGER      NOT NULL,
    stage_name         TEXT         NOT NULL DEFAULT '',
    op_no              INTEGER,
    op_type            TEXT         NOT NULL DEFAULT '',
    program_no         TEXT         NOT NULL DEFAULT '',
    program_file       TEXT         NOT NULL DEFAULT '',
    tool_list_file     TEXT         NOT NULL DEFAULT '',
    cycle_time         NUMERIC      NOT NULL DEFAULT 0,
    set_up_time        NUMERIC      NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_part
    ON public.planner_cycle_time_master (part_no);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_bom
    ON public.planner_cycle_time_master (bom_code);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_stage_no
    ON public.planner_cycle_time_master (stage_no);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_stage_name
    ON public.planner_cycle_time_master (stage_name);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_program_no
    ON public.planner_cycle_time_master (program_no);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_program_file
    ON public.planner_cycle_time_master (program_file);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_tool_list_file
    ON public.planner_cycle_time_master (tool_list_file);

CREATE INDEX IF NOT EXISTS idx_planner_ctm_part_bom
    ON public.planner_cycle_time_master (part_no, bom_code);

COMMENT ON TABLE public.planner_cycle_time_master IS
    'Planner-maintained cycle/setup times (minutes). Key = id; part_no can repeat with many bom_code / program rows.';

COMMENT ON COLUMN public.planner_cycle_time_master.cycle_time IS 'Minutes per piece.';
COMMENT ON COLUMN public.planner_cycle_time_master.set_up_time IS 'Minutes per setup.';
