-- One-time seed: planner_cycle_time_master ← planner_program_tools
-- Enriches bom_code / stage_no / stage_name / op_no / op_type from bom_op_stage when a row matches
-- (same op_no / stage_no rules as stg_cycle_time_comparison). part_description from part_desc.
-- stage_no = ERP BOM sequence only (0 when no match). program_no / operation_type from sheet columns.
--
-- Prerequisites:
--   • planner_cycle_time_master exists (create_planner_cycle_time_master.sql)
--   • planner_program_tools populated (Program / Tool List sync)
--   • migrations/add_planner_program_tools_operation_type_program_no.sql applied
--
-- Safe default: only runs when the master table is empty. To reload, uncomment TRUNCATE below.

-- TRUNCATE public.planner_cycle_time_master RESTART IDENTITY;

INSERT INTO public.planner_cycle_time_master (
    bom_code,
    part_no,
    part_description,
    stage_no,
    stage_name,
    op_no,
    op_type,
    program_no,
    program_file,
    tool_list_file,
    cycle_time,
    set_up_time
)
WITH gs_normalized AS (
    SELECT
        p.id,
        NULLIF(trim(p.part_no_erp), '') AS part_no_erp,
        NULLIF(trim(p.operation_no), '') AS operation_no_raw,
        NULLIF(trim(p.operation_type), '') AS operation_type,
        NULLIF(trim(p.program_no), '') AS program_no,
        NULLIF(
            substring(trim(COALESCE(p.operation_no, '')) FROM '^[^0-9]*([0-9]+)'),
            ''
        )::integer AS op_extracted_int,
        NULLIF(trim(p.program_file), '') AS program_file,
        NULLIF(trim(p.tool_list_files), '') AS tool_list_files,
        COALESCE(p.set_up_time, 180) AS set_up_time,
        COALESCE(p.cycle_time, 0) AS cycle_time
    FROM public.planner_program_tools p
    WHERE NULLIF(trim(p.part_no_erp), '') IS NOT NULL
),
with_bom AS (
    SELECT
        g.*,
        b.bom_code,
        b.stage_no AS bom_stage_no,
        b.stage_desc AS bom_stage_desc,
        b.op_no AS bom_op_no
    FROM gs_normalized g
    LEFT JOIN LATERAL (
        SELECT b.*
        FROM public.bom_op_stage b
        WHERE b.inventory_code = g.part_no_erp
          AND (
                (b.op_no IS NOT NULL AND g.op_extracted_int IS NOT DISTINCT FROM b.op_no)
             OR (
                    (
                        b.op_no IS NULL
                        OR NOT EXISTS (
                            SELECT 1
                            FROM public.bom_op_stage bx
                            WHERE bx.inventory_code = g.part_no_erp
                              AND bx.op_no IS NOT DISTINCT FROM g.op_extracted_int
                        )
                    )
                    AND g.op_extracted_int IS NOT DISTINCT FROM b.stage_no
                )
          )
        ORDER BY
            CASE
                WHEN b.op_no IS NOT NULL AND g.op_extracted_int IS NOT DISTINCT FROM b.op_no THEN 0
                WHEN g.op_extracted_int IS NOT DISTINCT FROM b.stage_no THEN 1
                ELSE 2
            END,
            b.bom_code,
            b.stage_no
        LIMIT 1
    ) b ON TRUE
)
SELECT
    COALESCE(w.bom_code, '') AS bom_code,
    w.part_no_erp AS part_no,
    COALESCE(NULLIF(trim(pd.main_desc), ''), '') AS part_description,
    COALESCE(w.bom_stage_no, 0) AS stage_no,
    COALESCE(
        w.bom_stage_desc,
        NULLIF(
            trim(COALESCE(w.operation_type, ''))
            || CASE
                WHEN NULLIF(trim(COALESCE(w.operation_no_raw, '')), '') IS NOT NULL
                THEN ' ' || trim(w.operation_no_raw)
                ELSE ''
               END,
            ''
        )
    ) AS stage_name,
    COALESCE(w.bom_op_no, w.op_extracted_int) AS op_no,
    CASE
        WHEN w.bom_stage_desc LIKE 'Turning%'  THEN 'Turning'
        WHEN w.bom_stage_desc LIKE 'Milling%'  THEN 'Milling'
        WHEN w.bom_stage_desc LIKE 'Turnmill%' THEN 'Turnmill'
        WHEN NULLIF(trim(COALESCE(w.operation_type, '')), '') IS NOT NULL
        THEN trim(w.operation_type)
        ELSE ''
    END AS op_type,
    COALESCE(NULLIF(trim(w.program_no), ''), '') AS program_no,
    COALESCE(w.program_file, '') AS program_file,
    COALESCE(w.tool_list_files, '') AS tool_list_file,
    w.cycle_time,
    w.set_up_time
FROM with_bom w
LEFT JOIN public.part_desc pd ON pd.inventory_code = w.part_no_erp
WHERE NOT EXISTS (SELECT 1 FROM public.planner_cycle_time_master LIMIT 1);
