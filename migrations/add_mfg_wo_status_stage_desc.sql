-- Add ERP work-order stage description to mfg_wo_status staging table.
-- Populated by run_mfg_wo_status_sync() from mfg_wo_vch.stage_desc.

ALTER TABLE public.mfg_wo_status
    ADD COLUMN IF NOT EXISTS stage_desc TEXT;

NOTIFY pgrst, 'reload schema';
