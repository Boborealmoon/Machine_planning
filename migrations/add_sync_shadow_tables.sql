-- Phase 1: shadow tables for atomic swap reloads (live table never empty during sync).
-- Applied automatically by ensure_pp_staging_shadow_tables() on first sync when
-- SUPA_DB_URL is set; run manually once if you prefer DDL in SQL editor.

CREATE TABLE IF NOT EXISTS public.pp_voucher_shadow
    (LIKE public.pp_voucher INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.mfg_process_sheet_info_shadow
    (LIKE public.mfg_process_sheet_info INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.workorder_status_shadow
    (LIKE public.workorder_status INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.sum_qty_shipped_by_sales_order_shadow
    (LIKE public.sum_qty_shipped_by_sales_order INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.so_detail_shadow
    (LIKE public.so_detail INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.part_desc_shadow
    (LIKE public.part_desc INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.pp_partial_shadow
    (LIKE public.pp_partial INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.mfg_wo_status_shadow
    (LIKE public.mfg_wo_status INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.pp_vouchers_cache_shadow
    (LIKE public.pp_vouchers_cache INCLUDING ALL);

-- Shadow tables are internal; optional: revoke API access if exposed via PostgREST.
