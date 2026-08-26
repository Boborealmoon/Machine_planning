-- Planner-managed material need date on Material Tracking (per PP voucher).
ALTER TABLE public.planner_so_pp_notes
    ADD COLUMN IF NOT EXISTS material_need_date DATE;
