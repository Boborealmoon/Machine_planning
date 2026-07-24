-- Exclusive part-number tags for factory floor plan machines.
CREATE TABLE IF NOT EXISTS public.planner_machine_part_tag (
    tag_id       BIGSERIAL    PRIMARY KEY,
    machine_id   BIGINT       NOT NULL
        REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
    part_no      TEXT         NOT NULL CHECK (LENGTH(BTRIM(part_no)) > 0),
    tag_label    TEXT         NOT NULL DEFAULT '',
    notes        TEXT         NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (machine_id, part_no)
);

CREATE INDEX IF NOT EXISTS idx_planner_machine_part_tag_machine
    ON public.planner_machine_part_tag (machine_id);

INSERT INTO public.planner_machines (machine_no, machine_category, shift_profile, active)
VALUES ('CNC 41', 'MPP', 'STANDARD', TRUE)
ON CONFLICT (machine_no) DO NOTHING;
