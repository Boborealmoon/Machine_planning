-- Remove legacy shadow / swap tables (sync no longer uses rename-swap reloads).

DROP TABLE IF EXISTS public.pp_voucher_shadow CASCADE;
DROP TABLE IF EXISTS public.pp_voucher_old CASCADE;
DROP TABLE IF EXISTS public.mfg_process_sheet_info_shadow CASCADE;
DROP TABLE IF EXISTS public.mfg_process_sheet_info_old CASCADE;
DROP TABLE IF EXISTS public.workorder_status_shadow CASCADE;
DROP TABLE IF EXISTS public.workorder_status_old CASCADE;
DROP TABLE IF EXISTS public.sum_qty_shipped_by_sales_order_shadow CASCADE;
DROP TABLE IF EXISTS public.sum_qty_shipped_by_sales_order_old CASCADE;
DROP TABLE IF EXISTS public.so_detail_shadow CASCADE;
DROP TABLE IF EXISTS public.so_detail_old CASCADE;
DROP TABLE IF EXISTS public.part_desc_shadow CASCADE;
DROP TABLE IF EXISTS public.part_desc_old CASCADE;
DROP TABLE IF EXISTS public.pp_partial_shadow CASCADE;
DROP TABLE IF EXISTS public.pp_partial_old CASCADE;
DROP TABLE IF EXISTS public.mfg_wo_status_shadow CASCADE;
DROP TABLE IF EXISTS public.mfg_wo_status_old CASCADE;
DROP TABLE IF EXISTS public.pp_vouchers_cache_shadow CASCADE;
DROP TABLE IF EXISTS public.pp_vouchers_cache_old CASCADE;
