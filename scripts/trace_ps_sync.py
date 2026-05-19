"""Trace why a process sheet may be missing after ERP sync.

Usage (repo root):
  python scripts/trace_ps_sync.py NPS26-0174
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import get_conn, release_conn, planner_get_conn, planner_release_conn


def main():
    ps_id = (sys.argv[1] if len(sys.argv) > 1 else "").strip().upper()
    if not ps_id:
        print("Usage: python scripts/trace_ps_sync.py <PS_ID>")
        sys.exit(1)

    pattern = f"%{ps_id}%"
    print(f"Tracing {ps_id}\n")

    cmain = get_conn()
    try:
        with cmain.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM public.mfg_pp_vch v
                WHERE v.pp_voucher_no ILIKE %s
                   OR EXISTS (
                        SELECT 1 FROM public.mfg_process_sheet_info_v1_view ps
                        WHERE ps.pp_voucher_no = v.pp_voucher_no
                          AND ps.process_sheet_no ILIKE %s
                   )
                """,
                (pattern, pattern),
            )
            print(f"COMAIN mfg_pp_vch (voucher or linked PS): {cur.fetchone()[0]} row(s)")

            cur.execute(
                """
                SELECT COUNT(*) FROM public.mfg_pp_vch v
                LEFT JOIN (
                    SELECT inventory_code, bom_code
                    FROM public.mt_inventory_bom_stage
                    WHERE stage_desc LIKE 'Turning%%'
                       OR stage_desc LIKE 'Milling%%'
                       OR stage_desc LIKE 'Turnmill%%'
                ) s ON s.inventory_code = v.inventory_code AND s.bom_code = v.bom_code
                WHERE (v.pp_voucher_no ILIKE %s OR EXISTS (
                        SELECT 1 FROM public.mfg_process_sheet_info_v1_view ps
                        WHERE ps.pp_voucher_no = v.pp_voucher_no AND ps.process_sheet_no ILIKE %s
                  ))
                  AND s.inventory_code IS NOT NULL
                """,
                (pattern, pattern),
            )
            print(f"COMAIN mfg_pp_vch with CNC BOM stages (extra stage rows): {cur.fetchone()[0]} voucher(s)")

            cur.execute(
                "SELECT COUNT(*) FROM public.mfg_process_sheet_info_v1_view WHERE process_sheet_no ILIKE %s",
                (pattern,),
            )
            print(f"COMAIN mfg_process_sheet_info_v1_view: {cur.fetchone()[0]} row(s)")
    finally:
        release_conn(cmain)

    try:
        supa = planner_get_conn()
    except Exception as e:
        print(f"\nSupabase planner DB unavailable: {e}")
        return

    try:
        with supa.cursor() as cur:
            for tbl, col in (
                ("pp_voucher", "pp_voucher_no"),
                ("mfg_process_sheet_info", "process_sheet_no"),
                ("pp_vouchers_cache", "ps_id"),
            ):
                cur.execute(f"SELECT COUNT(*) FROM public.{tbl} WHERE {col} ILIKE %s", (pattern,))
                print(f"Supabase {tbl}: {cur.fetchone()[0]} row(s)")

            cur.execute("SELECT COUNT(*) FROM public.vw_pp_vouchers WHERE ps_id ILIKE %s", (pattern,))
            print(f"Supabase vw_pp_vouchers: {cur.fetchone()[0]} row(s)")
    finally:
        planner_release_conn(supa)

    print(
        "\nNote: mfg_pp_vch exists only on COMAIN. Supabase holds pp_voucher (staged) and "
        "pp_vouchers_cache (app cache). Use Sync ERP or POST /api/pp-staging/sync to reload."
    )


if __name__ == "__main__":
    main()
