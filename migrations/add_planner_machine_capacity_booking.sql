-- Monthly capacity bookings: reserve hours on a machine for a part number.
CREATE TABLE IF NOT EXISTS public.planner_machine_capacity_booking (
    booking_id      BIGSERIAL    PRIMARY KEY,
    machine_id      BIGINT       NOT NULL
        REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    planning_year   INTEGER      NOT NULL CHECK (planning_year BETWEEN 2000 AND 2100),
    planning_month  INTEGER      NOT NULL CHECK (planning_month BETWEEN 1 AND 12),
    part_no         TEXT         NOT NULL CHECK (LENGTH(BTRIM(part_no)) > 0),
    reserved_hours  NUMERIC(10, 2) NOT NULL CHECK (reserved_hours > 0),
    tag_label       TEXT         NOT NULL DEFAULT '',
    notes           TEXT         NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (machine_id, planning_year, planning_month, part_no)
);

CREATE INDEX IF NOT EXISTS idx_planner_machine_capacity_booking_month
    ON public.planner_machine_capacity_booking (planning_year, planning_month);

CREATE INDEX IF NOT EXISTS idx_planner_machine_capacity_booking_machine
    ON public.planner_machine_capacity_booking (machine_id);
