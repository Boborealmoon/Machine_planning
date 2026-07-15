"""Import planner_cycle_time_master rows from planner_program_tools (insert-only)."""

from __future__ import annotations



import os

import re

from typing import Any



# Shared candidate rows from program tools + bom_op_stage enrichment (see seed migration).

# Domain: stage_no = ERP BOM sequence only; operation_no/op_type from sheet; program_no from sheet.

CANDIDATES_CTE = """

candidates AS (

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

            WHEN w.bom_stage_desc LIKE 'Turning%%'  THEN 'Turning'

            WHEN w.bom_stage_desc LIKE 'Milling%%'  THEN 'Milling'

            WHEN w.bom_stage_desc LIKE 'Turnmill%%' THEN 'Turnmill'

            WHEN NULLIF(trim(COALESCE(w.operation_type, '')), '') IS NOT NULL

            THEN trim(w.operation_type)

            ELSE ''

        END AS op_type,

        COALESCE(NULLIF(trim(w.program_no), ''), '') AS program_no,

        COALESCE(w.program_file, '') AS program_file,

        COALESCE(w.tool_list_files, '') AS tool_list_file,

        w.cycle_time,

        w.set_up_time

    FROM (

        SELECT

            g.*,

            COALESCE(NULLIF(trim(g.erp_bom_code), ''), b.bom_code) AS bom_code,

            b.stage_no AS bom_stage_no,

            b.stage_desc AS bom_stage_desc,

            b.op_no AS bom_op_no

        FROM (

            SELECT

                NULLIF(trim(p.part_no_erp), '') AS part_no_erp,

                NULLIF(trim(p.bom_code), '') AS erp_bom_code,

                NULLIF(trim(p.operation_no), '') AS operation_no_raw,

                NULLIF(trim(p.operation_type), '') AS operation_type,

                NULLIF(trim(p.program_no), '') AS program_no,

                NULLIF(

                    substring(trim(COALESCE(p.operation_no, '')) FROM '^[^0-9]*([0-9]+)'),

                    ''

                )::integer AS op_extracted_int,

                COALESCE(NULLIF(trim(p.program_file), ''), '') AS program_file,

                COALESCE(NULLIF(trim(p.tool_list_files), ''), '') AS tool_list_files,

                COALESCE(p.set_up_time, 180) AS set_up_time,

                COALESCE(p.cycle_time, 0) AS cycle_time

            FROM public.planner_program_tools p

            WHERE NULLIF(trim(p.part_no_erp), '') IS NOT NULL
              AND NULLIF(trim(p.program_file), '') IS NOT NULL
              AND NULLIF(trim(p.tool_list_files), '') IS NOT NULL

        ) g

        LEFT JOIN LATERAL (

            SELECT b.*

            FROM public.bom_op_stage b

            WHERE b.inventory_code = g.part_no_erp

              AND (

                    NULLIF(trim(g.erp_bom_code), '') IS NULL

                    OR trim(b.bom_code) = trim(g.erp_bom_code)

              )

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

    ) w

    LEFT JOIN public.part_desc pd ON pd.inventory_code = w.part_no_erp

)

"""



# Natural key: same part + BOM stage + program identity => already in master (do not insert again).

MASTER_MATCH_SQL = """

    trim(m.part_no) = trim(c.part_no)

    AND trim(m.bom_code) = trim(c.bom_code)

    AND m.stage_no = c.stage_no

    AND trim(m.program_no) = trim(c.program_no)

    AND trim(m.program_file) = trim(c.program_file)

    AND trim(m.tool_list_file) = trim(c.tool_list_file)

"""


