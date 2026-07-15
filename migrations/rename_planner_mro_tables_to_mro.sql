-- Rename MRO planner tables from planner_mro_* to mro_* (Supabase / public schema).
-- Safe to re-run: only renames when the old name exists and the new name does not.

DO $$
BEGIN
    IF to_regclass('public.planner_mro_certifying_staff') IS NOT NULL
       AND to_regclass('public.mro_certifying_staff') IS NULL THEN
        ALTER TABLE public.planner_mro_certifying_staff
            RENAME TO mro_certifying_staff;
    END IF;

    IF to_regclass('public.planner_mro_arc_serial_seq') IS NOT NULL
       AND to_regclass('public.mro_arc_serial_seq') IS NULL THEN
        ALTER TABLE public.planner_mro_arc_serial_seq
            RENAME TO mro_arc_serial_seq;
    END IF;

    IF to_regclass('public.planner_mro_arc_history') IS NOT NULL
       AND to_regclass('public.mro_arc_history') IS NULL THEN
        ALTER TABLE public.planner_mro_arc_history
            RENAME TO mro_arc_history;
    END IF;
END $$;
