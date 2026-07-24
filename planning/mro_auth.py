"""MRO per-user auth: login, register, admin-mediated password reset, admin user mgmt."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from flask import (
    Blueprint,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

from .helpers import one, planner_db, rows
from .mro_route import MRO_PATH
from .utils import compact_text

logger = logging.getLogger(__name__)

mro_auth_bp = Blueprint("mro_auth", __name__)

MRO_SESSION_USER_ID = "mro_user_id"
MRO_SESSION_USERNAME = "mro_username"
MRO_SESSION_LOGIN_AT = "mro_login_at"
MRO_SESSION_MAX_AGE_SEC = 8 * 3600

MRO_AUTH_PUBLIC_PATHS = frozenset(
    {
        "/mro-login",
        "/mro-register",
        "/mro-forgot",
        "/mro-logout",
    }
)
MRO_AUTH_PUBLIC_PREFIXES: tuple[str, ...] = ()

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9._-]{3,64}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MIN_PASSWORD_LEN = 8
_FORGOT_OK_MSG = (
    "Your reset request was submitted. An administrator must approve it "
    "and set a new password before you can sign in again."
)


def ensure_mro_auth_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mro_users (
            user_id         BIGSERIAL    PRIMARY KEY,
            username        TEXT         NOT NULL,
            email           TEXT         NOT NULL,
            password_hash   TEXT         NOT NULL,
            status          TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            approved_at     TIMESTAMPTZ,
            approved_by     TEXT,
            last_login_at   TIMESTAMPTZ
        )
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mro_users_username_lower
            ON public.mro_users (LOWER(username))
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mro_users_email_lower
            ON public.mro_users (LOWER(email))
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mro_users_status
            ON public.mro_users (status, created_at DESC)
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mro_password_reset_requests (
            request_id      BIGSERIAL    PRIMARY KEY,
            user_id         BIGINT       NOT NULL
                REFERENCES public.mro_users(user_id) ON DELETE CASCADE,
            status          TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'rejected')),
            note            TEXT,
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ,
            resolved_by     TEXT
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mro_password_reset_requests_status
            ON public.mro_password_reset_requests (status, created_at DESC)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mro_password_reset_requests_user
            ON public.mro_password_reset_requests (user_id, created_at DESC)
        """
    )


def is_mro_auth_public_path(path: str) -> bool:
    normalized = ((path or "/").lower().rstrip("/")) or "/"
    if normalized in {p.rstrip("/") or "/" for p in MRO_AUTH_PUBLIC_PATHS}:
        return True
    raw = (path or "").lower()
    return any(raw.startswith(prefix) for prefix in MRO_AUTH_PUBLIC_PREFIXES)


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    if not password_hash or not password:
        return False
    try:
        return check_password_hash(password_hash, password)
    except (ValueError, TypeError):
        return False


def clear_mro_session() -> None:
    session.pop(MRO_SESSION_USER_ID, None)
    session.pop(MRO_SESSION_USERNAME, None)
    session.pop(MRO_SESSION_LOGIN_AT, None)


def set_mro_session(user: dict[str, Any]) -> None:
    session[MRO_SESSION_USER_ID] = int(user["user_id"])
    session[MRO_SESSION_USERNAME] = str(user["username"])
    session[MRO_SESSION_LOGIN_AT] = datetime.now(timezone.utc).isoformat()
    session.permanent = True
    session.modified = True


def current_mro_username() -> str:
    return compact_text(session.get(MRO_SESSION_USERNAME)) or ""


def _session_login_fresh() -> bool:
    raw = session.get(MRO_SESSION_LOGIN_AT)
    if not raw:
        return False
    try:
        login_at = datetime.fromisoformat(str(raw))
        if login_at.tzinfo is None:
            login_at = login_at.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - login_at).total_seconds()
        return 0 <= age <= MRO_SESSION_MAX_AGE_SEC
    except (TypeError, ValueError):
        return False


