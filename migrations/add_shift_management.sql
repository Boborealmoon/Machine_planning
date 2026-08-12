-- Shift Management (Day/Night handover / takeover).
-- Safe to re-run: uses IF NOT EXISTS + idempotent migrate helpers in Python.

CREATE TABLE IF NOT EXISTS public.shift_mgmt_users (
    user_id         BIGSERIAL    PRIMARY KEY,
    username        TEXT         NOT NULL,
    display_name    TEXT         NOT NULL DEFAULT '',
    password_hash   TEXT         NOT NULL,
    role            TEXT         NOT NULL DEFAULT 'operator'
        CHECK (role IN ('operator', 'supervisor', 'quality', 'admin')),
    default_shift   TEXT
        CHECK (default_shift IS NULL OR default_shift IN ('Day', 'Night')),
    status          TEXT         NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'disabled')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    approved_at     TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_mgmt_users_username_lower
    ON public.shift_mgmt_users (LOWER(username));

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_users_status
    ON public.shift_mgmt_users (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.shift_mgmt_user_machines (
    user_id         BIGINT       NOT NULL
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE CASCADE,
    machine_id      BIGINT       NOT NULL
        REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, machine_id)
);

CREATE TABLE IF NOT EXISTS public.shift_mgmt_handovers (
    handover_id           BIGSERIAL    PRIMARY KEY,
    work_date             DATE         NOT NULL,
    shift_out             TEXT         NOT NULL
        CHECK (shift_out IN ('Day', 'Night')),
    shift_in              TEXT
        CHECK (shift_in IS NULL OR shift_in IN ('Day', 'Night')),
    machine_id            BIGINT       NOT NULL
        REFERENCES public.planner_machines(machine_id) ON DELETE RESTRICT,

    job_no                TEXT         NOT NULL DEFAULT '',
    machine_status        TEXT         NOT NULL DEFAULT 'Running'
        CHECK (machine_status IN (
            'Running', 'Idle', 'Breakdown', 'Under Maintenance', 'Setup'
        )),
    remaining_qty         INTEGER      NOT NULL DEFAULT 0,
    first_piece_status    TEXT         NOT NULL DEFAULT 'N/A'
        CHECK (first_piece_status IN ('OK', 'Not OK', 'Pending Approval', 'N/A')),
    tool_life_pct         NUMERIC(6, 2) NOT NULL DEFAULT 100,
    material_qty          NUMERIC(12, 3),
    material_unit         TEXT         NOT NULL DEFAULT 'pcs'
        CHECK (material_unit IN ('kg', 'pcs', 'm', 'bar')),

    quality_issue_flag    BOOLEAN      NOT NULL DEFAULT FALSE,
    quality_issue_text    TEXT,
    alarm_flag            BOOLEAN      NOT NULL DEFAULT FALSE,
    alarm_text            TEXT,
    maintenance_flag      BOOLEAN      NOT NULL DEFAULT FALSE,
    maintenance_text      TEXT,

    priority              TEXT         NOT NULL DEFAULT 'Normal'
        CHECK (priority IN ('Normal', 'High', 'Urgent')),
    priority_note         TEXT,
    ncr_status            TEXT         NOT NULL DEFAULT 'N/A'
        CHECK (ncr_status IN ('Open', 'Closed', 'N/A')),
    ncr_ref               TEXT,
    remarks               TEXT,

    status                TEXT         NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'pending_ack', 'acknowledged', 'disputed')),

    outgoing_user_id      BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    outgoing_signed_at    TIMESTAMPTZ,
    incoming_user_id      BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    incoming_signed_at    TIMESTAMPTZ,
    incoming_disputed     BOOLEAN      NOT NULL DEFAULT FALSE,
    incoming_dispute_note TEXT,
    supervisor_user_id    BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    supervisor_signed_at  TIMESTAMPTZ,

    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (work_date, shift_out, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_handovers_date
    ON public.shift_mgmt_handovers (work_date DESC, shift_out);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_handovers_machine
    ON public.shift_mgmt_handovers (machine_id, work_date DESC);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_handovers_status
    ON public.shift_mgmt_handovers (status, work_date DESC);

CREATE TABLE IF NOT EXISTS public.shift_mgmt_handover_audit (
    audit_id        BIGSERIAL    PRIMARY KEY,
    handover_id     BIGINT       NOT NULL
        REFERENCES public.shift_mgmt_handovers(handover_id) ON DELETE CASCADE,
    user_id         BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    field_name      TEXT         NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_handover_audit_ho
    ON public.shift_mgmt_handover_audit (handover_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS public.shift_mgmt_handover_comments (
    comment_id      BIGSERIAL    PRIMARY KEY,
    handover_id     BIGINT       NOT NULL
        REFERENCES public.shift_mgmt_handovers(handover_id) ON DELETE CASCADE,
    user_id         BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    body            TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_ho_comments_ho
    ON public.shift_mgmt_handover_comments (handover_id, created_at ASC);

CREATE TABLE IF NOT EXISTS public.shift_mgmt_tickets (
    ticket_id       BIGSERIAL    PRIMARY KEY,
    machine_id      BIGINT       NOT NULL
        REFERENCES public.planner_machines(machine_id) ON DELETE RESTRICT,
    planner_ps_id   TEXT         NOT NULL DEFAULT '',
    job_no          TEXT         NOT NULL DEFAULT '',
    block_id        BIGINT,
    category        TEXT         NOT NULL DEFAULT 'Other'
        CHECK (category IN (
            'Quality', 'Alarm', 'Maintenance', 'Material', 'Tooling', 'Urgent', 'Other'
        )),
    title           TEXT         NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    status          TEXT         NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'closed')),
    priority        TEXT         NOT NULL DEFAULT 'Normal'
        CHECK (priority IN ('Normal', 'High', 'Urgent')),
    created_by      BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    assigned_to     BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    handover_id     BIGINT
        REFERENCES public.shift_mgmt_handovers(handover_id) ON DELETE SET NULL,
    work_date       DATE,
    shift_out       TEXT
        CHECK (shift_out IS NULL OR shift_out IN ('Day', 'Night')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_tickets_machine
    ON public.shift_mgmt_tickets (machine_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_tickets_status
    ON public.shift_mgmt_tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_tickets_ps
    ON public.shift_mgmt_tickets (planner_ps_id, machine_id);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_tickets_shift
    ON public.shift_mgmt_tickets (work_date DESC, shift_out);

CREATE TABLE IF NOT EXISTS public.shift_mgmt_ticket_comments (
    comment_id      BIGSERIAL    PRIMARY KEY,
    ticket_id       BIGINT       NOT NULL
        REFERENCES public.shift_mgmt_tickets(ticket_id) ON DELETE CASCADE,
    user_id         BIGINT
        REFERENCES public.shift_mgmt_users(user_id) ON DELETE SET NULL,
    body            TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_mgmt_ticket_comments_tk
    ON public.shift_mgmt_ticket_comments (ticket_id, created_at ASC);
