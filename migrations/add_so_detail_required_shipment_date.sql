-- Use sales-order required_shipment_date for planner due dates instead of pp_voucher source_rsd.

ALTER TABLE public.so_detail
    ADD COLUMN IF NOT EXISTS required_shipment_date DATE;

DROP VIEW IF EXISTS public.vw_pp_vouchers;

-- View body: sql/vw_pp_vouchers.sql (run _ensure_pp_staging_schema(apply_view=True) or admin fix).
