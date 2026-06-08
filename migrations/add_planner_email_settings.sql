-- Daily planner email: recipients, schedule, and send history.

CREATE TABLE IF NOT EXISTS public.planner_email_settings (
    settings_id       BIGSERIAL    PRIMARY KEY,
    enabled           BOOLEAN      NOT NULL DEFAULT FALSE,
    recipient_emails  TEXT         NOT NULL DEFAULT '',
    send_time_local   TIME         NOT NULL DEFAULT '07:00',
    email_subject     TEXT         NOT NULL DEFAULT 'Daily Production Planner — {date}',
    last_sent_at      TIMESTAMPTZ,
    last_send_status  TEXT         NOT NULL DEFAULT '',
    last_send_message TEXT         NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.planner_email_send_log (
    log_id            BIGSERIAL    PRIMARY KEY,
    sent_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status            TEXT         NOT NULL,
    recipient_emails  TEXT         NOT NULL DEFAULT '',
    subject           TEXT         NOT NULL DEFAULT '',
    message           TEXT         NOT NULL DEFAULT '',
    attachment_name   TEXT         NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_planner_email_send_log_sent_at
    ON public.planner_email_send_log (sent_at DESC);

-- Seed a single settings row when the table is empty.
INSERT INTO public.planner_email_settings (enabled, recipient_emails, send_time_local, email_subject)
SELECT FALSE, '', TIME '07:00', 'Daily Production Planner — {date}'
WHERE NOT EXISTS (SELECT 1 FROM public.planner_email_settings);
