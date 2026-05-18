-- =============================================================================
-- schema_planner.sql  —  Planning module tables for Supabase (PostgreSQL)
-- =============================================================================
--
-- Run this file once in your Supabase SQL editor to create the planning layer.
-- All tables are prefixed  planner_  to keep them visually separate from the
-- existing ERP sync tables (pp_voucher, bom_op_stage, pp_vouchers_cache, etc.)
--
-- EXISTING SUPABASE TABLES USED AS SOFT REFERENCES (no schema changes needed):
--   part_desc           inventory_code  →  part identifier + description
--   material_per_bom    seed data for material requirements per BOM
--   bom_op_stage        seed data for operation sequences per BOM
--   pp_vouchers_cache   base PS data joined at query time
--
-- WHY SOFT REFERENCES?
--   pp_vouchers_cache and bom_op_stage are periodically deleted and reloaded by
--   the sync pipeline. Hard FK constraints would block those reloads. We store
--   the natural text keys (inventory_code, source_ps_id) and join at query time.
--
-- planner_ps_id CONVENTION:
--   planner_ps_id = source_ps_id || '::' || pp_partial_no
--   e.g. 'APS12345::1'  or  'APS12345::2'
--   Native ERP ps_ids only contain alphanumerics and hyphens, so '::' is a
--   safe delimiter. This matches the application-layer encoding already in use.
-- =============================================================================


-- =============================================================================
-- GROUP A: Reference / Static Data
-- Managed by admin; rarely changes once set up.
-- =============================================================================

-- Machine registry. Replaces the hard-coded TRIAL_MACHINES list in constants.py.
CREATE TABLE IF NOT EXISTS public.planner_machines (
    machine_id        BIGSERIAL    PRIMARY KEY,
    machine_no        TEXT         NOT NULL,        -- e.g. 'CNC 10', 'CNC 30'
    machine_category  TEXT         NOT NULL,        -- TURNING | MILLING | TURNMILL | MPP
    shift_profile     TEXT         NOT NULL DEFAULT 'STANDARD',  -- STANDARD | 24HR
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    notes             TEXT         NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (machine_no)
);

-- Shift capacity profiles (replaces hard-coded CAPACITY_PROFILES in constants.py).
-- Seed rows are inserted at the bottom of this file.
CREATE TABLE IF NOT EXISTS public.planner_capacity_profile (
    profile_id        BIGSERIAL    PRIMARY KEY,
    profile_name      TEXT         NOT NULL,
    capacity_minutes  INTEGER      NOT NULL DEFAULT 0,   -- total productive minutes in shift
    start_minute      INTEGER      NOT NULL DEFAULT 510, -- shift start offset from midnight (510 = 08:30)
    note              TEXT         NOT NULL DEFAULT '',
    UNIQUE (profile_name)
);

-- Per-day capacity overrides (public holidays, ad-hoc OT, partial days).
-- When a row exists for (machine_id, work_date) it overrides the default profile.
CREATE TABLE IF NOT EXISTS public.planner_machine_capacity_day (
    day_id            BIGSERIAL    PRIMARY KEY,
    machine_id        BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    work_date         DATE         NOT NULL,
    profile_id        BIGINT       NOT NULL REFERENCES public.planner_capacity_profile(profile_id),
    capacity_minutes  INTEGER      NOT NULL DEFAULT 0,
    start_minute      INTEGER      NOT NULL DEFAULT 510,
    note              TEXT         NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (machine_id, work_date)
);

