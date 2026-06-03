"""Check pp_vouchers_cache WO linkage vs mfg_wo_status for sample or all NPS rows."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.helpers import planner_db, rows

SAMPLE = ["NPS25-0128", "NPS25-0193", "NPS25-0194", "NPS25-0248"]


def stage_key(desc):
    return (desc or "").strip().lower()


def check_ps(con, ps):
    cache = rows(
        con.execute(
            """
            SELECT pp_partial_no, stage_no, stage_desc, op_no,
                   wo_qty_produced, execution_status, qty_shipped, partial_qty
            FROM pp_vouchers_cache
            WHERE ps_id = %s
            ORDER BY pp_partial_no, stage_no
            """,
            (ps,),
        )
    )
    wo = rows(
        con.execute(
            """
            SELECT pp_partial_no, stage_no, stage_desc,
                   total_acc_qty_produced, execution_status
            FROM mfg_wo_status
            WHERE source_mps_no = %s
            ORDER BY pp_partial_no, stage_no
            """,
            (ps,),
        )
    )
    if not cache:
        return {"ps": ps, "cache_rows": 0, "issue": "no_cache"}

    wo_by_partial = {}
    for r in wo:
        p = int(r["pp_partial_no"] or 1)
        wo_by_partial.setdefault(p, {})[stage_key(r["stage_desc"])] = r

    missing = []
    wrong_no_match = []
    for c in cache:
        if not (c.get("stage_desc") or "").strip():
            continue
        p = int(c["pp_partial_no"] or 1)
        desc = stage_key(c["stage_desc"])
        erp = wo_by_partial.get(p, {}).get(desc)
        prod = c.get("wo_qty_produced")
        if erp and erp.get("total_acc_qty_produced") and (prod is None or float(prod) == 0):
            # cache missing but ERP has output — join bug or stale cache
            missing.append(
                {
                    "partial": p,
                    "stage": c["stage_desc"],
                    "bom_stage_no": c["stage_no"],
                    "erp_stage_no": erp["stage_no"],
                    "erp_prod": erp["total_acc_qty_produced"],
                }
            )
        if erp and int(c["stage_no"] or 0) != int(erp["stage_no"] or 0):
            wrong_no_match.append(
                (p, c["stage_desc"], c["stage_no"], erp["stage_no"])
            )

    return {
        "ps": ps,
        "cache_rows": len(cache),
        "erp_stages": len(wo),
        "missing_output": missing,
        "stage_no_mismatch": wrong_no_match,
    }


def main():
    raw_args = [a.strip() for a in sys.argv[1:]]
    if raw_args == ["--scan-nps25"]:
        only = None
    else:
        only = [a.upper() for a in raw_args] or SAMPLE
    with planner_db() as con:
        if only is None:
            ps_ids = [
                r["ps_id"]
                for r in rows(
                    con.execute(
                        """
                        SELECT DISTINCT ps_id
                        FROM pp_vouchers_cache
                        WHERE ps_id LIKE 'NPS25-%'
                        ORDER BY ps_id
                        """
                    )
                )
            ]
        else:
            ps_ids = only

        bad = []
        for ps in ps_ids:
            r = check_ps(con, ps)
            if r.get("missing_output"):
                bad.append(r)

        print(f"Checked {len(ps_ids)} process sheet(s)\n")
        for r in bad[:50]:
            print(f"{r['ps']}: {len(r['missing_output'])} stage(s) missing WO in cache")
            for m in r["missing_output"][:5]:
                print(
                    f"  partial {m['partial']} {m['stage']}: "
                    f"BOM st{m['bom_stage_no']} vs ERP st{m['erp_stage_no']} "
                    f"(ERP prod={m['erp_prod']})"
                )
        if len(bad) > 50:
            print(f"... and {len(bad) - 50} more")
        print(f"\nTotal with missing cache output: {len(bad)} / {len(ps_ids)}")

        # stage_no-only join would have failed: count mismatches
        mismatch_ps = sum(1 for r in (check_ps(con, ps) for ps in ps_ids) if r.get("stage_no_mismatch"))
        print(f"PS with BOM vs ERP stage_no mismatch (same desc): {mismatch_ps}")


if __name__ == "__main__":
    main()
