-- Email notification settings (edited via /system UI).
-- Applied automatically on first access; safe to run manually in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.planner_email_settings (
    settings_id          INTEGER      PRIMARY KEY DEFAULT 1 CHECK (settings_id = 1),
    smtp_enabled         BOOLEAN      NOT NULL DEFAULT FALSE,
    smtp_host            TEXT         NOT NULL DEFAULT '',
    smtp_port            INTEGER      NOT NULL DEFAULT 587,
    smtp_user            TEXT         NOT NULL DEFAULT '',
    smtp_password        TEXT         NOT NULL DEFAULT '',
    smtp_from            TEXT         NOT NULL DEFAULT '',
    smtp_use_tls         BOOLEAN      NOT NULL DEFAULT TRUE,
    smtp_timeout_sec     INTEGER      NOT NULL DEFAULT 30,
    new_so_enabled       BOOLEAN      NOT NULL DEFAULT FALSE,
    new_so_recipients    TEXT         NOT NULL DEFAULT '',
    new_so_cc            TEXT         NOT NULL DEFAULT '',
    new_so_bcc           TEXT         NOT NULL DEFAULT '',
    new_so_subject       TEXT         NOT NULL DEFAULT '[Planner] New Sales Order: {sales_order_no}',
    new_so_lookback_days INTEGER      NOT NULL DEFAULT 7,
    new_so_ps_enabled    BOOLEAN      NOT NULL DEFAULT TRUE,
    new_so_ps_heading    TEXT         NOT NULL DEFAULT 'Process sheets:',
    new_so_ps_line_template TEXT      NOT NULL DEFAULT '  - {process_sheet_no} | {part_no} | line {line_item_no} | qty {qty}',
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO public.planner_email_settings (settings_id)
VALUES (1)
ON CONFLICT (settings_id) DO NOTHING;

COMMENT ON TABLE public.planner_email_settings IS
    'Singleton email/SMTP settings configured from the System page.';
