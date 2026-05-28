-- Upsert key for planner_program_tools (Program / Tool List → Supabase sync).
-- Run in Supabase SQL editor, then reload API schema (Settings → API).
--
-- Sync uses POST …?on_conflict=part_no_erp,cnc_machine_no,operation_no,program_file,tool_list_files
-- with Prefer: resolution=merge-duplicates (no full-table DELETE on each run).

-- Remove duplicate natural keys (keep highest id).
DELETE FROM public.planner_program_tools a
USING public.planner_program_tools b
WHERE a.id < b.id
  AND trim(coalesce(a.part_no_erp, '')) = trim(coalesce(b.part_no_erp, ''))
  AND trim(coalesce(a.cnc_machine_no, '')) = trim(coalesce(b.cnc_machine_no, ''))
  AND trim(coalesce(a.operation_no, '')) = trim(coalesce(b.operation_no, ''))
  AND trim(coalesce(a.program_file, '')) = trim(coalesce(b.program_file, ''))
  AND trim(coalesce(a.tool_list_files, '')) = trim(coalesce(b.tool_list_files, ''));

CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_program_tools_natural_key
    ON public.planner_program_tools (
        part_no_erp,
        cnc_machine_no,
        operation_no,
        program_file,
        tool_list_files
    );