# Drop orphan master rows superseded by a richer row for the same part + op (e.g. stage_no=0 stubs).
PRUNE_STALE_MASTER_ROWS_SQL = """
DELETE FROM public.planner_cycle_time_master m
WHERE EXISTS (
    SELECT 1
    FROM public.planner_cycle_time_master b
    WHERE trim(b.part_no) = trim(m.part_no)
      AND b.op_no IS NOT DISTINCT FROM m.op_no
      AND b.id <> m.id
      AND (
            (m.stage_no = 0 AND b.stage_no > 0)
         OR (
                trim(COALESCE(m.program_file, '')) = ''
            AND trim(COALESCE(m.program_no, '')) = ''
            AND trim(COALESCE(m.tool_list_file, '')) = ''
            AND (
                    trim(COALESCE(b.program_file, '')) <> ''
                 OR trim(COALESCE(b.program_no, '')) <> ''
                 OR b.stage_no > 0
                )
            )
      )
)
"""

# Machining BOM steps from ERP cache + planner BOM routes (process-sheet source of truth).
BOM_STEP_CANDIDATES_CTE = """
bom_step_raw AS (
    SELECT
        b.inventory_code AS part_no,
        b.bom_code,
        COALESCE(NULLIF(trim(pd.main_desc), ''), '') AS part_description,
        COALESCE(b.stage_no, 0) AS stage_no,
        COALESCE(b.stage_desc, '') AS stage_name,
        b.op_no,
        CASE
            WHEN b.stage_desc LIKE 'Turning%%' THEN 'Turning'
            WHEN b.stage_desc LIKE 'Milling%%' THEN 'Milling'
            WHEN b.stage_desc LIKE 'Turnmill%%' THEN 'Turnmill'
            ELSE ''
        END AS op_type,
        COALESCE(b.cycle_time, 0) AS cycle_time,
        COALESCE(b.setup_time, 0) AS set_up_time,
        1 AS source_rank
    FROM public.bom_op_stage b
    LEFT JOIN public.part_desc pd ON pd.inventory_code = b.inventory_code
    WHERE NULLIF(trim(b.inventory_code), '') IS NOT NULL
      AND NULLIF(trim(b.bom_code), '') IS NOT NULL
      AND (
          b.stage_desc LIKE 'Turning%%'
       OR b.stage_desc LIKE 'Milling%%'
       OR b.stage_desc LIKE 'Turnmill%%'
      )

    UNION ALL

    SELECT
        bv.inventory_code AS part_no,
        bv.bom_code,
        COALESCE(NULLIF(trim(pd.main_desc), ''), '') AS part_description,
        COALESCE(os.source_stage_no, 0) AS stage_no,
        trim(
            COALESCE(os.op_type, '')
            || CASE
                WHEN NULLIF(trim(COALESCE(os.op_no, '')), '') IS NOT NULL
                THEN ' ' || trim(os.op_no)
                ELSE ''
               END
        ) AS stage_name,
        NULLIF(
            substring(trim(COALESCE(os.op_no, '')) FROM '^[^0-9]*([0-9]+)'),
            ''
        )::integer AS op_no,
        CASE
            WHEN trim(COALESCE(os.op_type, '')) IN ('Turning', 'Milling', 'Turnmill')
            THEN trim(os.op_type)
            WHEN os.op_type LIKE 'Turning%%' THEN 'Turning'
            WHEN os.op_type LIKE 'Milling%%' THEN 'Milling'
            WHEN os.op_type LIKE 'Turnmill%%' THEN 'Turnmill'
            ELSE ''
        END AS op_type,
        COALESCE(os.cycle_time, 0) AS cycle_time,
        COALESCE(os.setup_time, 0) AS set_up_time,
        2 AS source_rank
    FROM public.planner_operation_seq os
    JOIN public.planner_bom_variation bv ON bv.bom_id = os.bom_id
    LEFT JOIN public.part_desc pd ON pd.inventory_code = bv.inventory_code
    WHERE NULLIF(trim(bv.inventory_code), '') IS NOT NULL
      AND NULLIF(trim(bv.bom_code), '') IS NOT NULL
      AND (
          trim(COALESCE(os.op_type, '')) IN ('Turning', 'Milling', 'Turnmill')
       OR os.op_type LIKE 'Turning%%'
       OR os.op_type LIKE 'Milling%%'
       OR os.op_type LIKE 'Turnmill%%'
       OR trim(COALESCE(os.machine_category, '')) IN ('TURNING', 'MILLING', 'TURNMILL')
      )
),

bom_step_candidates AS (
    SELECT DISTINCT ON (
        trim(part_no),
        trim(bom_code),
        COALESCE(op_no, -1),
        COALESCE(stage_no, 0)
    )
        part_no,
        bom_code,
        part_description,
        stage_no,
        stage_name,
        op_no,
        op_type,
        cycle_time,
        set_up_time
    FROM bom_step_raw
    WHERE op_no IS NOT NULL OR stage_no > 0
    ORDER BY
        trim(part_no),
        trim(bom_code),
        COALESCE(op_no, -1),
        COALESCE(stage_no, 0),
        source_rank
)
"""

