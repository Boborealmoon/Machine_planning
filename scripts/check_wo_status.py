import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from planning.helpers import planner_db, rows

PS = "NPS25-0279"

with planner_db() as con:
    all_rows = rows(con.execute(
        "SELECT pp_partial_no, stage_no, stage_desc, total_acc_qty_produced, execution_status "
        "FROM mfg_wo_status WHERE source_mps_no = %s ORDER BY pp_partial_no, stage_no",
        (PS,),
    ))
    print(f"total rows for {PS}: {len(all_rows)}")
    for r in all_rows:
        print(dict(r))

    partials = rows(con.execute(
        "SELECT pp_partial_no, COUNT(*) cnt FROM mfg_wo_status WHERE source_mps_no = %s GROUP BY pp_partial_no ORDER BY 1",
        (PS,),
    ))
    print("\nby partial:", [dict(x) for x in partials])

    # Check COMAIN source field via any sample
    sample = rows(con.execute(
        "SELECT source_mps_no, pp_partial_no, stage_no, origin_voucher_no FROM mfg_wo_status "
        "WHERE source_mps_no LIKE 'NPS25-0279%' LIMIT 20"
    ))
    print("\nsample origin vouchers:")
    for r in sample:
        print(dict(r))