-- Public / company-wide holidays (all machines OFF on these dates).
CREATE TABLE IF NOT EXISTS public.planner_public_holiday (
    holiday_date  DATE         PRIMARY KEY,
    note          TEXT         NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Capacity overlay windows: maintenance shutdowns, overtime blocks, etc.
-- window_type: MAINTENANCE | BLOCKED | OVERTIME | AVAILABLE
-- These are consumed by the scheduler on top of the base shift profile.
CREATE TABLE IF NOT EXISTS public.planner_machine_calendar_window (
    window_id         BIGSERIAL    PRIMARY KEY,
    machine_id        BIGINT       REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    start_at          TIMESTAMPTZ  NOT NULL,
    end_at            TIMESTAMPTZ  NOT NULL,
    window_type       TEXT         NOT NULL,
    capacity_minutes  INTEGER      NOT NULL DEFAULT 0,
    note              TEXT         NOT NULL DEFAULT '',
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- =============================================================================
-- GROUP B: BOM / Flow Planning Layer
-- Sits on top of ERP data. Seeded from bom_op_stage but independently
-- maintained so planners can customise cycle times, preferred machines, etc.
-- =============================================================================

-- Named flow variants per inventory_code (part).
-- inventory_code soft-references part_desc.inventory_code.
-- bom_code relates to bom_op_stage.bom_code for initial seeding.
CREATE TABLE IF NOT EXISTS public.planner_bom_variation (
    bom_id          BIGSERIAL    PRIMARY KEY,
    inventory_code  TEXT         NOT NULL,   -- part identifier, matches part_desc.inventory_code
    bom_code        TEXT         NOT NULL,   -- flow/BOM code, e.g. 'BOM-A', 'STD'
    bom_desc        TEXT         NOT NULL DEFAULT '',
    is_default      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (inventory_code, bom_code)
);

-- Planning-specific operation steps per BOM flow.
-- Extends bom_op_stage with: machine_category, preferred_machine, is_last_op.
-- Seeding notes:
--   bom_op_stage.stage_desc (e.g. 'Turning 10') → op_type + op_no
--   bom_op_stage.machine_no                      → preferred_machine
--   bom_op_stage.setup_time / cycle_time          → setup_time / cycle_time
CREATE TABLE IF NOT EXISTS public.planner_operation_seq (
    op_seq_id         BIGSERIAL    PRIMARY KEY,
    bom_id            BIGINT       NOT NULL REFERENCES public.planner_bom_variation(bom_id) ON DELETE CASCADE,
    seq_no            INTEGER      NOT NULL,
    op_no             TEXT         NOT NULL,
    op_type           TEXT         NOT NULL,   -- Turning | Milling | Turnmill
    machine_category  TEXT         NOT NULL,   -- TURNING | MILLING | TURNMILL | MPP
    cycle_time        NUMERIC      NOT NULL DEFAULT 1,    -- minutes per piece
    setup_time        NUMERIC      NOT NULL DEFAULT 0,    -- minutes (one-off per block)
    preferred_machine TEXT         NOT NULL DEFAULT '',   -- planner_machines.machine_no
    is_last_op        BOOLEAN      NOT NULL DEFAULT FALSE,
    UNIQUE (bom_id, seq_no, op_no)
);


-- =============================================================================
-- GROUP C: Process Sheet Planning Layer
-- One planning record per (source_ps_id, pp_partial_no).
-- Stores ONLY planner-managed fields. All ERP base data (part_no, description,
-- total_qty, due_date, order_date) is read from pp_vouchers_cache at query time.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.planner_process_sheet (
    planner_ps_id   TEXT         PRIMARY KEY,  -- source_ps_id || '::' || pp_partial_no
    source_ps_id    TEXT         NOT NULL,     -- matches pp_vouchers_cache.ps_id
    pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
    inventory_code  TEXT         NOT NULL DEFAULT '',  -- matches part_desc.inventory_code
    selected_bom_id BIGINT       REFERENCES public.planner_bom_variation(bom_id) ON DELETE SET NULL,
    planner_status  TEXT         NOT NULL DEFAULT 'UNPLANNED',
    -- UNPLANNED | PARTIALLY_PLANNED | PLANNED | NEEDS_REVIEW | COMPLETED
    status          TEXT         NOT NULL DEFAULT 'ACTIVE',
    -- ACTIVE | COMPLETED | ON_HOLD
    planned_qty     NUMERIC      NOT NULL DEFAULT 0,
    finished_qty    NUMERIC      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (source_ps_id, pp_partial_no)
);


-- =============================================================================
-- GROUP D: Scheduling Engine Core
-- =============================================================================

-- Planned operations derived from (process sheet + selected BOM flow).
-- source_ps_id here is the planner_ps_id (i.e. includes :: encoding).
CREATE TABLE IF NOT EXISTS public.planner_operation (
    operation_id              BIGSERIAL    PRIMARY KEY,
    job_no                    TEXT         NOT NULL,
    operation_name            TEXT         NOT NULL,
    total_qty                 NUMERIC      NOT NULL DEFAULT 0,
    setup_minutes             NUMERIC      NOT NULL DEFAULT 0,
    cycle_minutes_per_qty     NUMERIC      NOT NULL DEFAULT 0,
    compatible_machine_group  TEXT         NOT NULL DEFAULT '',
    source_ps_id              TEXT         NOT NULL DEFAULT '',  -- planner_process_sheet.planner_ps_id
    source_op_seq_id          BIGINT       NOT NULL DEFAULT 0,   -- planner_operation_seq.op_seq_id
    source_op_no              TEXT         NOT NULL DEFAULT '',
    status                    TEXT         NOT NULL DEFAULT 'ACTIVE',
    remarks                   TEXT         NOT NULL DEFAULT '',
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Groups of simultaneously-scheduled operations (combined planning cards).
CREATE TABLE IF NOT EXISTS public.planner_run_block_group (
    group_id    BIGSERIAL    PRIMARY KEY,
    group_label TEXT         NOT NULL DEFAULT '',
    group_type  TEXT         NOT NULL DEFAULT 'COMBINED',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- A scheduled execution block: one operation on one machine, with a queue position.
CREATE TABLE IF NOT EXISTS public.planner_run_block (
    block_id                   BIGSERIAL    PRIMARY KEY,
    operation_id               BIGINT       NOT NULL REFERENCES public.planner_operation(operation_id) ON DELETE CASCADE,
    machine_id                 BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    queue_position             INTEGER      NOT NULL DEFAULT 0,
    scheduled_qty              NUMERIC      NOT NULL DEFAULT 0,
    include_setup              BOOLEAN      NOT NULL DEFAULT TRUE,
    status                     TEXT         NOT NULL DEFAULT 'PLANNED',
    anchor_datetime            TIMESTAMPTZ,
    calculated_start_datetime  TIMESTAMPTZ,
    calculated_end_datetime    TIMESTAMPTZ,
    planned_start_at           TIMESTAMPTZ,
    planned_end_at             TIMESTAMPTZ,
    actual_good_qty            NUMERIC      NOT NULL DEFAULT 0,
    actual_reject_qty          NUMERIC      NOT NULL DEFAULT 0,
    remarks                    TEXT         NOT NULL DEFAULT '',
    block_type                 TEXT         NOT NULL DEFAULT 'ORIGINAL',  -- ORIGINAL | REWORK
    source_reject_block_id     BIGINT       REFERENCES public.planner_run_block(block_id) ON DELETE SET NULL,
    source_reject_segment_id   BIGINT,      -- populated when block was created from a reject
    planning_status            TEXT         NOT NULL DEFAULT 'UNPLANNED',
    execution_status           TEXT         NOT NULL DEFAULT 'NOT_STARTED',
    anchor_status              TEXT         NOT NULL DEFAULT 'NONE',
    anchor_miss_minutes        NUMERIC      NOT NULL DEFAULT 0,
    group_id                   BIGINT       REFERENCES public.planner_run_block_group(group_id) ON DELETE SET NULL,
    active                     BOOLEAN      NOT NULL DEFAULT TRUE,
    allow_pull_forward         BOOLEAN      NOT NULL DEFAULT TRUE,
    planned_qty_original       NUMERIC      NOT NULL DEFAULT 0,
    split_from_block_id        BIGINT       REFERENCES public.planner_run_block(block_id) ON DELETE SET NULL,
    scheduler_note             TEXT         NOT NULL DEFAULT '',
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Time segments within a run block. Each segment is one day's slice of work
-- (setup or production), with exact start/end times.
CREATE TABLE IF NOT EXISTS public.planner_run_block_segment (
    segment_id       BIGSERIAL    PRIMARY KEY,
    block_id         BIGINT       NOT NULL REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    machine_id       BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    segment_date     DATE         NOT NULL,
    segment_type     TEXT         NOT NULL,   -- setup | production
    qty_done         NUMERIC      NOT NULL DEFAULT 0,
    minutes_used     NUMERIC      NOT NULL DEFAULT 0,
    planned_qty      NUMERIC      NOT NULL DEFAULT 0,
    planned_minutes  NUMERIC      NOT NULL DEFAULT 0,
    start_datetime   TIMESTAMPTZ  NOT NULL,
    end_datetime     TIMESTAMPTZ  NOT NULL,
    is_actual        BOOLEAN      NOT NULL DEFAULT FALSE,
    segment_status   TEXT         NOT NULL DEFAULT 'PLANNED',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Actual production output reported against a run block.
CREATE TABLE IF NOT EXISTS public.planner_production_actual (
    actual_id                BIGSERIAL    PRIMARY KEY,
    block_id                 BIGINT       NOT NULL REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    report_date              DATE         NOT NULL,
    remarks                  TEXT         NOT NULL DEFAULT '',
    reported_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    segment_id               BIGINT       REFERENCES public.planner_run_block_segment(segment_id) ON DELETE SET NULL,
    machine_id               BIGINT       REFERENCES public.planner_machines(machine_id) ON DELETE SET NULL,
    output_qty               NUMERIC,
    reject_qty               NUMERIC,
    target_qty_at_report     NUMERIC,
    good_qty_at_report       NUMERIC,
    status                   TEXT         NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | VOIDED
    entry_type               TEXT         NOT NULL DEFAULT 'REPORT',  -- REPORT | CORRECTION
    correction_of_actual_id  BIGINT       REFERENCES public.planner_production_actual(actual_id) ON DELETE SET NULL,
    created_by               TEXT         NOT NULL DEFAULT ''
);


-- =============================================================================
-- GROUP E: Material Planning
-- Per-PS material requirements. Planner manages supply status and ready dates.
-- Raw BOM material list is seeded from material_per_bom for the selected BOM.
-- No hard FK to material_per_bom — it is a sync/reload table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.planner_material_requirement (
    requirement_id           BIGSERIAL    PRIMARY KEY,
    planner_ps_id            TEXT         NOT NULL REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    source_inventory_code    TEXT         NOT NULL DEFAULT '',  -- matches material_per_bom.source_inventory_code
    bom_code                 TEXT         NOT NULL DEFAULT '',
    material_inventory_code  TEXT         NOT NULL DEFAULT '',
    material_description     TEXT         NOT NULL DEFAULT '',
    material_qty_needed      NUMERIC      NOT NULL DEFAULT 0,
    material_uom             TEXT         NOT NULL DEFAULT '',
    supply_status            TEXT         NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    -- PENDING_CONFIRMATION | READY | ORDERED | DELAYED | NOT_REQUIRED
    expected_ready_date      DATE,
    supplier_ref             TEXT         NOT NULL DEFAULT '',
    remarks                  TEXT         NOT NULL DEFAULT '',
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (planner_ps_id, material_inventory_code)
);


-- =============================================================================
-- GROUP F: Planning Cards
-- User-defined batch cards for scheduling multiple operations simultaneously.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.planner_planning_card (
    card_id                   BIGSERIAL    PRIMARY KEY,
    planner_ps_id             TEXT         NOT NULL REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    operation_label           TEXT         NOT NULL DEFAULT '',
    target_qty                NUMERIC      NOT NULL DEFAULT 0,
    planning_status           TEXT         NOT NULL DEFAULT 'UNSCHEDULED',
    card_type                 TEXT         NOT NULL DEFAULT 'NORMAL',
    machine_id                BIGINT       REFERENCES public.planner_machines(machine_id) ON DELETE SET NULL,
    machine_queue_index       INTEGER,
    scheduled_block_group_id  BIGINT       REFERENCES public.planner_run_block_group(group_id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.planner_planning_card_operation (
    card_op_id             BIGSERIAL  PRIMARY KEY,
    card_id                BIGINT     NOT NULL REFERENCES public.planner_planning_card(card_id) ON DELETE CASCADE,
    source_ps_id           TEXT       NOT NULL DEFAULT '',   -- planner_process_sheet.planner_ps_id
    source_op_seq_id       BIGINT     NOT NULL DEFAULT 0,
    source_op_no           TEXT       NOT NULL DEFAULT '',
    op_sequence            INTEGER    NOT NULL DEFAULT 0,
    setup_minutes          NUMERIC    NOT NULL DEFAULT 0,
    cycle_minutes_per_qty  NUMERIC    NOT NULL DEFAULT 0,
    target_qty             NUMERIC    NOT NULL DEFAULT 0
);


-- =============================================================================
-- GROUP G: Scheduler State & Logging
-- =============================================================================

-- Tracks each full or partial schedule recalculation run.
CREATE TABLE IF NOT EXISTS public.planner_schedule_run (
    schedule_run_id  BIGSERIAL    PRIMARY KEY,
    reason           TEXT         NOT NULL,
    status           TEXT         NOT NULL DEFAULT 'CURRENT',  -- CURRENT | SUPERSEDED | FAILED
    generated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    scope_type       TEXT         NOT NULL DEFAULT 'FULL',     -- FULL | MACHINE
    machine_id       BIGINT       REFERENCES public.planner_machines(machine_id) ON DELETE SET NULL,
    notes            TEXT         NOT NULL DEFAULT '',
    change_summary   JSONB,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Add deferred FKs to tables created before planner_schedule_run existed.
ALTER TABLE public.planner_run_block
    ADD COLUMN IF NOT EXISTS last_schedule_run_id BIGINT
        REFERENCES public.planner_schedule_run(schedule_run_id) ON DELETE SET NULL;

ALTER TABLE public.planner_run_block_segment
    ADD COLUMN IF NOT EXISTS schedule_run_id BIGINT
        REFERENCES public.planner_schedule_run(schedule_run_id) ON DELETE SET NULL;

-- Planner alerts: capacity conflicts, predicted end changes, overdue warnings.
CREATE TABLE IF NOT EXISTS public.planner_schedule_alert (
    alert_id          BIGSERIAL    PRIMARY KEY,
    schedule_run_id   BIGINT       REFERENCES public.planner_schedule_run(schedule_run_id) ON DELETE SET NULL,
    block_id          BIGINT       REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    operation_id      BIGINT       REFERENCES public.planner_operation(operation_id) ON DELETE SET NULL,
    planner_ps_id     TEXT         REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    machine_id        BIGINT       REFERENCES public.planner_machines(machine_id) ON DELETE SET NULL,
    alert_type        TEXT         NOT NULL,
    severity          TEXT         NOT NULL DEFAULT 'INFO',   -- INFO | WARNING | ERROR
    message           TEXT         NOT NULL DEFAULT '',
    old_value         TEXT         NOT NULL DEFAULT '',
    new_value         TEXT         NOT NULL DEFAULT '',
    planned_at        TIMESTAMPTZ,
    predicted_at      TIMESTAMPTZ,
    delay_minutes     NUMERIC      NOT NULL DEFAULT 0,
    status            TEXT         NOT NULL DEFAULT 'OPEN',  -- OPEN | ACKNOWLEDGED | RESOLVED
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at       TIMESTAMPTZ
);

-- Rework linkage: traces a rework block back to the reject that created it.
CREATE TABLE IF NOT EXISTS public.planner_rework_link (
    rework_link_id   BIGSERIAL  PRIMARY KEY,
    source_actual_id BIGINT     REFERENCES public.planner_production_actual(actual_id) ON DELETE SET NULL,
    source_block_id  BIGINT     REFERENCES public.planner_run_block(block_id) ON DELETE SET NULL,
    rework_block_id  BIGINT     NOT NULL REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    reject_qty       NUMERIC    NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (rework_block_id)
);

-- Import log for Excel workbook uploads (Process Sheets, BOM, Materials sheets).
CREATE TABLE IF NOT EXISTS public.planner_data_import_log (
    log_id             BIGSERIAL    PRIMARY KEY,
    import_type        TEXT         NOT NULL,
    workbook_name      TEXT         NOT NULL DEFAULT '',
    active_sheet_name  TEXT         NOT NULL DEFAULT '',
    status             TEXT         NOT NULL DEFAULT 'STARTED',  -- STARTED | SUCCESS | FAILED
    message            TEXT         NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at       TIMESTAMPTZ
);


-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_planner_machines_category
    ON public.planner_machines(machine_category);

CREATE INDEX IF NOT EXISTS idx_planner_machine_cap_day_machine
    ON public.planner_machine_capacity_day(machine_id, work_date);

CREATE INDEX IF NOT EXISTS idx_planner_machine_cal_window
    ON public.planner_machine_calendar_window(machine_id, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_planner_machine_cal_window_active
    ON public.planner_machine_calendar_window(active, window_type);

CREATE INDEX IF NOT EXISTS idx_planner_bom_variation_inv_code
    ON public.planner_bom_variation(inventory_code);

CREATE INDEX IF NOT EXISTS idx_planner_operation_seq_bom_id
    ON public.planner_operation_seq(bom_id);

CREATE INDEX IF NOT EXISTS idx_planner_process_sheet_source
    ON public.planner_process_sheet(source_ps_id, pp_partial_no);

CREATE INDEX IF NOT EXISTS idx_planner_process_sheet_inv_code
    ON public.planner_process_sheet(inventory_code);

CREATE INDEX IF NOT EXISTS idx_planner_process_sheet_status
    ON public.planner_process_sheet(planner_status, status);

CREATE INDEX IF NOT EXISTS idx_planner_operation_source_ps
    ON public.planner_operation(source_ps_id);

CREATE INDEX IF NOT EXISTS idx_planner_run_block_machine_queue
    ON public.planner_run_block(machine_id, active, queue_position);

-- Per-machine queue sequence for scheduled run blocks (drag order within / across lanes).
CREATE TABLE IF NOT EXISTS public.planner_operation_sequence (
    operation_sequence_id  BIGSERIAL    PRIMARY KEY,
    machine_id             BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    block_id               BIGINT       NOT NULL REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    sequence_no            INTEGER      NOT NULL,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (block_id)
);

CREATE INDEX IF NOT EXISTS idx_planner_operation_sequence_machine
    ON public.planner_operation_sequence(machine_id, sequence_no);

ALTER TABLE public.planner_run_block
    ADD COLUMN IF NOT EXISTS operation_sequence_id BIGINT
        REFERENCES public.planner_operation_sequence(operation_sequence_id) ON DELETE SET NULL;

ALTER TABLE public.planner_planning_card
    ADD COLUMN IF NOT EXISTS machine_queue_index INTEGER;

ALTER TABLE public.planner_planning_card
    ADD COLUMN IF NOT EXISTS operation_sequence_id BIGINT
        REFERENCES public.planner_operation_sequence(operation_sequence_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_planner_planning_card_machine_queue
    ON public.planner_planning_card(machine_id, machine_queue_index);

CREATE INDEX IF NOT EXISTS idx_planner_run_block_operation
    ON public.planner_run_block(operation_id);

CREATE INDEX IF NOT EXISTS idx_planner_run_block_schedule_run
    ON public.planner_run_block(last_schedule_run_id);

CREATE INDEX IF NOT EXISTS idx_planner_run_block_seg_block
    ON public.planner_run_block_segment(block_id);

CREATE INDEX IF NOT EXISTS idx_planner_run_block_seg_machine_date
    ON public.planner_run_block_segment(machine_id, segment_date);

CREATE INDEX IF NOT EXISTS idx_planner_run_block_seg_schedule_run
    ON public.planner_run_block_segment(schedule_run_id);

CREATE INDEX IF NOT EXISTS idx_planner_production_actual_block
    ON public.planner_production_actual(block_id, status);

CREATE INDEX IF NOT EXISTS idx_planner_production_actual_date
    ON public.planner_production_actual(report_date);

CREATE INDEX IF NOT EXISTS idx_planner_production_actual_correction
    ON public.planner_production_actual(correction_of_actual_id);

CREATE INDEX IF NOT EXISTS idx_planner_material_req_ps
    ON public.planner_material_requirement(planner_ps_id);

CREATE INDEX IF NOT EXISTS idx_planner_schedule_run_status
    ON public.planner_schedule_run(status);

CREATE INDEX IF NOT EXISTS idx_planner_schedule_alert_block
    ON public.planner_schedule_alert(block_id);

CREATE INDEX IF NOT EXISTS idx_planner_schedule_alert_status
    ON public.planner_schedule_alert(status, severity);

CREATE INDEX IF NOT EXISTS idx_planner_schedule_alert_ps
    ON public.planner_schedule_alert(planner_ps_id);

CREATE INDEX IF NOT EXISTS idx_planner_schedule_alert_run
    ON public.planner_schedule_alert(schedule_run_id);

-- One open/acknowledged alert per block+type (prevents duplicates during recalc).
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_alert_open_block_type
    ON public.planner_schedule_alert(block_id, alert_type)
    WHERE status IN ('OPEN', 'ACKNOWLEDGED');


-- =============================================================================
-- SEED DATA
-- =============================================================================

-- Capacity profiles (from Vanessa's constants.py CAPACITY_PROFILES).
INSERT INTO public.planner_capacity_profile (profile_name, capacity_minutes, start_minute, note)
VALUES
    ('NORMAL_DAY_NIGHT', 630,  510, 'Weekday shift 08:30–20:00'),
    ('SATURDAY',         420,  510, 'Saturday shift 08:30–16:15'),
    ('FULL_24H',        1440,    0, '24-hour coverage'),
    ('OFF',                0,    0, 'Off')
ON CONFLICT (profile_name) DO NOTHING;

-- Machines (from Vanessa's constants.py TRIAL_MACHINES).
-- Edit machine_no / machine_category / shift_profile to match your actual fleet.
-- shift_profile must match a profile_name in planner_capacity_profile.
-- STANDARD machines use NORMAL_DAY_NIGHT on weekdays, SATURDAY on Saturdays.
-- 24HR machines use FULL_24H every day.
INSERT INTO public.planner_machines (machine_no, machine_category, shift_profile, active)
VALUES
    ('CNC 10', 'TURNING',  'STANDARD', TRUE),
    ('CNC 15', 'TURNING',  'STANDARD', TRUE),
    ('CNC 20', 'MILLING',  'STANDARD', TRUE),
    ('CNC 21', 'TURNING',  'STANDARD', TRUE),
    ('CNC 22', 'TURNING',  'STANDARD', TRUE),
    ('CNC 24', 'TURNING',  'STANDARD', TRUE),
    ('CNC 25', 'MILLING',  'STANDARD', TRUE),
    ('CNC 26', 'MILLING',  'STANDARD', TRUE),
    ('CNC 27', 'TURNING',  'STANDARD', TRUE),
    ('CNC 29', 'MILLING',  'STANDARD', TRUE),
    ('CNC 30', 'TURNING',  'STANDARD', TRUE),
    ('CNC 31', 'TURNING',  'STANDARD', TRUE),
    ('CNC 32', 'TURNING',  'STANDARD', TRUE),
    ('CNC 35', 'MPP',      '24HR',     TRUE),
    ('CNC 36', 'MPP',      '24HR',     TRUE),
    ('CNC 38', 'TURNMILL', 'STANDARD', TRUE),
    ('CNC 39', 'TURNMILL', 'STANDARD', TRUE),
    ('CNC 40', 'TURNMILL', 'STANDARD', TRUE)
ON CONFLICT (machine_no) DO NOTHING;


-- =============================================================================
-- CONVENIENCE VIEWS
-- Equivalent to Vanessa's SQLite v_block_actual_totals / v_block_remaining views.
-- Used by the scheduler engine for remaining-qty calculations.
-- =============================================================================

CREATE OR REPLACE VIEW public.planner_v_block_actual_totals AS
SELECT
    block_id,
    COALESCE(SUM(COALESCE(output_qty, 0)), 0)                               AS output_qty,
    COALESCE(SUM(COALESCE(reject_qty,  0)), 0)                              AS reject_qty,
    COALESCE(SUM(COALESCE(output_qty, 0) - COALESCE(reject_qty, 0)), 0)    AS good_qty,
    COUNT(*) FILTER (WHERE output_qty IS NOT NULL)                          AS output_reports,
    COUNT(*) FILTER (WHERE reject_qty  IS NOT NULL)                         AS reject_reports
FROM public.planner_production_actual
WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
GROUP BY block_id;

CREATE OR REPLACE VIEW public.planner_v_block_remaining AS
SELECT
    b.block_id,
    b.scheduled_qty,
    COALESCE(v.good_qty, 0)                                                  AS good_qty,
    GREATEST(0, b.scheduled_qty - COALESCE(v.good_qty, 0))                  AS remaining_qty
FROM public.planner_run_block b
LEFT JOIN public.planner_v_block_actual_totals v ON v.block_id = b.block_id;

CREATE OR REPLACE VIEW public.planner_v_operation_actual_totals AS
SELECT
    b.operation_id,
    COALESCE(SUM(COALESCE(a.output_qty, 0)), 0)                              AS output_qty,
    COALESCE(SUM(COALESCE(a.reject_qty,  0)), 0)                             AS reject_qty,
    COALESCE(SUM(COALESCE(a.output_qty, 0) - COALESCE(a.reject_qty, 0)), 0) AS good_qty,
    COUNT(*) FILTER (WHERE a.output_qty IS NOT NULL)                         AS output_reports,
    COUNT(*) FILTER (WHERE a.reject_qty  IS NOT NULL)                        AS reject_reports
FROM public.planner_run_block b
JOIN public.planner_production_actual a ON a.block_id = b.block_id
WHERE COALESCE(a.status, 'ACTIVE') = 'ACTIVE'
GROUP BY b.operation_id;

CREATE OR REPLACE VIEW public.planner_v_operation_remaining AS
SELECT
    o.operation_id,
    o.total_qty                                                               AS required_qty,
    COALESCE(v.good_qty, 0)                                                  AS good_qty,
    GREATEST(0, o.total_qty - COALESCE(v.good_qty, 0))                       AS remaining_qty
FROM public.planner_operation o
LEFT JOIN public.planner_v_operation_actual_totals v ON v.operation_id = o.operation_id;


-- =============================================================================
-- GROUP H: Scheduler State Cache Tables
-- Written by the scheduler engine; read by the Gantt chart and dashboard APIs.
-- =============================================================================

-- Live schedule state snapshot for each run block (replaces SQLite machine_queue_state).
CREATE TABLE IF NOT EXISTS public.planner_machine_queue_state (
    block_id           BIGINT       PRIMARY KEY REFERENCES public.planner_run_block(block_id) ON DELETE CASCADE,
    schedule_run_id    BIGINT       REFERENCES public.planner_schedule_run(schedule_run_id),
    predicted_start_at TIMESTAMPTZ,
    predicted_end_at   TIMESTAMPTZ,
    remaining_qty      NUMERIC      NOT NULL DEFAULT 0,
    output_qty         NUMERIC      NOT NULL DEFAULT 0,
    reject_qty         NUMERIC      NOT NULL DEFAULT 0,
    good_qty           NUMERIC      NOT NULL DEFAULT 0,
    planned_minutes    NUMERIC      NOT NULL DEFAULT 0,
    schedule_status    TEXT         NOT NULL DEFAULT 'UNSCHEDULED',
    execution_status   TEXT         NOT NULL DEFAULT 'NOT_STARTED',
    is_late            BOOLEAN      NOT NULL DEFAULT FALSE,
    delay_minutes      NUMERIC      NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Rolled-up execution state per operation (replaces SQLite process_sheet_operation_state).
CREATE TABLE IF NOT EXISTS public.planner_process_sheet_operation_state (
    operation_id       BIGINT       PRIMARY KEY REFERENCES public.planner_operation(operation_id) ON DELETE CASCADE,
    planner_ps_id      TEXT         REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    output_qty         NUMERIC      NOT NULL DEFAULT 0,
    reject_qty         NUMERIC      NOT NULL DEFAULT 0,
    good_qty           NUMERIC      NOT NULL DEFAULT 0,
    remaining_qty      NUMERIC      NOT NULL DEFAULT 0,
    predicted_start_at TIMESTAMPTZ,
    predicted_end_at   TIMESTAMPTZ,
    execution_status   TEXT         NOT NULL DEFAULT 'NOT_STARTED',
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Rolled-up execution state per planner PS (replaces SQLite process_sheet_state).
CREATE TABLE IF NOT EXISTS public.planner_process_sheet_state (
    planner_ps_id      TEXT         PRIMARY KEY REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
    predicted_start_at TIMESTAMPTZ,
    predicted_end_at   TIMESTAMPTZ,
    output_qty         NUMERIC      NOT NULL DEFAULT 0,
    reject_qty         NUMERIC      NOT NULL DEFAULT 0,
    good_qty           NUMERIC      NOT NULL DEFAULT 0,
    remaining_qty      NUMERIC      NOT NULL DEFAULT 0,
    planner_status     TEXT         NOT NULL DEFAULT 'UNPLANNED',
    execution_status   TEXT         NOT NULL DEFAULT 'NOT_STARTED',
    is_late            BOOLEAN      NOT NULL DEFAULT FALSE,
    delay_minutes      NUMERIC      NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_mqs_schedule_run
    ON public.planner_machine_queue_state(schedule_run_id);

CREATE INDEX IF NOT EXISTS idx_planner_psos_ps_id
    ON public.planner_process_sheet_operation_state(planner_ps_id);

CREATE INDEX IF NOT EXISTS idx_planner_pss_execution
    ON public.planner_process_sheet_state(execution_status);