BOM_MASTER_EXISTS_SQL = """
    trim(m.part_no) = trim(c.part_no)
    AND (
        (c.op_no IS NOT NULL AND m.op_no IS NOT DISTINCT FROM c.op_no)
        OR (
            c.op_no IS NULL
            AND c.stage_no > 0
            AND m.stage_no = c.stage_no
            AND trim(m.bom_code) = trim(c.bom_code)
        )
    )
"""

PRUNE_DUPLICATE_BOM_MASTER_ROWS_SQL = """
DELETE FROM public.planner_cycle_time_master m
WHERE EXISTS (
    SELECT 1
    FROM public.planner_cycle_time_master b
    WHERE trim(b.part_no) = trim(m.part_no)
      AND b.op_no IS NOT DISTINCT FROM m.op_no
      AND b.id <> m.id
      AND (
            (COALESCE(b.cycle_time, 0) > 0 AND COALESCE(m.cycle_time, 0) = 0)
         OR (
                COALESCE(b.cycle_time, 0) = COALESCE(m.cycle_time, 0)
            AND b.bom_code NOT LIKE '%%TEMP%%'
            AND m.bom_code LIKE '%%TEMP%%'
            )
         OR (
                COALESCE(b.cycle_time, 0) = COALESCE(m.cycle_time, 0)
            AND trim(COALESCE(b.bom_code, '')) = trim(COALESCE(m.bom_code, ''))
            AND b.id < m.id
            )
      )
)
"""

INSERT_NEW_FROM_BOM_STEPS_SQL = f"""
WITH {BOM_STEP_CANDIDATES_CTE},
new_rows AS (
    SELECT c.*
    FROM bom_step_candidates c
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.planner_cycle_time_master m
        WHERE {BOM_MASTER_EXISTS_SQL}
    )
)
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
    ideal_cycle_time,
    cycle_time,
    set_up_time
)
SELECT
    bom_code,
    part_no,
    part_description,
    stage_no,
    stage_name,
    op_no,
    op_type,
    '',
    '',
    '',
    CASE WHEN cycle_time > 1.01 THEN cycle_time ELSE 0 END,
    CASE WHEN cycle_time > 1.01 THEN cycle_time ELSE 0 END,
    CASE WHEN set_up_time > 0 THEN set_up_time ELSE 0 END
FROM new_rows
"""

COUNT_BOM_STEP_IMPORT_STATS_SQL = f"""
WITH {BOM_STEP_CANDIDATES_CTE},
new_rows AS (
    SELECT c.*
    FROM bom_step_candidates c
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.planner_cycle_time_master m
        WHERE {BOM_MASTER_EXISTS_SQL}
    )
)
SELECT
    (SELECT COUNT(*)::int FROM bom_step_candidates) AS source_count,
    (SELECT COUNT(*)::int FROM new_rows) AS insertable_count,
    (SELECT COUNT(*)::int FROM bom_step_candidates)
        - (SELECT COUNT(*)::int FROM new_rows) AS skipped_existing_count
"""


INSERT_NEW_ONLY_SQL = f"""

WITH {CANDIDATES_CTE},

new_rows AS (

    SELECT c.*

    FROM candidates c

    WHERE NOT EXISTS (

        SELECT 1

        FROM public.planner_cycle_time_master m

        WHERE {MASTER_MATCH_SQL}

    )

)

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

    ideal_cycle_time,

    cycle_time,

    set_up_time

)

SELECT

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

    cycle_time,

    set_up_time

FROM new_rows

"""



