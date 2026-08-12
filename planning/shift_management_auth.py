"""Shift Management per-operator auth: login, register, session gate."""
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
from .utils import compact_text

logger = logging.getLogger(__name__)

shift_mgmt_auth_bp = Blueprint("shift_mgmt_auth", __name__)

SHIFT_MGMT_SESSION_USER_ID = "shift_mgmt_user_id"
SHIFT_MGMT_SESSION_USERNAME = "shift_mgmt_username"
SHIFT_MGMT_SESSION_DISPLAY = "shift_mgmt_display_name"
SHIFT_MGMT_SESSION_ROLE = "shift_mgmt_role"
SHIFT_MGMT_SESSION_LOGIN_AT = "shift_mgmt_login_at"
SHIFT_MGMT_SESSION_MAX_AGE_SEC = 12 * 3600

SHIFT_MGMT_LOGIN_PATH = "/shift-management-login"
SHIFT_MGMT_AUTH_PUBLIC_PATHS = frozenset(
    {
        "/shift-management-login",
        "/shift-management-register",
        "/shift-management-logout",
    }
)

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9._-]{2,64}$")
_MIN_PASSWORD_LEN = 4  # PIN-friendly for shop floor


def ensure_shift_mgmt_auth_tables(con) -> None:
    """Create auth tables if missing (idempotent)."""
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.shift_mgmt_users (
            user_id         BIGSERIAL    PRIMARY KEY,
            username        TEXT         NOT NULL,
            display_name    TEXT         NOT NULL DEFAULT '',
            password_hash   TEXT         NOT NULL,
            role            TEXT         NOT NULL DEFAULT 'operator'
                CHECK (role IN ('operator', 'supervisor', 'quality', 'admin')),
            default_shift   TEXT
                CHECK (default_shift IS NULL OR default_shift IN ('Day', 'Night')),
            status          TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'disabled')),
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            approved_at     TIMESTAMPTZ,
            last_login_at   TIMESTAMPTZ
        )
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_mgmt_users_username_lower
            ON public.shift_mgmt_users (LOWER(username))
        """
    )


def seed_demo_users_if_empty(con) -> None:
    """Seed op1 / op2 / sup1 (PIN 1234) when no approved users exist."""
    row = one(
        con.execute(
            """
            SELECT COUNT(*)::int AS n
            FROM public.shift_mgmt_users
            WHERE status = 'approved'
            """
        )
    )
    if row and int(row.get("n") or 0) > 0:
        return
    pin_hash = generate_password_hash("1234")
    for username, display, role, shift in (
        ("op1", "Operator One", "operator", "Day"),
        ("op2", "Operator Two", "operator", "Night"),
        ("sup1", "Supervisor", "supervisor", "Day"),
    ):
        existing = one(
            con.execute(
                """
                SELECT user_id FROM public.shift_mgmt_users
                WHERE LOWER(username) = LOWER(%s)
                """,
                (username,),
            )
        )
        if existing:
            continue
        con.execute(
            """
            INSERT INTO public.shift_mgmt_users
                (username, display_name, password_hash, role, default_shift, status, approved_at)
            VALUES (%s, %s, %s, %s, %s, 'approved', NOW())
            """,
            (username, display, pin_hash, role, shift),
        )


def is_shift_mgmt_auth_public_path(path: str) -> bool:
    normalized = ((path or "/").lower().rstrip("/")) or "/"
    return normalized in {p.rstrip("/").lower() or "/" for p in SHIFT_MGMT_AUTH_PUBLIC_PATHS}


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    if not password_hash or password is None:
        return False
    try:
        return check_password_hash(password_hash, password)
    except Exception:
        return False


def clear_shift_mgmt_session() -> None:
    session.pop(SHIFT_MGMT_SESSION_USER_ID, None)
    session.pop(SHIFT_MGMT_SESSION_USERNAME, None)
    session.pop(SHIFT_MGMT_SESSION_DISPLAY, None)
    session.pop(SHIFT_MGMT_SESSION_ROLE, None)
    session.pop(SHIFT_MGMT_SESSION_LOGIN_AT, None)


def set_shift_mgmt_session(user: dict[str, Any]) -> None:
    session[SHIFT_MGMT_SESSION_USER_ID] = int(user["user_id"])
    session[SHIFT_MGMT_SESSION_USERNAME] = str(user["username"])
    session[SHIFT_MGMT_SESSION_DISPLAY] = compact_text(user.get("display_name")) or str(
        user["username"]
    )
    session[SHIFT_MGMT_SESSION_ROLE] = compact_text(user.get("role")) or "operator"
    session[SHIFT_MGMT_SESSION_LOGIN_AT] = datetime.now(timezone.utc).isoformat()
    session.permanent = True
    session.modified = True


def _session_login_fresh() -> bool:
    raw = session.get(SHIFT_MGMT_SESSION_LOGIN_AT)
    if not raw:
        return False
    try:
        login_at = datetime.fromisoformat(str(raw))
        if login_at.tzinfo is None:
            login_at = login_at.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - login_at).total_seconds()
        return age <= SHIFT_MGMT_SESSION_MAX_AGE_SEC
    except Exception:
        return False


def get_approved_shift_mgmt_user_from_session() -> dict[str, Any] | None:
    user_id = session.get(SHIFT_MGMT_SESSION_USER_ID)
    if not user_id or not _session_login_fresh():
        clear_shift_mgmt_session()
        return None
    try:
        with planner_db() as con:
            ensure_shift_mgmt_auth_tables(con)
            user = one(
                con.execute(
                    """
                    SELECT user_id, username, display_name, role, default_shift, status
                    FROM public.shift_mgmt_users
                    WHERE user_id = %s
                    """,
                    (int(user_id),),
                )
            )
    except Exception:
        logger.exception("Shift Management session user lookup failed")
        clear_shift_mgmt_session()
        return None
    if not user or compact_text(user.get("status")).lower() != "approved":
        clear_shift_mgmt_session()
        return None
    session[SHIFT_MGMT_SESSION_USERNAME] = str(user["username"])
    session[SHIFT_MGMT_SESSION_DISPLAY] = compact_text(user.get("display_name")) or str(
        user["username"]
    )
    session[SHIFT_MGMT_SESSION_ROLE] = compact_text(user.get("role")) or "operator"
    return user


def shift_mgmt_user_authenticated() -> bool:
    return get_approved_shift_mgmt_user_from_session() is not None


def current_shift_mgmt_user() -> dict[str, Any] | None:
    return get_approved_shift_mgmt_user_from_session()


def _normalize_username(raw: str) -> str:
    return compact_text(raw)


def _validate_username(username: str) -> str | None:
    if not username or not _USERNAME_RE.match(username):
        return "Username must be 2-64 characters (letters, numbers, . _ -)."
    return None


def _validate_password(password: str, confirm: str | None = None) -> str | None:
    if len(password or "") < _MIN_PASSWORD_LEN:
        return f"Password/PIN must be at least {_MIN_PASSWORD_LEN} characters."
    if confirm is not None and password != confirm:
        return "Password confirmation does not match."
    return None


def _safe_next(raw: str, default: str) -> str:
    target = (raw or "").strip()
    if not target.startswith("/") or target.startswith("//"):
        return default
    lower = target.lower()
    if lower.startswith("/shift-management"):
        return target
    return default


def _app_home() -> str:
    from .shift_management_route import SHIFT_MGMT_PATH

    return SHIFT_MGMT_PATH


@shift_mgmt_auth_bp.route(SHIFT_MGMT_LOGIN_PATH, methods=["GET", "POST"])
def shift_mgmt_login():
    home = _app_home()
    next_path = _safe_next(request.values.get("next"), home)
    if request.method == "GET" and shift_mgmt_user_authenticated():
        return redirect(next_path)

    error = None
    if request.method == "POST":
        username = _normalize_username(request.form.get("username") or "")
        password = request.form.get("password") or ""
        next_path = _safe_next(request.form.get("next"), home)
        try:
            with planner_db() as con:
                ensure_shift_mgmt_auth_tables(con)
                seed_demo_users_if_empty(con)
                user = one(
                    con.execute(
                        """
                        SELECT user_id, username, display_name, password_hash, role, status
                        FROM public.shift_mgmt_users
                        WHERE LOWER(username) = LOWER(%s)
                        """,
                        (username,),
                    )
                )
            if not user or not verify_password(user.get("password_hash") or "", password):
                error = "Invalid username or password/PIN."
            else:
                status = compact_text(user.get("status")).lower()
                if status == "pending":
                    error = "Your account is awaiting approval."
                elif status == "disabled":
                    error = "Your account has been disabled."
                elif status != "approved":
                    error = "Your account cannot sign in."
                else:
                    set_shift_mgmt_session(user)
                    with planner_db() as con:
                        con.execute(
                            """
                            UPDATE public.shift_mgmt_users
                            SET last_login_at = NOW(), updated_at = NOW()
                            WHERE user_id = %s
                            """,
                            (int(user["user_id"]),),
                        )
                    return redirect(next_path)
        except Exception as exc:
            logger.exception("Shift Management login failed")
            error = f"Sign-in failed: {exc}"

    return (
        render_template(
            "shift_management_login.html",
            error=error,
            next_path=next_path,
            app_path=home,
        ),
        (401 if error else 200),
    )


@shift_mgmt_auth_bp.route("/shift-management-register", methods=["GET", "POST"])
def shift_mgmt_register():
    home = _app_home()
    if request.method == "GET" and shift_mgmt_user_authenticated():
        return redirect(home)

    error = None
    if request.method == "POST":
        username = _normalize_username(request.form.get("username") or "")
        display_name = compact_text(request.form.get("display_name") or "") or username
        password = request.form.get("password") or ""
        confirm = request.form.get("password_confirm") or ""
        error = _validate_username(username) or _validate_password(password, confirm=confirm)
        if not error:
            try:
                with planner_db() as con:
                    ensure_shift_mgmt_auth_tables(con)
                    existing = one(
                        con.execute(
                            """
                            SELECT user_id FROM public.shift_mgmt_users
                            WHERE LOWER(username) = LOWER(%s)
                            LIMIT 1
                            """,
                            (username,),
                        )
                    )
                    if existing:
                        error = "That username is already taken."
                    else:
                        con.execute(
                            """
                            INSERT INTO public.shift_mgmt_users
                                (username, display_name, password_hash, role, status)
                            VALUES (%s, %s, %s, 'operator', 'pending')
                            """,
                            (username, display_name, hash_password(password)),
                        )
                if not error:
                    flash(
                        "Account created. An admin must approve it before you can sign in.",
                        "shift_mgmt_auth",
                    )
                    return redirect(url_for("shift_mgmt_auth.shift_mgmt_login"))
            except Exception as exc:
                logger.exception("Shift Management register failed")
                error = f"Registration failed: {exc}"

    return render_template(
        "shift_management_register.html",
        error=error,
        app_path=home,
    )


@shift_mgmt_auth_bp.post("/shift-management-logout")
def shift_mgmt_logout_post():
    clear_shift_mgmt_session()
    return redirect(url_for("shift_mgmt_auth.shift_mgmt_login"))


@shift_mgmt_auth_bp.get("/shift-management-logout")
def shift_mgmt_logout_get():
    clear_shift_mgmt_session()
    return redirect(url_for("shift_mgmt_auth.shift_mgmt_login"))


def _user_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": int(row["user_id"]),
        "username": row.get("username"),
        "display_name": row.get("display_name") or "",
        "role": row.get("role") or "operator",
        "default_shift": row.get("default_shift"),
        "status": row.get("status"),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "approved_at": row["approved_at"].isoformat() if row.get("approved_at") else None,
        "last_login_at": row["last_login_at"].isoformat() if row.get("last_login_at") else None,
    }


def _list_shift_mgmt_users(con, status: str | None = None) -> list[dict[str, Any]]:
    ensure_shift_mgmt_auth_tables(con)
    if status:
        found = rows(
            con.execute(
                """
                SELECT user_id, username, display_name, role, default_shift, status,
                       created_at, updated_at, approved_at, last_login_at
                FROM public.shift_mgmt_users
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
                SELECT user_id, username, display_name, role, default_shift, status,
                       created_at, updated_at, approved_at, last_login_at
                FROM public.shift_mgmt_users
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