def get_approved_mro_user_from_session() -> dict[str, Any] | None:
    """Return the approved user for the current session, or None (clears stale sessions)."""
    user_id = session.get(MRO_SESSION_USER_ID)
    if not user_id or not _session_login_fresh():
        clear_mro_session()
        return None
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        clear_mro_session()
        return None
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            user = one(
                con.execute(
                    """
                    SELECT user_id, username, email, status
                    FROM public.mro_users
                    WHERE user_id = %s
                    """,
                    (uid,),
                )
            )
    except Exception:
        logger.exception("MRO session user lookup failed")
        clear_mro_session()
        return None
    if not user or compact_text(user.get("status")).lower() != "approved":
        clear_mro_session()
        return None
    session[MRO_SESSION_USERNAME] = str(user["username"])
    return user


def mro_user_authenticated() -> bool:
    return get_approved_mro_user_from_session() is not None


def _normalize_username(raw: str) -> str:
    return compact_text(raw)


def _normalize_email(raw: str) -> str:
    return compact_text(raw).lower()


def _validate_username(username: str) -> str | None:
    if not username:
        return "Username is required."
    if not _USERNAME_RE.match(username):
        return "Username must be 3-64 characters (letters, numbers, . _ -)."
    return None


def _validate_email(email: str) -> str | None:
    if not email:
        return "Email is required."
    if len(email) > 254 or not _EMAIL_RE.match(email):
        return "Enter a valid email address."
    return None


def _validate_password(password: str, *, confirm: str | None = None) -> str | None:
    if not password or len(password) < _MIN_PASSWORD_LEN:
        return f"Password must be at least {_MIN_PASSWORD_LEN} characters."
    if confirm is not None and password != confirm:
        return "Passwords do not match."
    return None


def _user_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": int(row["user_id"]),
        "username": row.get("username"),
        "email": row.get("email"),
        "status": row.get("status"),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "approved_at": _iso(row.get("approved_at")),
        "approved_by": row.get("approved_by"),
        "last_login_at": _iso(row.get("last_login_at")),
    }


def _reset_request_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "request_id": int(row["request_id"]),
        "user_id": int(row["user_id"]),
        "username": row.get("username"),
        "email": row.get("email"),
        "user_status": row.get("user_status"),
        "status": row.get("status"),
        "note": row.get("note"),
        "created_at": _iso(row.get("created_at")),
        "resolved_at": _iso(row.get("resolved_at")),
        "resolved_by": row.get("resolved_by"),
    }


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _complete_pending_resets(con, user_id: int, *, resolved_by: str = "admin") -> None:
    con.execute(
        """
        UPDATE public.mro_password_reset_requests
        SET status = 'completed',
            resolved_at = NOW(),
            resolved_by = %s
        WHERE user_id = %s AND status = 'pending'
        """,
        (resolved_by, user_id),
    )


def _safe_mro_next(raw: str | None) -> str:
    target = (raw or "").strip()
    if not target.startswith("/") or target.startswith("//"):
        return MRO_PATH
    normalized = target.lower().rstrip("/") or "/"
    mro_root = (MRO_PATH or "/MRO").lower().rstrip("/") or "/mro"
    if normalized == mro_root or normalized.startswith(mro_root + "/"):
        return target
    if normalized == "/mro" or normalized.startswith("/mro/"):
        return target
    return MRO_PATH


def _render_auth(
    template: str,
    *,
    error: str | None = None,
    message: str | None = None,
    status: int = 200,
    **ctx: Any,
):
    html = render_template(
        template,
        error=error,
        message=message,
        mro_path=MRO_PATH,
        **ctx,
    )
    return (html, status) if status != 200 else html


# -- Auth pages ---------------------------------------------------------------


