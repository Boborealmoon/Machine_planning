-- Month-end freeze of process sheets that were labelled NEW when the month closed.
-- The app also creates these tables on startup; this file is the same definition.

CREATE TABLE IF NOT EXISTS public.planner_otd_new_part_month (
    year              INT         NOT NULL,
    month             INT         NOT NULL,
    new_part_count    INT         NOT NULL,
    delivered_count   INT         NOT NULL,
    snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (year, month)
);

CREATE TABLE IF NOT EXISTS public.planner_otd_new_part_snapshot (
    year               INT         NOT NULL,
    month              INT         NOT NULL,
    process_sheet_no   TEXT        NOT NULL,
    pp_type            TEXT        NOT NULL DEFAULT '',
    sales_order_no     TEXT        NOT NULL DEFAULT '',
    inventory_code     TEXT        NOT NULL DEFAULT '',
    description        TEXT        NOT NULL DEFAULT '',
    customer_name      TEXT        NOT NULL DEFAULT '',
    sales_person_name  TEXT        NOT NULL DEFAULT '',
    delivery_date      DATE,
    po_due_date        DATE,
    status             TEXT        NOT NULL DEFAULT '',
    snapshotted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (year, month, process_sheet_no)
);