COUNT_IMPORT_STATS_SQL = f"""

WITH {CANDIDATES_CTE},

new_rows AS (

    SELECT c.*

    FROM candidates c

    WHERE NOT EXISTS (

        SELECT 1

        FROM public.planner_cycle_time_master m

        WHERE {MASTER_MATCH_SQL}

    )

)

SELECT

    (SELECT COUNT(*)::int FROM candidates) AS source_count,

    (SELECT COUNT(*)::int FROM new_rows) AS insertable_count,

    (SELECT COUNT(*)::int FROM candidates)

        - (SELECT COUNT(*)::int FROM new_rows) AS skipped_existing_count

"""



_OP_INT_RE = re.compile(r"^[^0-9]*([0-9]+)")





def sheet_candidate_fields(

    row: dict[str, Any],

    *,

    bom_stage_no: int | None = None,

    bom_stage_desc: str | None = None,

    bom_op_no: int | None = None,

    bom_code: str = "",

) -> dict[str, Any]:

    """Map a tool-list / planner_program_tools row to master candidate columns (no DB)."""

    operation_no_raw = str(row.get("operation_no") or row.get("operation_no_2") or "").strip()

    operation_type = str(row.get("operation_type") or "").strip()

    program_no = str(row.get("program_no") or "").strip()

    op_extracted: int | None = None

    m = _OP_INT_RE.search(operation_no_raw)

    if m:

        try:

            op_extracted = int(m.group(1))

        except ValueError:

            op_extracted = None



    sheet_stage_name = f"{operation_type} {operation_no_raw}".strip() if operation_no_raw or operation_type else ""



    if bom_stage_desc:

        op_type = ""

        for prefix in ("Turning", "Milling", "Turnmill"):

            if bom_stage_desc.startswith(prefix):

                op_type = prefix

                break

    else:

        op_type = operation_type



    return {

        "bom_code": bom_code,

        "stage_no": bom_stage_no if bom_stage_no is not None else 0,

        "stage_name": (bom_stage_desc or "").strip() or sheet_stage_name,

        "op_no": bom_op_no if bom_op_no is not None else op_extracted,

        "op_type": op_type,

        "program_no": program_no,

        "operation_no_raw": operation_no_raw,

        "operation_type": operation_type,

    }





def _planner_db_available() -> bool:

    return bool(os.getenv("SUPA_DB_URL", "").strip())


def prune_stale_master_rows() -> dict:
    """Remove generic / stage_no=0 master rows when a richer row exists for the same part + op."""
    if not _planner_db_available():
        return {"error": "SUPA_DB_URL is not set.", "deleted": 0}

    from sync import PLANNER_STATEMENT_TIMEOUT_MS
    from planning.helpers import planner_db

    with planner_db() as con:
        con.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")
        cur = con.execute(PRUNE_STALE_MASTER_ROWS_SQL)
        deleted = int(cur.rowcount or 0)

    return {
        "deleted": deleted,
        "message": f"Pruned {deleted} stale master row(s) superseded by richer part+op rows.",
    }


def import_new_from_program_tools() -> dict:

    """

    Insert rows from planner_program_tools that are not already in the master table.

    Never UPDATE existing master rows.

    """

    if not _planner_db_available():

        return {

            "error": "SUPA_DB_URL is not set. Direct Postgres is required for import.",

            "inserted": 0,

            "skipped_existing": 0,

            "source_count": 0,

        }



    from sync import PLANNER_STATEMENT_TIMEOUT_MS

    from planning.helpers import planner_db, rows



    with planner_db() as con:

        con.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")

        stats = rows(con.execute(COUNT_IMPORT_STATS_SQL))[0]

        cur = con.execute(INSERT_NEW_ONLY_SQL)

        inserted = int(cur.rowcount or 0)

        prune_cur = con.execute(PRUNE_STALE_MASTER_ROWS_SQL)

        pruned = int(prune_cur.rowcount or 0)

    source = int(stats.get("source_count") or 0)

    skipped = int(stats.get("skipped_existing_count") or 0)

    return {

        "inserted": inserted,

        "skipped_existing": skipped,

        "source_count": source,

        "pruned_stale": pruned,

        "message": (

            f"Inserted {inserted} new row(s); "

            f"skipped {skipped} already in master (not overwritten); "

            f"pruned {pruned} stale row(s)."

        ),

    }