@mro_auth_bp.route("/mro-login", methods=["GET", "POST"])
def mro_login():
    next_path = _safe_mro_next(request.values.get("next"))
    if request.method == "GET" and mro_user_authenticated():
        return redirect(next_path)

    error = None
    if request.method == "POST":
        username = _normalize_username(request.form.get("username") or "")
        password = request.form.get("password") or ""
        next_path = _safe_mro_next(request.form.get("next"))
        try:
            with planner_db() as con:
                ensure_mro_auth_tables(con)
                user = one(
                    con.execute(
                        """
                        SELECT user_id, username, email, password_hash, status
                        FROM public.mro_users
                        WHERE LOWER(username) = LOWER(%s)
                        """,
                        (username,),
                    )
                )
            if not user or not verify_password(user.get("password_hash") or "", password):
                error = "Invalid username or password."
            else:
                status = compact_text(user.get("status")).lower()
                if status == "pending":
                    error = "Your account is awaiting admin approval."
                elif status == "rejected":
                    error = "Your account request was rejected. Contact an administrator."
                elif status == "disabled":
                    error = "Your account has been disabled."
                elif status != "approved":
                    error = "Your account cannot sign in."
                else:
                    set_mro_session(user)
                    with planner_db() as con:
                        ensure_mro_auth_tables(con)
                        con.execute(
                            """
                            UPDATE public.mro_users
                            SET last_login_at = NOW(), updated_at = NOW()
                            WHERE user_id = %s
                            """,
                            (int(user["user_id"]),),
                        )
                    return redirect(next_path)
        except Exception as exc:
            logger.exception("MRO login failed")
            error = f"Sign-in failed: {exc}"

    return _render_auth(
        "mro_login.html",
        error=error,
        next_path=next_path,
        status=401 if error else 200,
    )


@mro_auth_bp.route("/mro-register", methods=["GET", "POST"])
def mro_register():
    if request.method == "GET" and mro_user_authenticated():
        return redirect(MRO_PATH)

    error = None
    if request.method == "POST":
        username = _normalize_username(request.form.get("username") or "")
        email = _normalize_email(request.form.get("email") or "")
        password = request.form.get("password") or ""
        confirm = request.form.get("password_confirm") or ""
        error = (
            _validate_username(username)
            or _validate_email(email)
            or _validate_password(password, confirm=confirm)
        )
        if not error:
            try:
                with planner_db() as con:
                    ensure_mro_auth_tables(con)
                    existing = one(
                        con.execute(
                            """
                            SELECT user_id
                            FROM public.mro_users
                            WHERE LOWER(username) = LOWER(%s)
                               OR LOWER(email) = LOWER(%s)
                            LIMIT 1
                            """,
                            (username, email),
                        )
                    )
                    if existing:
                        error = "That username or email is already registered."
                    else:
                        con.execute(
                            """
                            INSERT INTO public.mro_users (
                                username, email, password_hash, status
                            )
                            VALUES (%s, %s, %s, 'pending')
                            """,
                            (username, email, hash_password(password)),
                        )
                if not error:
                    flash(
                        "Account created. An administrator must approve it before you can sign in.",
                        "mro_auth",
                    )
                    return redirect(url_for("mro_auth.mro_login"))
            except Exception as exc:
                logger.exception("MRO register failed")
                error = f"Registration failed: {exc}"

    return _render_auth(
        "mro_register.html",
        error=error,
        username=request.form.get("username") or "",
        email=request.form.get("email") or "",
        status=400 if error else 200,
    )


@mro_auth_bp.post("/mro-logout")
def mro_logout():
    clear_mro_session()
    return redirect(url_for("mro_auth.mro_login"))


@mro_auth_bp.get("/mro-logout")
def mro_logout_get():
    clear_mro_session()
    return redirect(url_for("mro_auth.mro_login"))


@mro_auth_bp.route("/mro-forgot", methods=["GET", "POST"])
def mro_forgot():
    """Submit a password-reset request for admin approval (no email)."""
    message = None
    error = None
    if request.method == "POST":
        username = _normalize_username(request.form.get("username") or "")
        email = _normalize_email(request.form.get("email") or "")
        if not username:
            error = "Username is required."
        else:
            try:
                with planner_db() as con:
                    ensure_mro_auth_tables(con)
                    if email:
                        user = one(
                            con.execute(
                                """
                                SELECT user_id, username, email, status
                                FROM public.mro_users
                                WHERE LOWER(username) = LOWER(%s)
                                  AND LOWER(email) = LOWER(%s)
                                LIMIT 1
                                """,
                                (username, email),
                            )
                        )
                    else:
                        user = one(
                            con.execute(
                                """
                                SELECT user_id, username, email, status
                                FROM public.mro_users
                                WHERE LOWER(username) = LOWER(%s)
                                LIMIT 1
                                """,
                                (username,),
                            )
                        )
                    if user:
                        existing = one(
                            con.execute(
                                """
                                SELECT request_id
                                FROM public.mro_password_reset_requests
                                WHERE user_id = %s AND status = 'pending'
                                LIMIT 1
                                """,
                                (int(user["user_id"]),),
                            )
                        )
                        if not existing:
                            note = f"Requested via /mro-forgot for {user['username']}"
                            if email:
                                note += f" ({email})"
                            con.execute(
                                """
                                INSERT INTO public.mro_password_reset_requests (
                                    user_id, status, note
                                )
                                VALUES (%s, 'pending', %s)
                                """,
                                (int(user["user_id"]), note),
                            )
                # Always show the same success copy (no account enumeration).
                message = _FORGOT_OK_MSG
            except Exception:
                logger.exception("MRO forgot-password request failed")
                message = _FORGOT_OK_MSG

    return _render_auth(
        "mro_forgot.html",
        error=error,
        message=message,
        username=request.form.get("username") or "",
        email=request.form.get("email") or "",
        status=400 if error else 200,
    )


