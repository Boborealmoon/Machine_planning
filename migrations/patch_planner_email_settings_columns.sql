-- Repair planner_email_settings when the table exists but columns are missing.
-- Safe to run multiple times in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.planner_email_settings (
    settings_id INTEGER PRIMARY KEY DEFAULT 1 CHECK (settings_id = 1)
);

ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_host TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_port INTEGER NOT NULL DEFAULT 587;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_user TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_password TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_from TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_use_tls BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_timeout_sec INTEGER NOT NULL DEFAULT 30;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_recipients TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_cc TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_bcc TEXT NOT NULL DEFAULT '';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_subject TEXT NOT NULL DEFAULT '[Planner] New Sales Order: {sales_order_no}';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_lookback_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_ps_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_ps_heading TEXT NOT NULL DEFAULT 'Process sheets:';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_ps_line_template TEXT NOT NULL DEFAULT '  - {process_sheet_no} | {part_no} | line {line_item_no} | qty {qty}';
ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO public.planner_email_settings (settings_id)
VALUES (1)
ON CONFLICT (settings_id) DO NOTHING;
