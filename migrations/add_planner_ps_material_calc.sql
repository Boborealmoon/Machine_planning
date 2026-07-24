-- Bar-stock material calculator: per-PS tracking tags + jaw/stock presets.

CREATE TABLE IF NOT EXISTS public.planner_material_bar_preset (
    preset_id              BIGSERIAL    PRIMARY KEY,
    name                   TEXT         NOT NULL,
    material_type_grade    TEXT         NOT NULL DEFAULT '',
    stock_od_mm            NUMERIC      NOT NULL DEFAULT 0,
    standard_bar_length_mm NUMERIC      NOT NULL DEFAULT 0,
    density_g_cm3          NUMERIC      NOT NULL DEFAULT 7.85,
    jaw_length_mm          NUMERIC      NOT NULL DEFAULT 0,
    facing_allowance_mm    NUMERIC      NOT NULL DEFAULT 0,
    cutoff_kerf_mm         NUMERIC      NOT NULL DEFAULT 0,
    chamfer_allowance_mm   NUMERIC      NOT NULL DEFAULT 0,
    clamp_length_op1_mm    NUMERIC      NOT NULL DEFAULT 0,
    remarks                TEXT         NOT NULL DEFAULT '',
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.planner_ps_material_calc (
    calc_id                BIGSERIAL    PRIMARY KEY,
    planner_ps_id          TEXT         NOT NULL,
    part_no                TEXT         NOT NULL DEFAULT '',
    revision               TEXT         NOT NULL DEFAULT '',
    material_type_grade    TEXT         NOT NULL DEFAULT '',
    stock_od_mm            NUMERIC      NOT NULL DEFAULT 0,
    standard_bar_length_mm NUMERIC      NOT NULL DEFAULT 0,
    density_g_cm3          NUMERIC      NOT NULL DEFAULT 7.85,
    -- Length inputs (mm)
    finished_part_length_mm NUMERIC     NOT NULL DEFAULT 0,
    clamp_length_op1_mm    NUMERIC      NOT NULL DEFAULT 0,
    clamp_length_op2_mm    NUMERIC      NOT NULL DEFAULT 0,  -- reserved for multi-op
    jaw_length_op1_mm      NUMERIC      NOT NULL DEFAULT 0,
    jaw_length_op2_mm      NUMERIC      NOT NULL DEFAULT 0,  -- reserved for multi-op
    facing_allowance_mm    NUMERIC      NOT NULL DEFAULT 0,
    cutoff_kerf_mm         NUMERIC      NOT NULL DEFAULT 0,
    chamfer_allowance_mm   NUMERIC      NOT NULL DEFAULT 0,
    -- Qty inputs
    order_qty              NUMERIC      NOT NULL DEFAULT 0,
    setup_pieces           NUMERIC      NOT NULL DEFAULT 0,
    scrap_allowance_pct    NUMERIC      NOT NULL DEFAULT 0,
    -- Issued stock (for returnable estimate)
    issued_length_mm       NUMERIC      NOT NULL DEFAULT 0,
    issued_bars            NUMERIC      NOT NULL DEFAULT 0,
    -- Stored outputs (snapshot at save)
    length_per_piece_mm    NUMERIC      NOT NULL DEFAULT 0,
    parts_per_bar          INTEGER      NOT NULL DEFAULT 0,
    remnant_length_mm      NUMERIC      NOT NULL DEFAULT 0,
    pieces_needed          NUMERIC      NOT NULL DEFAULT 0,
    bars_needed            NUMERIC      NOT NULL DEFAULT 0,
    target_total_mm        NUMERIC      NOT NULL DEFAULT 0,
    target_total_kg        NUMERIC      NOT NULL DEFAULT 0,
    returnable_mm          NUMERIC      NOT NULL DEFAULT 0,
    -- Post-production actuals
    actual_total_mm        NUMERIC,
    actual_total_kg        NUMERIC,
    remarks                TEXT         NOT NULL DEFAULT '',
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_ps_material_calc_ps_material
    ON public.planner_ps_material_calc (
        planner_ps_id,
        lower(btrim(material_type_grade))
    );

CREATE INDEX IF NOT EXISTS idx_planner_ps_material_calc_part
    ON public.planner_ps_material_calc (part_no);

CREATE INDEX IF NOT EXISTS idx_planner_ps_material_calc_updated
    ON public.planner_ps_material_calc (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_planner_material_bar_preset_name
    ON public.planner_material_bar_preset (name);
