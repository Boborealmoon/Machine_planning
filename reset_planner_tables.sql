-- =============================================================================
-- reset_planner_tables.sql
-- Full wipe of all tables defined in schema_planner.sql (planning layer only).
--
-- DOES NOT touch ERP sync tables:
--   pp_vouchers_cache, pp_voucher, bom_op_stage, material_per_bom, part_desc, etc.
--
-- Run in Supabase SQL editor (or psql) as a role with TRUNCATE rights.
-- Review counts below, then uncomment COMMIT (or run COMMIT manually).
-- =============================================================================

BEGIN;

-- ── Optional: row counts before reset ─────────────────────────────────────────
SELECT 'planner_operation' AS tbl, COUNT(*) FROM public.planner_operation
UNION ALL SELECT 'planner_run_block', COUNT(*) FROM public.planner_run_block
UNION ALL SELECT 'planner_process_sheet', COUNT(*) FROM public.planner_process_sheet
UNION ALL SELECT 'planner_planning_card', COUNT(*) FROM public.planner_planning_card
UNION ALL SELECT 'planner_machines', COUNT(*) FROM public.planner_machines
ORDER BY tbl;

-- ── Truncate all planner_* tables (schema_planner.sql) ───────────────────────
-- RESTART IDENTITY: reset BIGSERIAL sequences to 1
-- CASCADE: include dependent rows / self-FKs (run_block, production_actual, etc.)

TRUNCATE TABLE
    -- Group H: scheduler state cache
    public.planner_machine_queue_state,
    public.planner_process_sheet_operation_state,
    public.planner_process_sheet_state,
    -- Group G: scheduler logging
    public.planner_schedule_alert,
    public.planner_rework_link,
    public.planner_data_import_log,
    public.planner_schedule_run,
    -- Group F: planning cards
    public.planner_planning_card_operation,
    public.planner_planning_card,
    -- Group E: materials
    public.planner_material_requirement,
    -- Group D: scheduling core
    public.planner_operation_sequence,
    public.planner_production_actual,
    public.planner_run_block_segment,
    public.planner_run_block,
    public.planner_run_block_group,
    public.planner_operation,
    -- Group C: process sheets
    public.planner_process_sheet,
    -- Group B: BOM / flows
    public.planner_operation_seq,
    public.planner_bom_variation,
    -- Group A: reference / static
    public.planner_machine_capacity_day,
    public.planner_machine_calendar_window,
    public.planner_public_holiday

RESTART IDENTITY CASCADE;

-- ── Re-seed reference data (from schema_planner.sql SEED DATA section) ───────

-- INSERT INTO public.planner_capacity_profile (profile_name, capacity_minutes, start_minute, note)
-- VALUES
--     ('NORMAL_DAY_NIGHT', 630,  510, 'Weekday shift 08:30–20:00'),
--     ('SATURDAY',         420,  510, 'Saturday shift 08:30–16:15'),
--     ('FULL_24H',        1440,    0, '24-hour coverage'),
--     ('OFF',                0,    0, 'Off')
-- ON CONFLICT (profile_name) DO NOTHING;

-- INSERT INTO public.planner_machines (machine_no, machine_category, shift_profile, active)
-- VALUES
--     ('CNC 10', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 15', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 20', 'MILLING',  'STANDARD', TRUE),
--     ('CNC 21', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 22', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 24', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 25', 'MILLING',  'STANDARD', TRUE),
--     ('CNC 26', 'MILLING',  'STANDARD', TRUE),
--     ('CNC 27', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 29', 'MILLING',  'STANDARD', TRUE),
--     ('CNC 30', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 31', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 32', 'TURNING',  'STANDARD', TRUE),
--     ('CNC 35', 'MPP',      '24HR',     TRUE),
--     ('CNC 36', 'MPP',      '24HR',     TRUE),
--     ('CNC 38', 'TURNMILL', 'STANDARD', TRUE),
--     ('CNC 39', 'TURNMILL', 'STANDARD', TRUE),
--     ('CNC 40', 'TURNMILL', 'STANDARD', TRUE)
-- ON CONFLICT (machine_no) DO NOTHING;

-- ── Verify empty transactional tables, seeds present ────────────────────────
-- SELECT 'planner_operation' AS tbl, COUNT(*) AS n FROM public.planner_operation
-- UNION ALL SELECT 'planner_run_block', COUNT(*) FROM public.planner_run_block
-- UNION ALL SELECT 'planner_process_sheet', COUNT(*) FROM public.planner_process_sheet
-- UNION ALL SELECT 'planner_planning_card', COUNT(*) FROM public.planner_planning_card
-- UNION ALL SELECT 'planner_machines', COUNT(*) FROM public.planner_machines
-- UNION ALL SELECT 'planner_capacity_profile', COUNT(*) FROM public.planner_capacity_profile
-- ORDER BY tbl;

-- Uncomment when satisfied:
COMMIT;

-- Or roll back to dry-run only (truncate + seeds run but are undone):
-- ROLLBACK;
