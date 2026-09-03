-- Sales Coordination buyer note (per PP voucher).
ALTER TABLE public.planner_so_pp_notes
    ADD COLUMN IF NOT EXISTS buyer TEXT NOT NULL DEFAULT '';
