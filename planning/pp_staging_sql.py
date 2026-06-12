"""Load and apply canonical PP staging SQL from sql/*.sql files."""
from __future__ import annotations

from pathlib import Path

from .helpers import one

_SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def sql_dir() -> Path:
    return _SQL_DIR


def read_sql_file(name: str) -> str:
    path = _SQL_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"SQL file not found: {path}")
    return path.read_text(encoding="utf-8")


def split_sql_statements(sql: str) -> list[str]:
    """Split a script into individual statements (skips blank lines and -- comments)."""
    statements: list[str] = []
    buf: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        buf.append(line)
        if stripped.endswith(";"):
            stmt = "\n".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
    if buf:
        tail = "\n".join(buf).strip()
        if tail:
            statements.append(tail)
    return statements


def vw_pp_vouchers_exists(con) -> bool:
    row = one(
        con.execute(
            """
            SELECT 1 AS ok
            FROM information_schema.views
            WHERE table_schema = 'public'
              AND table_name = 'vw_pp_vouchers'
            """
        )
    )
    return bool(row)


def apply_pp_staging_schema_patches(con) -> int:
    """Idempotent ALTER/CREATE for staging tables. Safe on every ERP sync."""
    statements = split_sql_statements(read_sql_file("pp_staging_schema.sql"))
    for stmt in statements:
        con.execute(stmt)
    return len(statements)


def apply_vw_pp_vouchers(con) -> None:
    """CREATE OR REPLACE the combined voucher view from sql/vw_pp_vouchers.sql."""
    con.execute(read_sql_file("vw_pp_vouchers.sql"))


def ensure_pp_staging_schema(*, apply_view: bool = False) -> dict:
    """
    Apply staging schema patches; optionally refresh vw_pp_vouchers.

    Column TYPE patches on pp_voucher / qty-shipped staging tables require
    dropping vw_pp_vouchers first (PostgreSQL blocks ALTER on view-backed cols).
    The view is recreated after patches when it existed or is missing.
    """
    from db import planner_get_conn, planner_release_conn

    conn = planner_get_conn()
    wrapped = None
    try:
        from .helpers import PlannerCon

        wrapped = PlannerCon(conn)
        had_view = vw_pp_vouchers_exists(wrapped)
        if had_view:
            wrapped.execute("DROP VIEW IF EXISTS public.vw_pp_vouchers")
        apply_pp_staging_schema_patches(wrapped)
        view_applied = False
        if apply_view or had_view or not vw_pp_vouchers_exists(wrapped):
            apply_vw_pp_vouchers(wrapped)
            view_applied = True
        conn.commit()
        return {"schema_patches": True, "view_applied": view_applied, "view_rebuilt": had_view or view_applied}
    except Exception:
        conn.rollback()
        raise
    finally:
        planner_release_conn(conn)
