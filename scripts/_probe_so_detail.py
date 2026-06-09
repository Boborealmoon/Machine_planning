"""Probe public.so_detail on COMAIN."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2.extras
from db import get_conn, release_conn

out = {}
conn = get_conn()
try:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'so_detail'
            ORDER BY ordinal_position
            """
        )
        out["columns"] = [{"name": r[0], "type": r[1]} for r in cur.fetchall()]
        cur.execute(
            """
            SELECT COUNT(*) AS n,
                   COUNT(DISTINCT sales_order_no) AS orders
            FROM public.so_detail
            """
        )
        out["counts"] = dict(zip(["rows", "orders"], cur.fetchone()))
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT *
            FROM public.so_detail
            WHERE sales_order_no = (
                SELECT sales_order_no FROM public.so_order_view
                WHERE voucher_status = 'O'
                ORDER BY order_date DESC NULLS LAST
                LIMIT 1
            )
            ORDER BY line_item_no
            LIMIT 5
            """
        )
        out["sample_lines"] = [dict(r) for r in cur.fetchall()]
finally:
    release_conn(conn)

path = os.path.join(os.path.dirname(__file__), "_probe_so_detail_out.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, default=str)
print(path)
