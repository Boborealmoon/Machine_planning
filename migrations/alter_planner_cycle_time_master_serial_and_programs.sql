-- Upgrade existing planner_cycle_time_master (v1 → v2):
--   • Drop composite UNIQUE(part_no, bom_code, stage_no) — key is serial id only.
--   • Add stage_name, program_no, program_file, tool_list_file.
--   • Allow bom_code default '' so a part can have rows keyed mainly by id + part_no.
--   • Add indexes for lookups.
--
-- Run once in Supabase SQL editor if you already applied create_planner_cycle_time_master.sql v1.

ALTER TABLE public.planner_cycle_time_master
    DROP CONSTRAINT IF EXISTS planner_cycle_time_master_part_no_bom_code_stage_no_key;

ALTER TABLE public.planner_cycle_time_master
    ALTER COLUMN bom_code SET DEFAULT '';

UPDATE public.planner_cycle_time_master
SET bom_code = ''
WHERE bom_code IS NULL;

ALTER TABLE public.planner_cycle_time_master
    ADD COLUMN IF NOT EXISTS stage_name TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_cycle_time_master
    ADD COLUMN IF NOT EXISTS program_no TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_cycle_time_master
    ADD COLUMN IF NOT EXISTS program_file TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_cycle_time_master
    ADD COLUMN IF NOT EXISTS tool_list_file TEXT NOT NULL DEFAULT '';

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
