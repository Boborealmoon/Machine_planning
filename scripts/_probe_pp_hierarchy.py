"""Probe mfg_pp_vch, mfg_pp_partial_view, so_order_view relationships."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2.extras
from db import get_conn, release_conn

TABLES = ("mfg_pp_vch", "mfg_pp_partial_view", "so_order_view", "so_detail")


def columns(cur, name):
    cur.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (name,),
    )
    return [{"name": r[0], "type": r[1]} for r in cur.fetchall()]


out = {}
conn = get_conn()
try:
    with conn.cursor() as cur:
        for t in TABLES:
            out[f"{t}_columns"] = columns(cur, t)

        cur.execute(
            """
            SELECT COUNT(*) AS pp_rows,
                   COUNT(DISTINCT source_voucher_no) AS source_orders,
                   COUNT(DISTINCT pp_voucher_no) AS pp_vouchers
            FROM public.mfg_pp_vch
            WHERE source_voucher_no IS NOT NULL
            """
        )
        out["mfg_pp_vch_counts"] = dict(
            zip(["pp_rows", "source_orders", "pp_vouchers"], cur.fetchone())
        )

        cur.execute(
            """
            SELECT COUNT(*) AS partial_rows,
                   COUNT(DISTINCT pp_voucher_no) AS pp_vouchers,
                   COUNT(DISTINCT pp_partial_no) AS partials
            FROM public.mfg_pp_partial_view
            """
        )
        out["mfg_pp_partial_counts"] = dict(
            zip(["partial_rows", "pp_vouchers", "partials"], cur.fetchone())
        )

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT v.source_voucher_no, v.pp_voucher_no, COUNT(p.pp_partial_no) AS partial_count
            FROM public.mfg_pp_vch v
            LEFT JOIN public.mfg_pp_partial_view p ON p.pp_voucher_no = v.pp_voucher_no
            WHERE v.source_voucher_no LIKE 'SO/%%'
            GROUP BY v.source_voucher_no, v.pp_voucher_no
            HAVING COUNT(p.pp_partial_no) > 1
            ORDER BY partial_count DESC
            LIMIT 3
            """
        )
        out["multi_partial_samples"] = [dict(r) for r in cur.fetchall()]

        sample_so = None
        if out["multi_partial_samples"]:
            sample_so = out["multi_partial_samples"][0]["source_voucher_no"]
        if not sample_so:
            cur.execute(
                """
                SELECT source_voucher_no
                FROM public.mfg_pp_vch
                WHERE source_voucher_no LIKE 'SO/%%'
                LIMIT 1
                """
            )
            row = cur.fetchone()
            sample_so = row["source_voucher_no"] if row else None

        if sample_so:
            cur.execute("SELECT * FROM public.so_order_view WHERE sales_order_no = %s LIMIT 1", (sample_so,))
            out["sample_so_header"] = dict(cur.fetchone() or {})

            cur.execute(
                """
                SELECT *
                FROM public.mfg_pp_vch
                WHERE source_voucher_no = %s
                ORDER BY pp_voucher_no
                LIMIT 5
                """,
                (sample_so,),
            )
            pp_rows = [dict(r) for r in cur.fetchall()]
            out["sample_pp_vch"] = pp_rows

            if pp_rows:
                pp_no = pp_rows[0]["pp_voucher_no"]
                cur.execute(
                    """
                    SELECT *
                    FROM public.mfg_pp_partial_view
                    WHERE pp_voucher_no = %s
                    ORDER BY pp_partial_no
                    """,
                    (pp_no,),
                )
                out["sample_partials"] = [dict(r) for r in cur.fetchall()]
finally:
    release_conn(conn)

path = os.path.join(os.path.dirname(__file__), "_probe_pp_hierarchy_out.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, default=str)
print(path)
