-- Group mfg_wo_status by stage_no + stage_desc (not stage_no alone).
-- COMAIN can attach multiple unrelated WOs to the same stage_no; summing them
-- inflated wo_qty_required / produced / rejected (e.g. Turning + Deburring at stage 3).

DELETE FROM public.mfg_wo_status
WHERE NULLIF(TRIM(COALESCE(stage_desc, '')), '') IS NULL;

ALTER TABLE public.mfg_wo_status
    DROP CONSTRAINT IF EXISTS mfg_wo_status_shadow_pkey;

ALTER TABLE public.mfg_wo_status
    DROP CONSTRAINT IF EXISTS mfg_wo_status_pkey;

ALTER TABLE public.mfg_wo_status
    ADD PRIMARY KEY (source_mps_no, pp_partial_no, stage_no, stage_desc);

CREATE INDEX IF NOT EXISTS idx_mfg_wo_status_source_stage_desc
    ON public.mfg_wo_status (source_mps_no, pp_partial_no, stage_no, stage_desc);

NOTIFY pgrst, 'reload schema';
