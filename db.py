import os
import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv

load_dotenv()

# ── COMAIN pool ────────────────────────────────────────────────────────────

_pool = None


def _db_connect_timeout() -> int:
    return max(1, int(os.getenv("DB_CONNECT_TIMEOUT", "10")))


def domain_db_endpoint() -> tuple[str, int]:
    host = (os.getenv("DB_HOST") or "").strip()
    port = int(os.getenv("DB_PORT", 5432))
    return host, port


def domain_sync_unreachable(probe_timeout: float | None = None) -> bool:
    """True if COMAIN Postgres cannot be reached from this host (TCP probe)."""
    host, port = domain_db_endpoint()
    if not host:
        return True
    timeout = probe_timeout if probe_timeout is not None else min(3.0, float(_db_connect_timeout()))
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def domain_sync_likely_unreachable() -> bool:
    """True when DB_HOST looks like a private LAN address (heuristic only)."""
    host, _port = domain_db_endpoint()
    if not host or host in {"localhost", "127.0.0.1", "::1"}:
        return False
    parts = host.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(p) for p in parts]
    except ValueError:
        return False
    if any(o < 0 or o > 255 for o in octets):
        return False
    a, b = octets[0], octets[1]
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    return False


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
            connect_timeout=_db_connect_timeout(),
        )
    return _pool


def get_conn():
    return get_pool().getconn()


def release_conn(conn):
    get_pool().putconn(conn)


# ── Supabase REST helpers ──────────────────────────────────────────────────

def supa_url() -> str:
    """PostgREST base URL, e.g. https://xxxx.supabase.co/rest/v1"""
    explicit = (os.getenv("Supa_base_url") or "").strip().rstrip("/")
    project_url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")

    raw = explicit or (f"{project_url}/rest/v1" if project_url else "")
    if not raw:
        return ""

    # Legacy: Supa_base_url sometimes stored as https://PROJECT.supabase.co without /rest/v1
    try:
        from urllib.parse import urlparse

        u = urlparse(raw)
        host = (u.netloc or "").lower()
        path = (u.path or "").strip("/")
        if host.endswith(".supabase.co") and not path.startswith("rest"):
            return raw.rstrip("/") + "/rest/v1"
    except Exception:
        pass

    return raw


def supa_publishable_key() -> str:
    return (os.getenv("Supa_base_publishable_key") or os.getenv("SUPABASE_ANON_KEY") or "").strip()


def supa_service_role_key() -> str:
    """Service role key — required for server-side bulk DELETE/INSERT past RLS."""
    return (os.getenv("supa_base_secret_key") or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()


def supa_headers(write: bool = False) -> dict:
    """Return Supabase REST headers.
    write=True should use the service role key (required for INSERT/DELETE if RLS is on).
    """
    if write:
        key = supa_service_role_key() or supa_publishable_key()
    else:
        key = supa_publishable_key()
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
        _planner_pool = psycopg2.pool.ThreadedConnectionPool(
            1, 10, dsn=dsn, connect_timeout=_db_connect_timeout()
        )
    return _planner_pool


def planner_get_conn():
    pool = get_planner_pool()
    conn = pool.getconn()
    if getattr(conn, "closed", 0):
        try:
            pool.putconn(conn, close=True)
        except psycopg2.pool.PoolError:
            try:
                conn.close()
            except Exception:
                pass
        conn = pool.getconn()
    return conn


def planner_release_conn(conn):
    if conn is None:
        return
    pool = get_planner_pool()
    try:
        if getattr(conn, "closed", 0):
            return
        pool.putconn(conn)
    except psycopg2.pool.PoolError:
        try:
            conn.close()
        except Exception:
            pass
