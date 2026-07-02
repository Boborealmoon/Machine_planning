"""Diagnose MPP planner job intake."""
from __future__ import annotations

from planning.frame_agreement_service import is_frame_agreement_part, load_frame_agreement_part_keys
from planning.helpers import planner_db, rows
from planning.mpp_planner_service import (
    _load_fa_planner_process_sheet_rows,
    fetch_mpp_planner_jobs,
    mpp_machine_code_set,
    _is_mpp_intake_op,
)


def main() -> None:
    with planner_db() as con:
        fa = load_frame_agreement_part_keys(con)
        print("FA parts:", len(fa))
        print("FA sample:", sorted(fa)[:10])

        jobs = fetch_mpp_planner_jobs(con)
        print("Jobs returned:", len(jobs))
        for j in jobs[:8]:
            print(f"  {j.get('psId')} | {j.get('opLabel')} | qty={j.get('qty')}")

        mpp = mpp_machine_code_set(con)
        print("MPP machines:", mpp)

        entries = _load_fa_planner_process_sheet_rows(con, fa)
        print("FA process sheets:", len(entries))
        for item in entries[:12]:
            ps = item.get("ps_id")
            if "029" not in str(ps) and len(entries) > 12:
                continue
            enriched = __import__("planning.mpp_planner_service", fromlist=["_enrich_catalog_entry_ops"])._enrich_catalog_entry_ops(con, dict(item))
            ops = enriched.get("all_ops") or []
            mpp_ops = [o for o in ops if _is_mpp_intake_op(o, mpp)]
            print(f"  PS {ps} partial={item.get('partial_qty')} all_ops={len(ops)} intake_ops={len(mpp_ops)}")
            for o in mpp_ops:
                print("   ", o.get("op_no"), o.get("op_type"), o.get("preferred_machine"), "rem", o.get("remaining_qty"))

        for ps_id in ["NPS26-0292", "NPS26-0293", "NPS26-0294", "NPS26-0222"]:
            print(f"\n--- {ps_id} ---")
            ps_rows = rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id, inventory_code, selected_bom_id, planner_status
                    FROM planner_process_sheet
                    WHERE UPPER(source_ps_id) LIKE %s
                    LIMIT 5
                    """,
                    (ps_id.upper() + "%",),
                )
            )
            print("planner_process_sheet:", len(ps_rows))
            for r in ps_rows:
                inv = r.get("inventory_code")
                print(" ", r, "FA inv?", is_frame_agreement_part(str(inv or ""), fa))
            v_rows = rows(
                con.execute(
                    """
                    SELECT ps_id, part_no, partial_qty, status, bom_code
                    FROM pp_vouchers_cache
                    WHERE UPPER(ps_id) = %s
                    LIMIT 5
                    """,
                    (ps_id.upper(),),
                )
            )
            print("pp_vouchers_cache:", len(v_rows))
            for r in v_rows:
                pn = r.get("part_no")
                print(" ", r, "FA part?", is_frame_agreement_part(str(pn or ""), fa))

        from planning.catalog import trial_catalog_items

        catalog = trial_catalog_items(con, include_completed=False)
        print("\nCatalog available:", len(catalog.get("available") or []))
        print("Catalog planned:", len(catalog.get("planned") or []))
        for item in (catalog.get("available") or [])[:15]:
            ps = item.get("ps_id")
            inv = item.get("inventory_code") or item.get("part_no")
            if "0292" in str(ps) or "0293" in str(ps) or is_frame_agreement_part(str(inv), fa):
                print(
                    " available:",
                    ps,
                    inv,
                    "FA?",
                    is_frame_agreement_part(str(inv), fa),
                    "op_cards",
                    len(item.get("op_cards") or []),
                    "all_ops",
                    len(item.get("all_ops") or []),
                )


if __name__ == "__main__":
    main()
