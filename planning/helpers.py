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


def parse_dt_text(value):
    """Parse a datetime string / object into a naive local datetime (or None)."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo is not None else value
    text = str(value or "").strip().replace("T", " ")
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
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        planner_release_conn(conn)
