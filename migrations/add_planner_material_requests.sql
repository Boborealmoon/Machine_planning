-- Standalone Material Tracking requests (part / inventory, no process sheet).
CREATE TABLE IF NOT EXISTS public.planner_material_requests (
    request_id       BIGSERIAL    PRIMARY KEY,
    part_no          TEXT         NOT NULL DEFAULT '',
    inventory_code   TEXT         NOT NULL DEFAULT '',
    description      TEXT         NOT NULL DEFAULT '',
    qty              NUMERIC,
    material_subcon  TEXT         NOT NULL DEFAULT '',
    remarks          TEXT         NOT NULL DEFAULT '',
    material_delay   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_material_requests_code_chk
        CHECK (BTRIM(part_no) <> '' OR BTRIM(inventory_code) <> '')
);

CREATE INDEX IF NOT EXISTS idx_planner_material_requests_updated_at
    ON public.planner_material_requests (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_planner_material_requests_part_no
    ON public.planner_material_requests (part_no);

CREATE INDEX IF NOT EXISTS idx_planner_material_requests_inventory_code
    ON public.planner_material_requests (inventory_code);
