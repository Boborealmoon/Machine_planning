"""Sign in to Auk and keep AUK_ACCESS_TOKEN fresh.

Auk's dashboard login is POST /v2/login with username and password. The
response token is a JWT (about 7 days). There is no refresh-token grant, so
the planner logs in again on a fixed interval and stores the new token in
.env and in this process.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

log = logging.getLogger(__name__)

_DEFAULT_API_BASE = "https://bff.auk.industries"
_DEFAULT_REFRESH_HOURS = 6
_EXPIRY_MARGIN = timedelta(minutes=30)
_SKIP_IF_REFRESHED_WITHIN = timedelta(hours=5)

_lock = threading.Lock()
_last_success_at: datetime | None = None


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def env_path() -> Path:
    return repo_root() / ".env"


def refresh_hours() -> float:
    raw = (os.getenv("AUK_TOKEN_REFRESH_HOURS") or "").strip()
    if not raw:
        return float(_DEFAULT_REFRESH_HOURS)
    try:
        return max(1.0, float(raw))
    except ValueError:
        return float(_DEFAULT_REFRESH_HOURS)


def credentials_configured() -> bool:
    return bool(_username() and _password())


def _username() -> str:
    return (read_env_value("AUK_USERNAME") or os.getenv("AUK_USERNAME") or "").strip()


def _password() -> str:
    return read_env_value("AUK_PASSWORD") or (os.getenv("AUK_PASSWORD") or "")


def _api_origin() -> str:
    base = (os.getenv("AUK_API_BASE") or _DEFAULT_API_BASE).rstrip("/")
    if base.endswith("/v1") or base.endswith("/v2"):
        base = base.rsplit("/", 1)[0]
    return base


def jwt_expiry(token: str) -> datetime | None:
    """Read the JWT exp claim. Signature is not verified; Auk still checks it."""
    parts = (token or "").split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
    except (ValueError, UnicodeError):
        return None
    exp = data.get("exp") if isinstance(data, dict) else None
    if exp is None:
        return None
    try:
        return datetime.fromtimestamp(int(exp), timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def token_is_usable(token: str, *, margin: timedelta = _EXPIRY_MARGIN) -> bool:
    expiry = jwt_expiry(token)
    if expiry is None:
        return False
    return expiry > datetime.now(timezone.utc) + margin


def read_env_value(key: str, path: Path | None = None) -> str:
    file_path = path or env_path()
    if not file_path.is_file():
        return ""
    try:
        text = file_path.read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    match = re.search(rf"^{re.escape(key)}=(.*)$", text, re.MULTILINE)
    if not match:
        return ""
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def write_env_value(key: str, value: str, path: Path | None = None) -> None:
    file_path = path or env_path()
    line = f"{key}={value}"
    if file_path.is_file():
        text = file_path.read_text(encoding="utf-8-sig")
    else:
        text = ""
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(text):
        text = pattern.sub(line, text, count=1)
    else:
        if text and not text.endswith("\n"):
            text += "\n"
        text += line + "\n"
    file_path.write_text(text, encoding="utf-8")


def current_access_token() -> str:
    """Newest stored token: .env wins when it expires later than the process env."""
    from_env = (os.getenv("AUK_ACCESS_TOKEN") or "").strip()
    from_file = read_env_value("AUK_ACCESS_TOKEN")
    if not from_file:
        return from_env
    if not from_env:
        os.environ["AUK_ACCESS_TOKEN"] = from_file
        return from_file
    file_exp = jwt_expiry(from_file)
    env_exp = jwt_expiry(from_env)
    if file_exp and (env_exp is None or file_exp > env_exp):
        os.environ["AUK_ACCESS_TOKEN"] = from_file
        return from_file
    return from_env


def _stamp_path() -> Path:
    return repo_root() / "cache" / "auk_token_refreshed_at.txt"


def _last_success() -> datetime | None:
    global _last_success_at
    if _last_success_at is not None:
        return _last_success_at
    path = _stamp_path()
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8").strip()
        _last_success_at = datetime.fromisoformat(raw)
    except (OSError, ValueError):
        return None
    return _last_success_at


def _mark_success(when: datetime | None = None) -> None:
    global _last_success_at
    moment = when or datetime.now(timezone.utc)
    _last_success_at = moment
    path = _stamp_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(moment.isoformat(), encoding="utf-8")


def login_for_token(username: str, password: str) -> str:
    url = f"{_api_origin()}/v2/login"
    response = requests.post(
        url,
        json={"username": username, "password": password},
        headers={
            "Content-Type": "application/json",
            "X-Frontend-Url": os.getenv("AUK_FRONTEND_URL")
            or "https://ops.auk.industries/login",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    token = ""
    if isinstance(payload, dict):
        token = str(payload.get("token") or "").strip()
        data = payload.get("data")
        if not token and isinstance(data, dict):
            token = str(data.get("token") or "").strip()
    if not token:
        raise RuntimeError("Auk login succeeded but returned no token")
    return token


def refresh_auk_token(*, force: bool = False) -> str:
    """Log in when the stored token is missing, expired, or due for rotation.

    Returns the token to use. Leaves the previous token in place when login
    is skipped or fails.
    """
    with _lock:
        token = current_access_token()
        usable = token_is_usable(token)
        last = _last_success()
        recently = (
            last is not None
            and datetime.now(timezone.utc) - last < _SKIP_IF_REFRESHED_WITHIN
        )
        if usable and recently:
            return token
        if usable and not force:
            return token
        if not credentials_configured():
            if not usable:
                log.warning(
                    "Auk token is missing or expired. Set AUK_USERNAME and "
                    "AUK_PASSWORD in .env to refresh it automatically."
                )
            return token

        try:
            fresh = login_for_token(_username(), _password())
        except requests.RequestException as exc:
            status = exc.response.status_code if exc.response is not None else None
            log.warning("Auk login failed (status=%s)", status)
            return token
        except (ValueError, RuntimeError) as exc:
            log.warning("Auk login failed: %s", exc)
            return token

        os.environ["AUK_ACCESS_TOKEN"] = fresh
        try:
            write_env_value("AUK_ACCESS_TOKEN", fresh)
        except OSError as exc:
            log.warning("Auk token refreshed in memory but .env was not updated: %s", exc)
        _mark_success()
        expiry = jwt_expiry(fresh)
        log.info(
            "Auk access token refreshed%s",
            f", expires {expiry.isoformat()}" if expiry else "",
        )
        return fresh


def refresh_loop(stop_event: threading.Event | None = None) -> None:
    """Refresh if the token is already dead, then every AUK_TOKEN_REFRESH_HOURS."""
    refresh_auk_token(force=False)
    interval = refresh_hours() * 3600
    while stop_event is None or not stop_event.is_set():
        if stop_event is not None:
            if stop_event.wait(interval):
                return
        else:
            time.sleep(interval)
        refresh_auk_token(force=True)
