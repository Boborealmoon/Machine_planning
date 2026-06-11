-- Daily output & efficiency shop-floor board (snapshot + live sheet).

ALTER TABLE public.planner_machines
    ADD COLUMN IF NOT EXISTS output_section TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN public.planner_machines.output_section IS
    'Shop output board column: PS_ML | PS_TN | APS_TN (empty = excluded from board)';

-- Seed from OUTPUT & EFFICIENCY WK24 Excel layout (adjust in master data as needed).
UPDATE public.planner_machines SET output_section = 'PS_ML'
WHERE machine_no IN ('CNC 20', 'CNC 25', 'CNC 26', 'CNC 29', 'CNC 38', 'CNC 39', 'CNC 40');

UPDATE public.planner_machines SET output_section = 'PS_TN'
WHERE machine_no IN ('CNC 15', 'CNC 21', 'CNC 24', 'CNC 27', 'CNC 35', 'CNC 36');

UPDATE public.planner_machines SET output_section = 'APS_TN'
WHERE machine_no IN ('CNC 10', 'CNC 22', 'CNC 30', 'CNC 31', 'CNC 32');

CREATE TABLE IF NOT EXISTS public.planner_daily_output_sheet (
    sheet_id         BIGSERIAL    PRIMARY KEY,
    work_date        DATE         NOT NULL UNIQUE,
    shift_start      TIME         NOT NULL DEFAULT '08:30',
    shift_end        TIME         NOT NULL DEFAULT '20:00',
    plan_locked_at   TIMESTAMPTZ,
    status           TEXT         NOT NULL DEFAULT 'OPEN',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.planner_daily_output_machine (
    sheet_machine_id BIGSERIAL    PRIMARY KEY,
    sheet_id         BIGINT       NOT NULL REFERENCES public.planner_daily_output_sheet(sheet_id) ON DELETE CASCADE,
    machine_id       BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    section_code     TEXT         NOT NULL,
    sort_order       INTEGER      NOT NULL DEFAULT 0,
    mc_am            TEXT         NOT NULL DEFAULT '',
    mc_ot            TEXT         NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (sheet_id, machine_id)
);

CREATE TABLE IF NOT EXISTS public.planner_daily_output_line (
    line_id          BIGSERIAL    PRIMARY KEY,
    sheet_id         BIGINT       NOT NULL REFERENCES public.planner_daily_output_sheet(sheet_id) ON DELETE CASCADE,
    machine_id       BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    slot_index       INTEGER      NOT NULL CHECK (slot_index >= 0 AND slot_index < 6),
    block_id         BIGINT       REFERENCES public.planner_run_block(block_id) ON DELETE SET NULL,
    ps_id            TEXT         NOT NULL DEFAULT '',
    op_no            TEXT         NOT NULL DEFAULT '',
    cycle_time       NUMERIC,
    target_qty       NUMERIC,
    out_qty          NUMERIC,
    fpce             TEXT         NOT NULL DEFAULT '',
    in_pro           TEXT         NOT NULL DEFAULT '',
    qua_his          TEXT         NOT NULL DEFAULT '',
    rejects          NUMERIC,
    source           TEXT         NOT NULL DEFAULT 'SCHEDULE',
    manual_touched   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (sheet_id, machine_id, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_planner_daily_output_line_sheet_machine
    ON public.planner_daily_output_line (sheet_id, machine_id, slot_index);

CREATE TABLE IF NOT EXISTS public.planner_daily_output_snapshot (
    snapshot_id      BIGSERIAL    PRIMARY KEY,
    sheet_id         BIGINT       NOT NULL REFERENCES public.planner_daily_output_sheet(sheet_id) ON DELETE CASCADE,
    snapshot_type    TEXT         NOT NULL DEFAULT 'AUTO_11AM',
    snapshot_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    label            TEXT         NOT NULL DEFAULT '',
    created_by       TEXT         NOT NULL DEFAULT '',
    notes            TEXT         NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_planner_daily_output_snapshot_sheet
    ON public.planner_daily_output_snapshot (sheet_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS public.planner_daily_output_snapshot_line (
    snapshot_line_id BIGSERIAL    PRIMARY KEY,
    snapshot_id      BIGINT       NOT NULL REFERENCES public.planner_daily_output_snapshot(snapshot_id) ON DELETE CASCADE,
    machine_id       BIGINT       NOT NULL REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    slot_index       INTEGER      NOT NULL,
    block_id         BIGINT,
    ps_id            TEXT         NOT NULL DEFAULT '',
    op_no            TEXT         NOT NULL DEFAULT '',
    cycle_time       NUMERIC,
    target_qty       NUMERIC,
    out_qty          NUMERIC,
    fpce             TEXT         NOT NULL DEFAULT '',
    in_pro           TEXT         NOT NULL DEFAULT '',
    qua_his          TEXT         NOT NULL DEFAULT '',
    rejects          NUMERIC,
    mc_am            TEXT         NOT NULL DEFAULT '',
    mc_ot            TEXT         NOT NULL DEFAULT '',
    UNIQUE (snapshot_id, machine_id, slot_index)
);
