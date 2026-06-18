"""One-off diagnostic: BOM routes for NPS26-0224."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from planning.flows import erp_bom_codes_by_inventory, flow_options_for_inventory
from planning.helpers import planner_db, rows
from planning.utils import compact_text


def main():
    ps_id = sys.argv[1] if len(sys.argv) > 1 else "NPS26-0224"
    out: dict = {"ps_id": ps_id}

    with planner_db() as con:
        out["pp_vouchers_cache"] = [
            dict(r)
            for r in rows(
                con.execute(
                    """
                    SELECT ps_id, pp_partial_no, part_no, bom_code, description, status
                    FROM pp_vouchers_cache
                    WHERE ps_id = %s
                    ORDER BY pp_partial_no, stage_no NULLS FIRST
                    LIMIT 20
                    """,
                    (ps_id,),
                )
            )
        ]
        out["planner_process_sheet"] = [
            {
                k: r[k]
                for k in (
                    "planner_ps_id",
                    "source_ps_id",
                    "pp_partial_no",
                    "inventory_code",
                    "selected_bom_id",
                )
            }
            for r in rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id, pp_partial_no, inventory_code, selected_bom_id
                    FROM planner_process_sheet
                    WHERE source_ps_id = %s OR planner_ps_id LIKE %s
                    """,
                    (ps_id, f"{ps_id}::%"),
                )
            )
        ]

        invs: set[str] = set()
        for row in out["pp_vouchers_cache"]:
            invs.add(compact_text(row.get("part_no")))
        for row in out["planner_process_sheet"]:
            invs.add(compact_text(row.get("inventory_code")))
        invs.discard("")
        out["inventory_codes"] = sorted(invs)

        bom_by_inv = {}
        for inv in invs:
            bom_by_inv[inv] = {
                "bom_op_stage": [
                    r["bom_code"]
                    for r in rows(
                        con.execute(
                            """
                            SELECT DISTINCT bom_code
                            FROM bom_op_stage
                            WHERE inventory_code = %s
                            ORDER BY bom_code
                            """,
                            (inv,),
                        )
                    )
                ],
                "planner_bom_variation": [
                    dict(r)
                    for r in rows(
                        con.execute(
                            """
                            SELECT bom_id, bom_code, is_default, source_kind
                            FROM planner_bom_variation
                            WHERE inventory_code = %s
                            ORDER BY bom_id
                            """,
                            (inv,),
                        )
                    )
                ],
                "flow_options": flow_options_for_inventory(con, inv),
            }
        out["routes_by_inventory"] = bom_by_inv

        out["fuzzy_bom_op_stage_bb15"] = [
            dict(r)
            for r in rows(
                con.execute(
                    """
                    SELECT DISTINCT inventory_code, bom_code
                    FROM bom_op_stage
                    WHERE inventory_code ILIKE %s
                    ORDER BY inventory_code, bom_code
                    LIMIT 50
                    """,
                    ("%BB15-081485%",),
                )
            )
        ]

        # ERP domain: inventory_bom_listing lives on COMAIN — skip if unavailable
        try:
            from db import get_conn, release_conn

            erp = get_conn()
            try:
                with erp.cursor() as cur:
                    cur.execute(
                        """
                        SELECT DISTINCT source_inventory_code, bom_code
                        FROM public.inventory_bom_listing
                        WHERE source_inventory_code ILIKE %s
                        ORDER BY 1, 2
                        LIMIT 50
                        """,
                        ("%BB15-081485%",),
                    )
                    cols = [d[0] for d in cur.description]
                    out["erp_inventory_bom_listing_bb15"] = [
                        dict(zip(cols, row)) for row in cur.fetchall()
                    ]
                    cur.execute(
                        """
                        SELECT DISTINCT s.inventory_code, s.bom_code
                        FROM public.mt_inventory_bom_stage s
                        WHERE s.inventory_code ILIKE %s
                        ORDER BY 1, 2
                        LIMIT 50
                        """,
                        ("%BB15-081485%",),
                    )
                    cols = [d[0] for d in cur.description]
                    out["erp_mt_inventory_bom_stage_bb15"] = [
                        dict(zip(cols, row)) for row in cur.fetchall()
                    ]
            finally:
                release_conn(erp)
        except Exception as exc:
            out["erp_error"] = str(exc)

    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
