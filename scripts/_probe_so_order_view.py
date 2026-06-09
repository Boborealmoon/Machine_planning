"""One-off probe for public.so_order_view."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import get_conn, release_conn
import psycopg2.extras

conn = get_conn()
try:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema='public' AND table_name='so_order_view'
            ORDER BY ordinal_position
            """
        )
        print("COLUMNS:")
        for row in cur.fetchall():
            print(" ", row)

        cur.execute(
            """
            SELECT voucher_status, count(*)
            FROM public.so_order_view
            GROUP BY voucher_status
            ORDER BY 2 DESC
            LIMIT 30
            """
        )
        print("STATUSES:")
        for row in cur.fetchall():
            print(" ", row)

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM public.so_order_view LIMIT 1")
        row = cur.fetchone()
        if row:
            print("SAMPLE:")
            for k, v in dict(row).items():
                print(f"  {k}: {v!r}")
finally:
    release_conn(conn)
