"""Auk login token refresh, without calling Auk."""

from __future__ import annotations

import json
import time
from base64 import urlsafe_b64encode
from datetime import datetime, timedelta, timezone

from planning import auk_auth
from planning.auk_auth import (
    refresh_auk_token,
    token_is_usable,
    write_env_value,
)


def _jwt(exp: int) -> str:
    header = urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    payload = urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"{header}.{payload}.sig"


def test_write_env_value_replaces_token_only(tmp_path):
    path = tmp_path / ".env"
    path.write_text("AUK_USERNAME=ada\nAUK_PASSWORD=keep-me\nAUK_ACCESS_TOKEN=old\n", encoding="utf-8")
    write_env_value("AUK_ACCESS_TOKEN", "new-token", path)
    text = path.read_text(encoding="utf-8")
    assert "AUK_USERNAME=ada" in text
    assert "AUK_PASSWORD=keep-me" in text
    assert "AUK_ACCESS_TOKEN=new-token" in text
    assert "old" not in text


def test_expired_token_is_not_usable():
    expired = _jwt(int(time.time()) - 60)
    assert token_is_usable(expired) is False


def test_refresh_logs_in_and_stores_token(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("AUK_USERNAME=ada\nAUK_PASSWORD=secret\n", encoding="utf-8")
    monkeypatch.setattr(auk_auth, "_last_success_at", None)
    monkeypatch.setattr(auk_auth, "env_path", lambda: env_file)
    monkeypatch.setattr(auk_auth, "_stamp_path", lambda: tmp_path / "stamp.txt")
    monkeypatch.setenv("AUK_USERNAME", "ada")
    monkeypatch.setenv("AUK_PASSWORD", "secret")
    monkeypatch.delenv("AUK_ACCESS_TOKEN", raising=False)

    fresh = _jwt(int(time.time()) + 7 * 24 * 3600)
    seen = {}

    class _Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"token": fresh, "expires_in": 604800000}

    def _post(url, json=None, headers=None, timeout=None):
        seen["url"] = url
        seen["body"] = json
        return _Response()

    monkeypatch.setattr(auk_auth.requests, "post", _post)
    token = refresh_auk_token(force=True)
    assert token == fresh
    assert seen["url"].endswith("/v2/login")
    assert seen["body"] == {"username": "ada", "password": "secret"}
    assert f"AUK_ACCESS_TOKEN={fresh}" in env_file.read_text(encoding="utf-8")
    assert "AUK_PASSWORD=secret" in env_file.read_text(encoding="utf-8")


def test_recent_refresh_is_skipped(tmp_path, monkeypatch):
    fresh = _jwt(int((datetime.now(timezone.utc) + timedelta(days=6)).timestamp()))
    env_file = tmp_path / ".env"
    env_file.write_text(f"AUK_ACCESS_TOKEN={fresh}\n", encoding="utf-8")
    monkeypatch.setattr(auk_auth, "env_path", lambda: env_file)
    monkeypatch.setattr(auk_auth, "_stamp_path", lambda: tmp_path / "stamp.txt")
    monkeypatch.setattr(auk_auth, "_last_success_at", datetime.now(timezone.utc))
    monkeypatch.setenv("AUK_USERNAME", "ada")
    monkeypatch.setenv("AUK_PASSWORD", "secret")
    monkeypatch.setenv("AUK_ACCESS_TOKEN", fresh)

    def _post(*_args, **_kwargs):
        raise AssertionError("login should be skipped")

    monkeypatch.setattr(auk_auth.requests, "post", _post)
    assert refresh_auk_token(force=True) == fresh
