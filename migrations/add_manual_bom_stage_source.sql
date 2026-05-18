-- Track whether planner BOM flows/stages came from ERP seed data or manual edits.

ALTER TABLE public.planner_bom_variation
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'ERP';

ALTER TABLE public.planner_operation_seq
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'ERP';

ALTER TABLE public.planner_operation_seq
    ADD COLUMN IF NOT EXISTS source_stage_no INTEGER;

ALTER TABLE public.planner_operation_seq
    ADD COLUMN IF NOT EXISTS planner_note TEXT NOT NULL DEFAULT '';

