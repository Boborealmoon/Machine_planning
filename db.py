import os
import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv

load_dotenv()

# ── COMAIN pool ────────────────────────────────────────────────────────────

_pool = None


def get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.SimpleConnectionPool(
            1, 20,
            host=os.getenv("DB_HOST", "localhost"),
            port=int(os.getenv("DB_PORT", 5432)),
            dbname=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
        )
    return _pool


def get_conn():
    return get_pool().getconn()


def release_conn(conn):
    get_pool().putconn(conn)


# ── Supabase pool ──────────────────────────────────────────────────────────

_supa_pool = None


def get_supa_pool():
    global _supa_pool
    if _supa_pool is None:
        _supa_pool = psycopg2.pool.SimpleConnectionPool(
            1, 10,
            host=os.getenv("SUPABASE_DB_HOST"),
            port=int(os.getenv("SUPABASE_DB_PORT", 5432)),
            dbname=os.getenv("SUPABASE_DB_NAME", "postgres"),
            user=os.getenv("SUPABASE_DB_USER", "postgres"),
            password=os.getenv("SUPABASE_DB_PASSWORD"),
            sslmode="require",
        )
    return _supa_pool


def get_supa_conn():
    return get_supa_pool().getconn()


def release_supa_conn(conn):
    get_supa_pool().putconn(conn)
