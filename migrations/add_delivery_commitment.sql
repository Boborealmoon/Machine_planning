-- Planner-assigned delivery months for open outstanding lines.
-- A line can be split across months. Saving a month does not change Coway EDD.

CREATE TABLE IF NOT EXISTS public.planner_delivery_commitment (
    commitment_id       BIGSERIAL    PRIMARY KEY,
    row_id              TEXT         NOT NULL,
    sales_order_no      TEXT         NOT NULL DEFAULT '',
    source_line_item_no TEXT         NOT NULL DEFAULT '',
    pp_voucher_no       TEXT         NOT NULL DEFAULT '',
    process_sheet_no    TEXT         NOT NULL DEFAULT '',
    pp_partial_no       INTEGER      NOT NULL DEFAULT 0,
    ps_type             TEXT         NOT NULL DEFAULT '',
    part_no             TEXT         NOT NULL DEFAULT '',
    part_desc           TEXT         NOT NULL DEFAULT '',
    unit_cost           NUMERIC,
    exch_rate           NUMERIC,
    status              TEXT         NOT NULL DEFAULT '',
    due_date            DATE,
    coway_edd           DATE,
    week_label          TEXT         NOT NULL DEFAULT '',
    plan_month          DATE         NOT NULL,
    qty                 NUMERIC      NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_delivery_commitment_qty_pos CHECK (qty > 0),
    CONSTRAINT planner_delivery_commitment_row_month UNIQUE (row_id, plan_month)
);

CREATE INDEX IF NOT EXISTS idx_planner_delivery_commitment_row
    ON public.planner_delivery_commitment (row_id);

CREATE INDEX IF NOT EXISTS idx_planner_delivery_commitment_month
    ON public.planner_delivery_commitment (plan_month);
