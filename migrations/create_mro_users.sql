-- MRO user accounts, admin approval, and admin-mediated password-reset requests.
-- Safe to re-run: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.mro_users (
    user_id         BIGSERIAL    PRIMARY KEY,
    username        TEXT         NOT NULL,
    email           TEXT         NOT NULL,
    password_hash   TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    approved_at     TIMESTAMPTZ,
    approved_by     TEXT,
    last_login_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mro_users_username_lower
    ON public.mro_users (LOWER(username));

CREATE UNIQUE INDEX IF NOT EXISTS idx_mro_users_email_lower
    ON public.mro_users (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_mro_users_status
    ON public.mro_users (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mro_password_reset_requests (
    request_id      BIGSERIAL    PRIMARY KEY,
    user_id         BIGINT       NOT NULL
        REFERENCES public.mro_users(user_id) ON DELETE CASCADE,
    status          TEXT         NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'rejected')),
    note            TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_mro_password_reset_requests_status
    ON public.mro_password_reset_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mro_password_reset_requests_user
    ON public.mro_password_reset_requests (user_id, created_at DESC);
