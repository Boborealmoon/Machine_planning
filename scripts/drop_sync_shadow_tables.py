"""Drop legacy *_shadow / *_old staging tables from Supabase."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.helpers import planner_db, rows

SQL_PATH = Path(__file__).resolve().parents[1] / "migrations" / "drop_sync_shadow_tables.sql"


def main():
    statements = [
        line.strip()
        for line in SQL_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip().upper().startswith("DROP ")
    ]
    print(f"Dropping {len(statements)} legacy table(s) via SUPA_DB_URL...")
    with planner_db() as con:
        con.execute("SET LOCAL statement_timeout = '120000'")
        for stmt in statements:
            # e.g. DROP TABLE IF EXISTS public.pp_voucher_shadow CASCADE;
            parts = stmt.replace(";", "").split()
            table = parts[4] if len(parts) > 4 else stmt
            print(f"  {table}")
            con.execute(stmt)
    print("Done.")

    with planner_db() as con:
        left = rows(
            con.execute(
                """
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'public'
                  AND (tablename LIKE '%%_shadow' OR tablename LIKE '%%_old')
                ORDER BY 1
                """
            )
        )
    if left:
        print("WARNING: still present:", [r["tablename"] for r in left])
    else:
        print("Verified: no *_shadow or *_old tables remain.")


if __name__ == "__main__":
    main()
