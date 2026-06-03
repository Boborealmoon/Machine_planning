import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db import get_conn, release_conn
from sync import _build_mfg_wo_status_sql

PS = "NPS25-0279"

src = get_conn()
try:
    with src.cursor() as cur:
        cur.execute(
            """
            SELECT source_pp_partial_no, stage_no, COUNT(*) cnt,
                   SUM(wo_qty_required) req, SUM(total_acc_qty_produced) prod
            FROM (
                SELECT t2.source_pp_partial_no, t2.stage_no,
                       t3.wo_qty_required, t3.total_acc_qty_produced
                FROM mfg_mps_vch t2
                JOIN mfg_wo_vch t3 ON t2.wo_voucher_no = t3.voucher_no AND t2.stage_no = t3.stage_no
                WHERE t2.source_pp_no = %s
            ) x
            GROUP BY source_pp_partial_no, stage_no
            ORDER BY source_pp_partial_no, stage_no
            """,
            (PS,),
        )
        print("raw COMAIN by partial/stage:")
        for r in cur.fetchall():
            print(r)

        sql, params = _build_mfg_wo_status_sql(scoped=True)
        cur.execute(
            f"SELECT * FROM ({sql}) q WHERE source_mps_no = %s ORDER BY pp_partial_no, stage_no",
            (*params, PS),
        )
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        print(f"\nsync SQL output for {PS}: {len(rows)} rows")
        for r in rows:
            d = dict(zip(cols, r))
            print(
                d.get("pp_partial_no"),
                d.get("stage_no"),
                d.get("stage_desc"),
                d.get("total_acc_qty_produced"),
                d.get("execution_status"),
            )
finally:
    try:
        release_conn(src)
    except Exception:
        src.close()
