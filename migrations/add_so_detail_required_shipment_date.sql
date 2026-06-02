-- Use sales-order required_shipment_date for planner due dates instead of pp_voucher source_rsd.

ALTER TABLE public.so_detail
    ADD COLUMN IF NOT EXISTS required_shipment_date DATE;

DROP VIEW IF EXISTS public.vw_pp_vouchers;

-- View body matches app.py _VW_PP_VOUCHERS_SQL (run /api/pp-staging/sync or _ensure_pp_staging_schema).
