-- Optional: allow API reads with anon/publishable key (Flask already uses service role).
-- Run if you need Table Editor / direct REST access with the anon key.

ALTER TABLE public.planner_cycle_time_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planner_cycle_time_master_select ON public.planner_cycle_time_master;
DROP POLICY IF EXISTS planner_cycle_time_master_insert ON public.planner_cycle_time_master;
DROP POLICY IF EXISTS planner_cycle_time_master_update ON public.planner_cycle_time_master;
DROP POLICY IF EXISTS planner_cycle_time_master_delete ON public.planner_cycle_time_master;

CREATE POLICY planner_cycle_time_master_select
    ON public.planner_cycle_time_master
    FOR SELECT
    TO anon, authenticated, service_role
    USING (true);

CREATE POLICY planner_cycle_time_master_insert
    ON public.planner_cycle_time_master
    FOR INSERT
    TO anon, authenticated, service_role
    WITH CHECK (true);

CREATE POLICY planner_cycle_time_master_update
    ON public.planner_cycle_time_master
    FOR UPDATE
    TO anon, authenticated, service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY planner_cycle_time_master_delete
    ON public.planner_cycle_time_master
    FOR DELETE
    TO anon, authenticated, service_role
    USING (true);