# -- Admin: MRO users ---------------------------------------------------------


@mro_auth_bp.get("/admin/mro-users")
def mro_admin_users_page():
    return render_template(
        "mro_admin_users.html",
        admin_token=(request.args.get("at") or "").strip(),
    )


def _list_mro_users(con, status: str | None = None) -> list[dict[str, Any]]:
    ensure_mro_auth_tables(con)
    if status:
        found = rows(
            con.execute(
                """
                SELECT user_id, username, email, status, created_at, updated_at,
                       approved_at, approved_by, last_login_at
                FROM public.mro_users
                WHERE status = %s
                ORDER BY created_at DESC
                """,
                (status,),
            )
        )
    else:
        found = rows(
            con.execute(
                """
                SELECT user_id, username, email, status, created_at, updated_at,
                       approved_at, approved_by, last_login_at
                FROM public.mro_users
                ORDER BY
                    CASE status
                        WHEN 'pending' THEN 0
                        WHEN 'approved' THEN 1
                        WHEN 'disabled' THEN 2
                        ELSE 3
                    END,
                    created_at DESC
                """
            )
        )
    return [_user_public(r) for r in found]


def _list_reset_requests(con, status: str | None = "pending") -> list[dict[str, Any]]:
    ensure_mro_auth_tables(con)
    if status:
        found = rows(
            con.execute(
                """
                SELECT r.request_id, r.user_id, r.status, r.note,
                       r.created_at, r.resolved_at, r.resolved_by,
                       u.username, u.email, u.status AS user_status
                FROM public.mro_password_reset_requests r
                JOIN public.mro_users u ON u.user_id = r.user_id
                WHERE r.status = %s
                ORDER BY r.created_at DESC
                """,
                (status,),
            )
        )
    else:
        found = rows(
            con.execute(
                """
                SELECT r.request_id, r.user_id, r.status, r.note,
                       r.created_at, r.resolved_at, r.resolved_by,
                       u.username, u.email, u.status AS user_status
                FROM public.mro_password_reset_requests r
                JOIN public.mro_users u ON u.user_id = r.user_id
                ORDER BY
                    CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
                    r.created_at DESC
                LIMIT 200
                """
            )
        )
    return [_reset_request_public(r) for r in found]


