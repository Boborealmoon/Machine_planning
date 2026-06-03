import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db import get_conn, release_conn

PS = "NPS25-0279"

src = get_conn()
try:
    with src.cursor() as cur:
        cur.execute(
            """
            SELECT t2.origin_voucher_no, t2.wo_voucher_no, t2.source_pp_no, t2.source_pp_partial_no,
                   t2.stage_no, t3.wo_qty_required, t3.total_acc_qty_produced, t3.execution_status,
                   t3.stage_desc
            FROM mfg_mps_vch t2
            JOIN mfg_wo_vch t3 ON t2.wo_voucher_no = t3.voucher_no AND t2.stage_no = t3.stage_no
            WHERE t2.source_pp_no = %s
            ORDER BY t2.source_pp_partial_no, t2.origin_voucher_no, t2.stage_no
            LIMIT 80
            """,
            (PS,),
        )
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        print(f"rows: {len(rows)}")
        for r in rows:
            print(dict(zip(cols, r)))

        cur.execute(
            """
            SELECT pp_partial_no, partial_qty, pp_voucher_no
            FROM mfg_pp_partial WHERE pp_voucher_no = %s ORDER BY pp_partial_no
            """,
            (PS,),
        )
        print("\npartials:")
        for r in cur.fetchall():
            print(r)
finally:
    try:
        release_conn(src)
    except Exception:
        src.close()
