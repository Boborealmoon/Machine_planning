-- ERP BOM route from PP voucher (resolved via process sheet no on sync).
-- Run in Supabase SQL editor, then Project Settings → API → Reload schema.

ALTER TABLE public.planner_program_tools
    ADD COLUMN IF NOT EXISTS bom_code TEXT;

COMMENT ON COLUMN public.planner_program_tools.bom_code IS
    'Exact ERP BOM route from mfg_pp_vch for the sheet P/S NO.; used with part_no_erp for key matching.';
