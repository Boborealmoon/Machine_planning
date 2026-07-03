-- Per-BOM MPP planner defaults for frame agreement parts.
-- Keyed by (part_no, bom_code) so each BOM route can have its own pallet profile.

CREATE TABLE IF NOT EXISTS public.planner_frame_agreement_bom_config (
    part_no                  TEXT         NOT NULL,
    bom_code                 TEXT         NOT NULL DEFAULT '',
    mpp_machine_no           TEXT         NOT NULL DEFAULT '',
    mpp_run_min_per_pallet   NUMERIC      NOT NULL DEFAULT 0,
    mpp_setup_minutes        NUMERIC      NOT NULL DEFAULT 0,
    mpp_pcs_per_pallet       NUMERIC      NOT NULL DEFAULT 0,
    mpp_pallets_per_cycle    NUMERIC      NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (part_no, bom_code)
);

CREATE INDEX IF NOT EXISTS idx_planner_fa_bom_config_part
    ON public.planner_frame_agreement_bom_config (part_no);

CREATE INDEX IF NOT EXISTS idx_planner_fa_bom_config_updated
    ON public.planner_frame_agreement_bom_config (updated_at DESC);

COMMENT ON TABLE public.planner_frame_agreement_bom_config IS
    'MPP pallet profile per FA part + BOM route — applied to new process sheets with matching part/BOM.';

COMMENT ON COLUMN public.planner_frame_agreement_bom_config.mpp_pcs_per_pallet IS
    'Pieces per pallet for MPP planner (0 = default 1).';

COMMENT ON COLUMN public.planner_frame_agreement_bom_config.mpp_pallets_per_cycle IS
    'Pallets per unattended MPP cycle (0 = default 1).';