@shift_mgmt_auth_bp.get("/admin/shift-management-users")
def shift_mgmt_admin_users_page():
    return render_template(
        "shift_management_admin_users.html",
        admin_token=(request.args.get("at") or "").strip(),
    )


@shift_mgmt_auth_bp.get("/api/admin/shift-management-users")
def api_admin_list_shift_mgmt_users():
    status = compact_text(request.args.get("status") or "").lower() or None
    if status and status not in ("pending", "approved", "disabled"):
        return jsonify({"error": "Invalid status filter."}), 400
    try:
        with planner_db() as con:
            users = _list_shift_mgmt_users(con, status=status)
            pending = one(
                con.execute(
                    """
                    SELECT COUNT(*)::int AS c
                    FROM public.shift_mgmt_users
                    WHERE status = 'pending'
                    """
                )
            )
        return jsonify({"users": users, "pending_count": int((pending or {}).get("c") or 0)})
    except Exception as exc:
        logger.exception("list shift mgmt users failed")
        return jsonify({"error": str(exc)}), 500


@shift_mgmt_auth_bp.post("/api/admin/shift-management-users")
def api_admin_create_shift_mgmt_user():
    data = request.get_json(silent=True) or {}
    username = _normalize_username(data.get("username") or "")
    display_name = compact_text(data.get("display_name") or "") or username
    password = data.get("password") or ""
    role = compact_text(data.get("role") or "operator").lower() or "operator"
    default_shift = compact_text(data.get("default_shift") or "") or None
    err = _validate_username(username) or _validate_password(password)
    if err:
        return jsonify({"error": err}), 400
    if role not in ("operator", "supervisor", "quality", "admin"):
        return jsonify({"error": "Invalid role."}), 400
    if default_shift:
        if default_shift in ("A", "B", "C"):
            default_shift = {"A": "Day", "B": "Night", "C": "Night"}[default_shift]
        if default_shift not in ("Day", "Night"):
            return jsonify({"error": "Invalid default_shift."}), 400
    try:
        with planner_db() as con:
            ensure_shift_mgmt_auth_tables(con)
            existing = one(
                con.execute(
                    """
                    SELECT user_id FROM public.shift_mgmt_users
                    WHERE LOWER(username) = LOWER(%s)
                    LIMIT 1
                    """,
                    (username,),
                )
            )
            if existing:
                return jsonify({"error": "Username already taken."}), 409
            row = one(
                con.execute(
                    """
                    INSERT INTO public.shift_mgmt_users
                        (username, display_name, password_hash, role, default_shift, status, approved_at)
                    VALUES (%s, %s, %s, %s, %s, 'approved', NOW())
                    RETURNING user_id, username, display_name, role, default_shift, status,
                              created_at, updated_at, approved_at, last_login_at
                    """,
                    (username, display_name, hash_password(password), role, default_shift),
                )
            )
        return jsonify({"user": _user_public(row)}), 201
    except Exception as exc:
        logger.exception("create shift mgmt user failed")
        return jsonify({"error": str(exc)}), 500


