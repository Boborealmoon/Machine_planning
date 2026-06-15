"""Diagnose NPS26-0150 ERP vs planner state."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PS = "NPS26-0150"
pattern = f"%{PS}%"

print(f"=== COMAIN (ERP) ===")
from db import get_conn, release_conn

cmain = get_conn()
try:
    with cmain.cursor() as cur:
        cur.execute(
            """
            SELECT process_sheet_no, pp_voucher_no, inventory_code, total_qty
            FROM public.mfg_process_sheet_info_v1_view
            WHERE process_sheet_no ILIKE %s
            """,
            (pattern,),
        )
        for row in cur.fetchall():
            print("PS info:", row)

        cur.execute(
            """
            SELECT pp_voucher_no, status, stage_no, stage_desc, inventory_code
            FROM public.mfg_pp_vch
            WHERE pp_voucher_no ILIKE %s
               OR EXISTS (
                    SELECT 1 FROM public.mfg_process_sheet_info_v1_view ps
                    WHERE ps.pp_voucher_no = mfg_pp_vch.pp_voucher_no
                      AND ps.process_sheet_no ILIKE %s
               )
            ORDER BY stage_no
            LIMIT 20
            """,
            (pattern, pattern),
        )
        rows = cur.fetchall()
        print(f"mfg_pp_vch rows: {len(rows)}")
        for row in rows[:10]:
            print("  voucher:", row)

        cur.execute(
            """
            SELECT source_mps_no, pp_partial_no, stage_no, stage_desc,
                   execution_status, wo_qty_required, total_acc_qty_produced
            FROM (
                SELECT DISTINCT ON (t2.source_pp_no, t2.stage_no, t3.wo_qty_required)
                    t2.source_pp_no AS source_mps_no,
                    COALESCE(t2.source_pp_partial_no, 1) AS pp_partial_no,
                    t2.stage_no,
                    t2.stage_desc,
                    t3.execution_status,
                    t3.wo_qty_required,
                    t3.total_acc_qty_produced
                FROM public.mfg_wo_vch t2
                JOIN public.mfg_wo_status_v1_view t3
                  ON t2.wo_voucher_no = t3.voucher_no AND t2.stage_no = t3.stage_no
                WHERE t2.source_pp_no ILIKE %s
                ORDER BY t2.source_pp_no, t2.stage_no, t3.wo_qty_required
            ) x
            ORDER BY pp_partial_no, stage_no
            LIMIT 30
            """,
            (pattern,),
        )
        wo_rows = cur.fetchall()
        print(f"COMAIN WO status rows: {len(wo_rows)}")
        for row in wo_rows:
            print("  wo:", row)
finally:
    release_conn(cmain)

print(f"\n=== Supabase / planner DB ===")
from db import planner_get_conn, planner_release_conn

supa = planner_get_conn()
try:
    with supa.cursor() as cur:
        for tbl, col in (
            ("mfg_process_sheet_info", "process_sheet_no"),
            ("pp_vouchers_cache", "ps_id"),
            ("mfg_wo_status", "source_mps_no"),
        ):
            cur.execute(
                f"SELECT COUNT(*) FROM public.{tbl} WHERE {col} ILIKE %s",
                (pattern,),
            )
            print(f"{tbl} count:", cur.fetchone()[0])

        cur.execute(
            """
            SELECT ps_id, pp_partial_no, stage_no, stage_desc, execution_status,
                   current_stage_no, current_stage_desc, current_stage_status,
                   wo_qty_produced, wo_qty_required, status
            FROM public.pp_vouchers_cache
            WHERE ps_id ILIKE %s
            ORDER BY pp_partial_no, stage_no
            """,
            (pattern,),
        )
        cache_rows = cur.fetchall()
        print(f"pp_vouchers_cache detail ({len(cache_rows)} rows):")
        for row in cache_rows:
            print("  cache:", row)

        cur.execute(
            """
            SELECT source_mps_no, pp_partial_no, stage_no, stage_desc,
                   execution_status, wo_qty_required, total_acc_qty_produced
            FROM public.mfg_wo_status
            WHERE source_mps_no ILIKE %s
            ORDER BY pp_partial_no, stage_no
            """,
            (pattern,),
        )
        stg_rows = cur.fetchall()
        print(f"mfg_wo_status staged ({len(stg_rows)} rows):")
        for row in stg_rows:
            print("  staged:", row)

        cur.execute(
            """
            SELECT ps_id, pp_partial_no, current_stage_desc, current_stage_status,
                   execution_status, wo_qty_produced
            FROM public.vw_pp_vouchers
            WHERE ps_id ILIKE %s
            ORDER BY pp_partial_no, stage_no
            LIMIT 15
            """,
            (pattern,),
        )
        vw_rows = cur.fetchall()
        print(f"vw_pp_vouchers sample ({len(vw_rows)} rows):")
        for row in vw_rows:
            print("  view:", row)
finally:
    planner_release_conn(supa)
