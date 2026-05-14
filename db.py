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