@shift_mgmt_auth_bp.post("/api/admin/shift-management-users/<int:user_id>/approve")
def api_admin_approve_shift_mgmt_user(user_id: int):
    try:
        with planner_db() as con:
            ensure_shift_mgmt_auth_tables(con)
            row = one(
                con.execute(
                    """
                    UPDATE public.shift_mgmt_users
                    SET status = 'approved', approved_at = NOW(), updated_at = NOW()
                    WHERE user_id = %s
                    RETURNING user_id, username, display_name, role, default_shift, status,
                              created_at, updated_at, approved_at, last_login_at
                    """,
                    (user_id,),
                )
            )
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@shift_mgmt_auth_bp.post("/api/admin/shift-management-users/<int:user_id>/disable")
def api_admin_disable_shift_mgmt_user(user_id: int):
    try:
        with planner_db() as con:
            ensure_shift_mgmt_auth_tables(con)
            row = one(
                con.execute(
                    """
                    UPDATE public.shift_mgmt_users
                    SET status = 'disabled', updated_at = NOW()
                    WHERE user_id = %s
                    RETURNING user_id, username, display_name, role, default_shift, status,
                              created_at, updated_at, approved_at, last_login_at
                    """,
                    (user_id,),
                )
            )
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@shift_mgmt_auth_bp.patch("/api/admin/shift-management-users/<int:user_id>")
def api_admin_patch_shift_mgmt_user(user_id: int):
    data = request.get_json(silent=True) or {}
    display_name = data.get("display_name")
    role = data.get("role")
    default_shift = data.get("default_shift")
    password = data.get("password")
    try:
        with planner_db() as con:
            ensure_shift_mgmt_auth_tables(con)
            existing = one(
                con.execute(
                    "SELECT user_id FROM public.shift_mgmt_users WHERE user_id = %s",
                    (user_id,),
                )
            )
            if not existing:
                return jsonify({"error": "User not found."}), 404
            updates = []
            params: list[Any] = []
            if display_name is not None:
                updates.append("display_name = %s")
                params.append(compact_text(display_name))
            if role is not None:
                role_text = compact_text(role).lower()
                if role_text not in ("operator", "supervisor", "quality", "admin"):
                    return jsonify({"error": "Invalid role."}), 400
                updates.append("role = %s")
                params.append(role_text)
            if default_shift is not None:
                ds = compact_text(default_shift) or None
                if ds:
                    if ds in ("A", "B", "C"):
                        ds = {"A": "Day", "B": "Night", "C": "Night"}[ds]
                    if ds not in ("Day", "Night"):
                        return jsonify({"error": "Invalid default_shift."}), 400
                updates.append("default_shift = %s")
                params.append(ds)
            if password:
                err = _validate_password(password)
                if err:
                    return jsonify({"error": err}), 400
                updates.append("password_hash = %s")
                params.append(hash_password(password))
            if not updates:
                return jsonify({"error": "No changes."}), 400
            updates.append("updated_at = NOW()")
            params.append(user_id)
            row = one(
                con.execute(
                    f"""
                    UPDATE public.shift_mgmt_users
                    SET {", ".join(updates)}
                    WHERE user_id = %s
                    RETURNING user_id, username, display_name, role, default_shift, status,
                              created_at, updated_at, approved_at, last_login_at
                    """,
                    tuple(params),
                )
            )
        return jsonify({"user": _user_public(row)})
    except Exception as exc:
        logger.exception("patch shift mgmt user failed")
        return jsonify({"error": str(exc)}), 500
