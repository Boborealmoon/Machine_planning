import logging
import os
import time
from urllib.parse import urlsplit, urlunsplit

import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv

load_dotenv(encoding="utf-8-sig")

_log = logging.getLogger(__name__)

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


# ── Supabase PostgreSQL (planner module) ───────────────────────────────────
# Set SUPA_DB_URL to the transaction-mode pooler (port 6543), e.g.:
#   SUPA_DB_URL=postgresql://postgres.[ref]:[pw]@aws-0-[region].pooler.supabase.com:6543/postgres
# Session mode (port 5432) is capped at pool_size (often 15) and fails with EMAXCONNSESSION.

_planner_pool = None

# Leave headroom on session-mode poolers for ERP sync and other clients.
_SESSION_POOLER_CLIENT_CAP = 10


def _planner_pool_wait_sec() -> float:
    return max(0.0, float(os.getenv("PLANNER_POOL_WAIT_SEC", "3")))


def _use_transaction_pooler() -> bool:
    raw = (os.getenv("SUPA_DB_USE_SESSION_MODE") or "").strip().lower()
    return raw not in {"1", "true", "yes"}


def dsn_is_session_pooler(dsn: str) -> bool:
    """True when DSN points at Supabase pooler session mode (port 5432)."""
    parts = urlsplit((dsn or "").strip())
    host = (parts.hostname or "").lower()
    if "pooler.supabase.com" not in host:
        return False
    port = parts.port or 5432
    return int(port) == 5432


def normalize_planner_dsn(dsn: str, *, use_transaction_pooler: bool = True) -> str:
    """Rewrite Supabase session-mode pooler URLs (port 5432) to transaction mode (6543).

    Session mode holds a backend for the life of each client socket, so a local
    pool of 8–16 plus ERP sync overflows pool_size (often 15). Transaction mode
    multiplexes those clients. Direct db.*.supabase.co URLs are left unchanged.
    """
    raw = (dsn or "").strip()
    if not raw or not use_transaction_pooler or not dsn_is_session_pooler(raw):
        return raw
    parts = urlsplit(raw)
    netloc = parts.netloc
    userinfo = ""
    hostport = netloc
    if "@" in netloc:
        userinfo, hostport = netloc.rsplit("@", 1)
    host = hostport.rsplit(":", 1)[0] if ":" in hostport else hostport
    new_hostport = f"{host}:6543"
    new_netloc = f"{userinfo}@{new_hostport}" if userinfo else new_hostport
    return urlunsplit((parts.scheme, new_netloc, parts.path, parts.query, parts.fragment))


def planner_dsn() -> str:
    dsn = (os.getenv("SUPA_DB_URL") or "").strip()
    if not dsn:
        raise RuntimeError(
            "SUPA_DB_URL env var is not set. "
            "Add the transaction-mode pooler URL to .env: "
            "postgresql://postgres.[ref]:[pw]@aws-0-[region].pooler.supabase.com:6543/postgres"
        )
    return normalize_planner_dsn(dsn, use_transaction_pooler=_use_transaction_pooler())


def get_planner_pool():
    global _planner_pool
    if _planner_pool is None:
        dsn = planner_dsn()
        minconn = max(1, int(os.getenv("PLANNER_POOL_MIN", "2")))
        # Must exceed Waitress workers + background threads; MPP autosave/recalc holds
        # connections while nav polls and other tabs also check out.
        threads = max(1, int(os.getenv("WAITRESS_THREADS", "12")))
        default_max = max(16, threads + 4)
        maxconn = max(minconn, int(os.getenv("PLANNER_POOL_MAX", str(default_max))))
        if dsn_is_session_pooler(dsn) and maxconn > _SESSION_POOLER_CLIENT_CAP:
            _log.warning(
                "Capping PLANNER_POOL_MAX from %s to %s — session-mode pooler "
                "only allows pool_size clients (often 15). Switch SUPA_DB_URL to port 6543.",
                maxconn,
                _SESSION_POOLER_CLIENT_CAP,
            )
            maxconn = max(minconn, _SESSION_POOLER_CLIENT_CAP)
        if maxconn < threads:
            _log.warning(
                "PLANNER_POOL_MAX=%s is below WAITRESS_THREADS=%s — "
                "MPP planner saves and page polls will hit 'connection pool exhausted'. "
                "Set PLANNER_POOL_MAX to at least %s.",
                maxconn,
                threads,
                threads + 4,
            )
        parts = urlsplit(dsn)
        _log.info(
            "Planner DB pool min=%s max=%s host=%s port=%s",
            minconn,
            maxconn,
            parts.hostname or "",
            parts.port,
        )
        _planner_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn, maxconn, dsn=dsn, connect_timeout=_db_connect_timeout()
        )
    return _planner_pool