def import_new_from_bom_steps() -> dict:
    """
    Insert machining BOM steps (bom_op_stage + planner_operation_seq) missing from master.

    Never UPDATE existing master rows. Fills gaps when ERP/process-sheet routes have more
    machining ops than program-tool sheet rows.
    """
    if not _planner_db_available():
        return {
            "error": "SUPA_DB_URL is not set. Direct Postgres is required for import.",
            "inserted": 0,
            "skipped_existing": 0,
            "source_count": 0,
        }

    from sync import PLANNER_STATEMENT_TIMEOUT_MS
    from planning.helpers import planner_db, rows

    with planner_db() as con:
        con.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")
        stats = rows(con.execute(COUNT_BOM_STEP_IMPORT_STATS_SQL))[0]
        cur = con.execute(INSERT_NEW_FROM_BOM_STEPS_SQL)
        inserted = int(cur.rowcount or 0)
        prune_cur = con.execute(PRUNE_DUPLICATE_BOM_MASTER_ROWS_SQL)
        pruned = int(prune_cur.rowcount or 0)

    source = int(stats.get("source_count") or 0)
    skipped = int(stats.get("skipped_existing_count") or 0)
    return {
        "inserted": inserted,
        "skipped_existing": skipped,
        "source_count": source,
        "pruned_duplicates": pruned,
        "message": (
            f"Inserted {inserted} BOM step row(s); "
            f"skipped {skipped} already in master (not overwritten); "
            f"pruned {pruned} duplicate row(s)."
        ),
    }


def sync_ideal_cycle_times_from_program_tools() -> dict:

    """Update ideal_cycle_time on existing master rows from program tools (never touches production cycle_time)."""

    if not _planner_db_available():

        return {"error": "SUPA_DB_URL is not set.", "updated": 0}



    from sync import PLANNER_STATEMENT_TIMEOUT_MS

    from planning.helpers import planner_db



    with planner_db() as con:

        con.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")

        cur = con.execute(UPDATE_IDEAL_FROM_PROGRAM_TOOLS_SQL)

        updated = int(cur.rowcount or 0)



    return {"updated": updated, "message": f"Updated ideal cycle time on {updated} existing row(s)."}


RELOAD_MASTER_SQL = f"""

WITH {CANDIDATES_CTE}

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

    ideal_cycle_time,

    cycle_time,

    set_up_time

)

SELECT

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

    cycle_time,

    set_up_time

FROM candidates

"""



UPDATE_IDEAL_FROM_PROGRAM_TOOLS_SQL = f"""

WITH {CANDIDATES_CTE}

UPDATE public.planner_cycle_time_master m

SET ideal_cycle_time = c.cycle_time,

    updated_at = NOW()

FROM candidates c

WHERE {MASTER_MATCH_SQL}

  AND c.cycle_time > 0

  AND m.ideal_cycle_time IS DISTINCT FROM c.cycle_time

"""



COUNT_CANDIDATES_SQL = f"""

WITH {CANDIDATES_CTE}

SELECT COUNT(*)::int AS n FROM candidates

"""





