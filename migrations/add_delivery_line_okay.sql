-- Planner mark that an outstanding line is okay.
-- Independent of the delivered flag and of the assigned month.

CREATE TABLE IF NOT EXISTS public.planner_delivery_line_okay (
    row_id      TEXT         PRIMARY KEY,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
