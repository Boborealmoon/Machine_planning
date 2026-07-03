-- Track sales-order notification emails (dedupe across ERP sync runs).
-- Applied automatically on first email send; safe to run manually in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.planner_email_notification (
    notification_id   BIGSERIAL    PRIMARY KEY,
    trigger_type      TEXT         NOT NULL,
    sales_order_no    TEXT         NOT NULL,
    subject           TEXT         NOT NULL DEFAULT '',
    recipients        TEXT         NOT NULL DEFAULT '',
    sent_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (trigger_type, sales_order_no)
);

CREATE INDEX IF NOT EXISTS idx_planner_email_notification_sent_at
    ON public.planner_email_notification (sent_at DESC);

COMMENT ON TABLE public.planner_email_notification IS
    'One row per trigger/email sent (e.g. new_sales_order) to avoid duplicate notifications.';