def reset_master_from_sheet(*, full_program_tools_refresh: bool = False) -> dict:
    """
    One-time destructive reset: sheet -> program tools -> TRUNCATE master -> reload from sheet.
    Both ideal_cycle_time and production cycle_time are set to Excel / program-tools values.
    """
    import os

    from planning.program_tool_list_route import (
        sync_program_tool_list_to_supabase,
        sync_tool_list_sheet_to_sqlite,
    )

    out: dict = {}
    if os.getenv("tool_list_secret_key", "").strip():
        try:
            out["sheet"] = sync_tool_list_sheet_to_sqlite()
        except Exception as e:
            out["sheet"] = {"error": str(e)}
            return out
    else:
        out["sheet"] = {"skipped": True, "reason": "no tool_list_secret_key"}
        return {
            **out,
            "error": "tool_list_secret_key is not set; cannot read the Excel sheet.",
        }

    try:
        out["program_tools"] = sync_program_tool_list_to_supabase(
            full_refresh=full_program_tools_refresh
        )
        if out["program_tools"].get("error"):
            return out
    except Exception as e:
        out["program_tools"] = {"error": str(e)}
        return out

    out["master"] = reload_master_from_program_tools()
    if out["master"].get("error"):
        return out

    inserted = int(out["master"].get("inserted") or 0)
    out["message"] = (
        f"Reset complete: master table replaced with {inserted} row(s) from the Excel sheet. "
        "Master and production cycle times now match program tools."
    )
    return out


def sync_cycle_times_incremental() -> dict:
    """
    Normal sync: Google Sheet -> planner_program_tools (upsert, no table wipe),
    then insert-only new rows into planner_cycle_time_master (never overwrites existing).
    """
    import os

    from planning.program_tool_list_route import (
        sync_program_tool_list_to_supabase,
        sync_tool_list_sheet_to_sqlite,
    )

    out: dict = {}
    if os.getenv("tool_list_secret_key", "").strip():
        try:
            out["sheet"] = sync_tool_list_sheet_to_sqlite()
        except Exception as e:
            out["sheet"] = {"error": str(e)}
            return out
    else:
        out["sheet"] = {"skipped": True, "reason": "no tool_list_secret_key"}

    try:
        out["program_tools"] = sync_program_tool_list_to_supabase(full_refresh=False)
        if out["program_tools"].get("error"):
            return out
    except Exception as e:
        out["program_tools"] = {"error": str(e)}
        return out

    out["master"] = import_new_from_program_tools()
    out["bom_steps"] = import_new_from_bom_steps()
    out["ideal_sync"] = sync_ideal_cycle_times_from_program_tools()
    imp = out["master"]
    bom = out["bom_steps"]
    ideal = out["ideal_sync"]
    out["message"] = (
        f"Program tools upserted {out['program_tools'].get('upserted', out['program_tools'].get('synced', 0))} row(s); "
        f"master inserted {imp.get('inserted', 0)} new from sheet, "
        f"skipped {imp.get('skipped_existing', 0)} already in master, "
        f"pruned {imp.get('pruned_stale', 0)} stale; "
        f"BOM steps inserted {bom.get('inserted', 0)}, "
        f"skipped {bom.get('skipped_existing', 0)}; "
        f"updated ideal on {ideal.get('updated', 0)} existing row(s)."
    )
    return out


def reload_master_from_program_tools() -> dict:

    """DESTRUCTIVE: replace all master rows. Use sync_cycle_times_incremental() for normal sync."""

    if not _planner_db_available():

        return {

            "error": "SUPA_DB_URL is not set. Direct Postgres is required for reload.",

            "inserted": 0,

            "source_count": 0,

        }



    from sync import PLANNER_STATEMENT_TIMEOUT_MS

    from planning.helpers import planner_db, rows



    with planner_db() as con:

        con.execute(f"SET LOCAL statement_timeout = '{PLANNER_STATEMENT_TIMEOUT_MS}'")

        source = int(rows(con.execute(COUNT_CANDIDATES_SQL))[0].get("n") or 0)

        con.execute(
            "TRUNCATE public.planner_cycle_time_master RESTART IDENTITY CASCADE"
        )

        cur = con.execute(RELOAD_MASTER_SQL)

        inserted = int(cur.rowcount or 0)



    return {

        "inserted": inserted,

        "source_count": source,

        "message": f"Reloaded master table: {inserted} row(s) from program tools.",

    }


