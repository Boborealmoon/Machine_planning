-- PPS site-only Wire cut lane.
-- Visible on the PPS Planner tab together with CNC 20; hidden on the main planner board.
INSERT INTO public.planner_machines (machine_no, machine_category, shift_profile, active)
VALUES ('Wire cut', 'WIRECUT', 'STANDARD', TRUE)
ON CONFLICT (machine_no) DO UPDATE
SET machine_category = EXCLUDED.machine_category,
    shift_profile = EXCLUDED.shift_profile,
    active = TRUE;
