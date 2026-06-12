-- Latest non-completed ERP execution stage per process sheet partial (from mfg_wo_status).
-- Populated into pp_vouchers_cache via vw_pp_vouchers on cache rebuild.

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_no INTEGER;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_desc TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_status TEXT;

DROP VIEW IF EXISTS public.vw_pp_vouchers;

-- View body: sql/vw_pp_vouchers.sql — run POST /api/admin/fix-execution-status or apply_view sync
-- or scripts/apply_current_execution_stage.py after deploying app changes.

NOTIFY pgrst, 'reload schema';
