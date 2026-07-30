-- Purchaser material-arrival delay flag on Material Tracking (per PP voucher).
ALTER TABLE public.planner_so_pp_notes
    ADD COLUMN IF NOT EXISTS material_delay BOOLEAN NOT NULL DEFAULT FALSE;