@mro_auth_bp.get("/api/admin/mro-users")
def api_admin_list_mro_users():
    status = compact_text(request.args.get("status") or "").lower() or None
    if status and status not in ("pending", "approved", "rejected", "disabled"):
        return jsonify({"error": "Invalid status filter."}), 400
    try:
        with planner_db() as con:
            users = _list_mro_users(con, status=status)
            pending = one(
                con.execute(
                    """
                    SELECT COUNT(*)::int AS c
                    FROM public.mro_users
                    WHERE status = 'pending'
                    """
                )
            )
            reset_pending = one(
                con.execute(
                    """
                    SELECT COUNT(*)::int AS c
                    FROM public.mro_password_reset_requests
                    WHERE status = 'pending'
                    """
                )
            )
            reset_requests = _list_reset_requests(con, status="pending")
        return jsonify(
            {
                "users": users,
                "pending_count": int((pending or {}).get("c") or 0),
                "reset_pending_count": int((reset_pending or {}).get("c") or 0),
                "reset_requests": reset_requests,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.get("/api/admin/mro-users/pending-count")
def api_admin_mro_pending_count():
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            pending = one(
                con.execute(
                    """
                    SELECT COUNT(*)::int AS c
                    FROM public.mro_users
                    WHERE status = 'pending'
                    """
                )
            )
            reset_pending = one(
                con.execute(
                    """
                    SELECT COUNT(*)::int AS c
                    FROM public.mro_password_reset_requests
                    WHERE status = 'pending'
                    """
                )
            )
        return jsonify(
            {
                "pending_count": int((pending or {}).get("c") or 0),
                "reset_pending_count": int((reset_pending or {}).get("c") or 0),
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.get("/api/admin/mro-users/reset-requests")
def api_admin_list_reset_requests():
    status = compact_text(request.args.get("status") or "pending").lower()
    if status == "all":
        status = None
    elif status not in ("pending", "completed", "rejected"):
        return jsonify({"error": "Invalid status filter."}), 400
    try:
        with planner_db() as con:
            return jsonify({"reset_requests": _list_reset_requests(con, status=status)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.post("/api/admin/mro-users/reset-requests/<int:request_id>/reject")
def api_admin_reject_reset_request(request_id: int):
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            row = one(
                con.execute(
                    """
                    UPDATE public.mro_password_reset_requests
                    SET status = 'rejected',
                        resolved_at = NOW(),
                        resolved_by = %s
                    WHERE request_id = %s AND status = 'pending'
                    RETURNING request_id, user_id, status, note,
                              created_at, resolved_at, resolved_by
                    """,
                    ("admin", request_id),
                )
            )
            if not row:
                return jsonify({"error": "Pending reset request not found."}), 404
            user = one(
                con.execute(
                    """
                    SELECT username, email, status AS user_status
                    FROM public.mro_users WHERE user_id = %s
                    """,
                    (int(row["user_id"]),),
                )
            ) or {}
            payload = dict(row)
            payload.update(user)
        return jsonify({"reset_request": _reset_request_public(payload)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.post("/api/admin/mro-users/reset-requests/<int:request_id>/complete")
def api_admin_complete_reset_request(request_id: int):
    """Set a new password for the user and mark the reset request completed."""
    data = request.get_json(silent=True) or {}
    password = data.get("password") or ""
    err = _validate_password(str(password))
    if err:
        return jsonify({"error": err}), 400
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            req = one(
                con.execute(
                    """
                    SELECT request_id, user_id, status
                    FROM public.mro_password_reset_requests
                    WHERE request_id = %s
                    """,
                    (request_id,),
                )
            )
            if not req:
                return jsonify({"error": "Reset request not found."}), 404
            if compact_text(req.get("status")).lower() != "pending":
                return jsonify({"error": "Reset request is not pending."}), 409
            user_id = int(req["user_id"])
            con.execute(
                """
                UPDATE public.mro_users
                SET password_hash = %s, updated_at = NOW()
                WHERE user_id = %s
                """,
                (hash_password(str(password)), user_id),
            )
            _complete_pending_resets(con, user_id, resolved_by="admin")
            user = one(
                con.execute(
                    """
                    SELECT user_id, username, email, status, created_at, updated_at,
                           approved_at, approved_by, last_login_at
                    FROM public.mro_users WHERE user_id = %s
                    """,
                    (user_id,),
                )
            )
        return jsonify({"ok": True, "user": _user_public(user)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.post("/api/admin/mro-users")
def api_admin_create_mro_user():
    data = request.get_json(silent=True) or {}
    username = _normalize_username(data.get("username") or "")
    email = _normalize_email(data.get("email") or "")
    password = data.get("password") or ""
    err = (
        _validate_username(username)
        or _validate_email(email)
        or _validate_password(password)
    )
    if err:
        return jsonify({"error": err}), 400
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            existing = one(
                con.execute(
                    """
                    SELECT user_id
                    FROM public.mro_users
                    WHERE LOWER(username) = LOWER(%s)
                       OR LOWER(email) = LOWER(%s)
                    LIMIT 1
                    """,
                    (username, email),
                )
            )
            if existing:
                return jsonify({"error": "That username or email is already registered."}), 409
            row = one(
                con.execute(
                    """
                    INSERT INTO public.mro_users (
                        username, email, password_hash, status,
                        approved_at, approved_by
                    )
                    VALUES (%s, %s, %s, 'approved', NOW(), %s)
                    RETURNING user_id, username, email, status, created_at,
                              updated_at, approved_at, approved_by, last_login_at
                    """,
                    (username, email, hash_password(password), "admin"),
                )
            )
        return jsonify({"user": _user_public(row)}), 201
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.post("/api/admin/mro-users/<int:user_id>/approve")
def api_admin_approve_mro_user(user_id: int):
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            row = one(
                con.execute(
                    """
                    UPDATE public.mro_users
                    SET status = 'approved',
                        approved_at = NOW(),
                        approved_by = %s,
                        updated_at = NOW()
                    WHERE user_id = %s
                    RETURNING user_id, username, email, status, created_at,
                              updated_at, approved_at, approved_by, last_login_at
                    """,
                    ("admin", user_id),
                )
            )
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.post("/api/admin/mro-users/<int:user_id>/reject")
def api_admin_reject_mro_user(user_id: int):
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            row = one(
                con.execute(
                    """
                    UPDATE public.mro_users
                    SET status = 'rejected', updated_at = NOW()
                    WHERE user_id = %s
                    RETURNING user_id, username, email, status, created_at,
                              updated_at, approved_at, approved_by, last_login_at
                    """,
                    (user_id,),
                )
            )
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.post("/api/admin/mro-users/<int:user_id>/disable")
def api_admin_disable_mro_user(user_id: int):
    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            row = one(
                con.execute(
                    """
                    UPDATE public.mro_users
                    SET status = 'disabled', updated_at = NOW()
                    WHERE user_id = %s
                    RETURNING user_id, username, email, status, created_at,
                              updated_at, approved_at, approved_by, last_login_at
                    """,
                    (user_id,),
                )
            )
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@mro_auth_bp.patch("/api/admin/mro-users/<int:user_id>")
def api_admin_update_mro_user(user_id: int):
    data = request.get_json(silent=True) or {}
    new_username = data.get("username")
    new_password = data.get("password")
    new_email = data.get("email")

    if new_username is None and new_password is None and new_email is None:
        return jsonify({"error": "Provide username, email, and/or password."}), 400

    updates: list[str] = []
    params: list[Any] = []

    if new_username is not None:
        username = _normalize_username(new_username)
        err = _validate_username(username)
        if err:
            return jsonify({"error": err}), 400
        updates.append("username = %s")
        params.append(username)

    if new_email is not None:
        email = _normalize_email(new_email)
        err = _validate_email(email)
        if err:
            return jsonify({"error": err}), 400
        updates.append("email = %s")
        params.append(email)

    if new_password is not None:
        err = _validate_password(str(new_password))
        if err:
            return jsonify({"error": err}), 400
        updates.append("password_hash = %s")
        params.append(hash_password(str(new_password)))

    updates.append("updated_at = NOW()")
    params.append(user_id)

    try:
        with planner_db() as con:
            ensure_mro_auth_tables(con)
            if new_username is not None or new_email is not None:
                clash = one(
                    con.execute(
                        """
                        SELECT user_id
                        FROM public.mro_users
                        WHERE user_id <> %s
                          AND (
                            (%s IS NOT NULL AND LOWER(username) = LOWER(%s))
                            OR (%s IS NOT NULL AND LOWER(email) = LOWER(%s))
                          )
                        LIMIT 1
                        """,
                        (
                            user_id,
                            new_username,
                            _normalize_username(new_username) if new_username is not None else None,
                            new_email,
                            _normalize_email(new_email) if new_email is not None else None,
                        ),
                    )
                )
                if clash:
                    return jsonify({"error": "That username or email is already in use."}), 409
            row = one(
                con.execute(
                    f"""
                    UPDATE public.mro_users
                    SET {", ".join(updates)}
                    WHERE user_id = %s
                    RETURNING user_id, username, email, status, created_at,
                              updated_at, approved_at, approved_by, last_login_at
                    """,
                    tuple(params),
                )
            )
            if new_password is not None:
                _complete_pending_resets(con, user_id, resolved_by="admin")
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
