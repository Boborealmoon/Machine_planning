"""
planning/helpers.py
-------------------
Database helpers for the planner module. Provides a thin psycopg2 wrapper
that mimics the SQLite con.execute() / one() / rows() interface used in
the old route code, so ported queries need only table-name / column-name
changes — not a structural rewrite.

Usage:
    from planning.helpers import planner_db, one, rows, parse_dt_text

    with planner_db() as con:
        row  = one(con.execute("SELECT ... FROM planner_machines WHERE machine_id = %s", (mid,)))
        data = rows(con.execute("SELECT ... FROM planner_process_sheet"))
"""
from __future__ import annotations

import re
from contextlib import contextmanager
from datetime import datetime

import psycopg2
import psycopg2.extras

from db import planner_get_conn, planner_release_conn


# ── Row helpers ───────────────────────────────────────────────────────────────

def one(cur):
    """Fetch a single row as a plain dict (or None)."""
    row = cur.fetchone()
    return dict(row) if row is not None else None


def rows(cur):
    """Fetch all rows as a list of plain dicts."""
    return [dict(r) for r in cur.fetchall()]


def planner_try_savepoint(con, name: str, fn, default=None):
    """Run fn() inside a SAVEPOINT; roll back to it on failure so the outer tx stays usable."""
    savepoint = re.sub(r"[^a-zA-Z0-9_]", "_", compact_savepoint_name(name)) or "sp"
    con.execute(f"SAVEPOINT {savepoint}")
    try:
        result = fn()
        con.execute(f"RELEASE SAVEPOINT {savepoint}")
        return result
    except Exception:
        try:
            con.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
        except Exception:
            pass
        return default


def compact_savepoint_name(name: str) -> str:
    text = str(name or "").strip()
    if len(text) <= 63:
        return text
    return text[:63]


def parse_dt_text(value):
    """Parse a datetime string / object into naive Singapore wall time (or None)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            from .utils import PLANNER_TZ
            return value.astimezone(PLANNER_TZ).replace(tzinfo=None)
        return value
    from .utils import planner_wall_datetime_to_api
    text = planner_wall_datetime_to_api(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text[:19])
    except ValueError:
        return None


# ── Connection wrapper ────────────────────────────────────────────────────────

_PLACEHOLDER_RE = re.compile(r"\?")


class PlannerCon:
    """
    Wraps a psycopg2 connection and mimics the SQLite connection interface:

        cur = con.execute(sql, params)
        row = one(cur)
        data = rows(cur)

    SQLite-style ? placeholders are automatically converted to %s so that
    ported SQL strings need no placeholder changes.
    """

    def __init__(self, conn: psycopg2.extensions.connection):
        self._conn = conn

    def execute(self, sql: str, params=None):
        pg_sql = _PLACEHOLDER_RE.sub("%s", sql)
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(pg_sql, params)
        return cur

    def executemany(self, sql: str, seq_of_params):
        pg_sql = _PLACEHOLDER_RE.sub("%s", sql)
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.executemany(pg_sql, seq_of_params)
        return cur

    def execute_values(self, sql: str, argslist, template=None, page_size=500):
        """One multi-row INSERT/UPSERT instead of N round-trips."""
        pg_sql = _PLACEHOLDER_RE.sub("%s", sql)
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        psycopg2.extras.execute_values(cur, pg_sql, argslist, template=template, page_size=page_size)
        return cur

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()


@contextmanager
def planner_db():
    """Context manager that yields a PlannerCon and commits/rolls back."""
    conn = planner_get_conn()
    wrapped = PlannerCon(conn)
    try:
        yield wrapped
        try:
            conn.commit()
        except Exception:
            try:
                if not getattr(conn, "closed", 1):
                    conn.rollback()
            except Exception:
                pass
            raise
    except Exception:
        try:
            if not getattr(conn, "closed", 1):
                conn.rollback()
        except Exception:
            pass
        raise
    finally:
        planner_release_conn(conn)