def planner_db_connect_error(exc: Exception) -> str | None:
    """User-facing message for planner Postgres connectivity failures."""
    msg = str(exc).lower()
    if "could not translate host name" in msg or "name or service not known" in msg:
        return (
            "Planner database is unreachable (could not resolve Supabase host). "
            "Check internet/VPN, then verify SUPA_DB_URL in .env."
        )
    if "emaxconnsession" in msg or "max clients reached" in msg:
        return (
            "Planner database is busy (Supabase connection limit reached). "
            "Wait a moment and refresh. If it keeps happening, use the "
            "transaction-mode pooler (port 6543) in SUPA_DB_URL and restart the app."
        )
    if any(
        token in msg
        for token in (
            "connection refused",
            "timeout expired",
            "could not connect to server",
            "server closed the connection unexpectedly",
        )
    ):
        return (
            "Planner database is unreachable. Check network/VPN and SUPA_DB_URL in .env."
        )
    if "connection pool exhausted" in msg:
        return (
            "Database connection pool is full — often during MPP queue save/recalc or "
            "multiple open tabs. Wait a moment and refresh once; if it keeps happening, "
            "raise PLANNER_POOL_MAX above WAITRESS_THREADS and restart the app."
        )
    return None


def planner_configure_connection(conn) -> None:
    """Interpret naive timestamps as Singapore wall clock for this transaction."""
    with conn.cursor() as cur:
        # SET LOCAL survives transaction-mode pooling; session SET does not.
        cur.execute("SET LOCAL TIME ZONE 'Asia/Singapore'")


def _checkout_planner_conn(pool):
    """Take one connection from the pool, discarding already-closed sockets."""
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


def planner_get_conn():
    """Checkout a planner connection, waiting briefly if the pool is busy."""
    wait_deadline = time.monotonic() + _planner_pool_wait_sec()
    while True:
        pool = get_planner_pool()
        try:
            conn = _checkout_planner_conn(pool)
        except psycopg2.pool.PoolError as exc:
            if time.monotonic() >= wait_deadline:
                raise RuntimeError("connection pool exhausted") from exc
            time.sleep(0.05)
            continue
        except psycopg2.OperationalError:
            # Creating a new TCP connection failed (often remote pooler limit).
            # Do NOT closeall() — that strands connections checked out by other threads.
            if time.monotonic() >= wait_deadline:
                raise
            time.sleep(0.1)
            continue

        try:
            planner_configure_connection(conn)
        except Exception:
            # Never leave a checked-out connection stranded on configure failure.
            try:
                pool.putconn(conn, close=True)
            except Exception:
                planner_release_conn(conn)
            raise
        return conn


def planner_release_conn(conn):
    if conn is None:
        return
    try:
        pool = get_planner_pool()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
        return
    if getattr(pool, "closed", False):
        try:
            conn.close()
        except Exception:
            pass
        return
    try:
        # Closed sockets must still be returned with close=True or the pool slot leaks.
        if getattr(conn, "closed", 0):
            pool.putconn(conn, close=True)
        else:
            pool.putconn(conn)
    except psycopg2.pool.PoolError:
        try:
            conn.close()
        except Exception:
            pass
