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


# ── Supabase REST helpers ──────────────────────────────────────────────────

def supa_url() -> str:
    return os.getenv("Supa_base_url", "").rstrip("/")


def supa_headers(write: bool = False) -> dict:
    """Return Supabase REST headers.
    write=True uses the service role key (required for INSERT/DELETE).
    """
    if write:
        key = os.getenv("supa_base_secret_key", os.getenv("Supa_base_publishable_key", ""))
    else:
        key = os.getenv("Supa_base_publishable_key", "")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


# ── Supabase direct PostgreSQL connection (for planner module complex queries) ──
# Set SUPA_DB_URL in .env to a direct PostgreSQL connection string, e.g.:
#   SUPA_DB_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres

_planner_pool = None


def get_planner_pool():
    global _planner_pool
    if _planner_pool is None:
        dsn = os.getenv("SUPA_DB_URL")
        if not dsn:
            raise RuntimeError(
                "SUPA_DB_URL env var is not set. "
                "Add it to .env: postgresql://postgres:[pw]@db.[ref].supabase.co:5432/postgres"
            )
        _planner_pool = psycopg2.pool.SimpleConnectionPool(1, 10, dsn=dsn)
    return _planner_pool


def planner_get_conn():
    return get_planner_pool().getconn()


def planner_release_conn(conn):
    get_planner_pool().putconn(conn)
