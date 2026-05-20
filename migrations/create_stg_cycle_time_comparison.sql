-- Cached staging table: ERP (bom_op_stage) vs Google Sheet (planner_program_tools) cycle times.
-- Refreshed asynchronously after bom / program-tool syncs when SUPA_DB_URL is set — see
-- sync.schedule_rebuild_stg_cycle_time_comparison (does not block HTTP responses).
--
-- Grain: bom_op_stage (part_no/inventory_code, bom_code, stage_no).
--
-- If you ran the older VIEW-only migration, drop it first — the table replaces it.
DROP VIEW IF EXISTS public.stg_cycle_time_comparison;

CREATE TABLE IF NOT EXISTS public.stg_cycle_time_comparison (
    part_no text NOT NULL,
    bom_code text NOT NULL,
    stage_no integer NOT NULL,
    stage_desc text NOT NULL,
    erp_op_no integer,
    op_index integer NOT NULL,
    erp_machine_no text,
    erp_setup_time numeric NOT NULL,
    erp_cycle_time numeric NOT NULL,
    erp_loaded_at timestamptz,
    planner_program_tools_id bigint,
    gs_cnc_machine_no text,
    gs_operation_no_raw text,
    gs_op_extracted_int integer,
    gs_set_up_time integer,
    gs_cycle_time integer,
    gs_synced_at timestamptz,
    gs_match_method text,
    cache_built_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (part_no, bom_code, stage_no)
);

CREATE INDEX IF NOT EXISTS idx_stg_cycle_time_part
    ON public.stg_cycle_time_comparison (part_no);

COMMENT ON TABLE public.stg_cycle_time_comparison IS
'Cache: erp_cycle_time vs gs_cycle_time per bom_op_stage row; rebuilt on bom_op_stage and planner_program_tools sync.';
