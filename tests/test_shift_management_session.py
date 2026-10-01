"""Shift Management login stays in the browser session across tab changes."""

from contextlib import contextmanager

from flask import Flask

from planning.shift_management_auth import (
    SHIFT_MGMT_SESSION_LOGIN_AT,
    SHIFT_MGMT_SESSION_ROLE,
    SHIFT_MGMT_SESSION_USER_ID,
    SHIFT_MGMT_SESSION_USERNAME,
    get_approved_shift_mgmt_user_from_session,
    set_shift_mgmt_session,
)


def _app():
    app = Flask(__name__)
    app.secret_key = "shift-session-test"
    return app


def _user():
    return {
        "user_id": 7,
        "username": "sup1",
        "display_name": "Supervisor",
        "role": "supervisor",
        "default_shift": "Day",
        "status": "approved",
    }


@contextmanager
def _db_returning(user):
    class _Con:
        def execute(self, sql, params=None):
            return None

    yield _Con()


def test_repeat_lookup_keeps_the_same_session(monkeypatch):
    monkeypatch.setattr(
        "planning.shift_management_auth.planner_db",
        lambda: _db_returning(_user()),
    )
    monkeypatch.setattr("planning.shift_management_auth.one", lambda _cur: _user())
    monkeypatch.setattr(
        "planning.shift_management_auth.ensure_shift_mgmt_auth_tables",
        lambda _con: None,
    )

    app = _app()
    with app.test_request_context():
        set_shift_mgmt_session(_user())
        from flask import session

        session.modified = False
        first = get_approved_shift_mgmt_user_from_session()
        second = get_approved_shift_mgmt_user_from_session()
        assert first["username"] == "sup1"
        assert second is first
        assert session.get(SHIFT_MGMT_SESSION_USER_ID) == 7
        assert session.modified is False


def test_database_blip_does_not_sign_the_user_out(monkeypatch):
    @contextmanager
    def _down():
        raise RuntimeError("connection pool exhausted")
        yield

    monkeypatch.setattr("planning.shift_management_auth.planner_db", _down)

    app = _app()
    with app.test_request_context():
        set_shift_mgmt_session(_user())
        from flask import session

        found = get_approved_shift_mgmt_user_from_session()
        assert found is None
        assert session.get(SHIFT_MGMT_SESSION_USER_ID) == 7
        assert session.get(SHIFT_MGMT_SESSION_USERNAME) == "sup1"
        assert session.get(SHIFT_MGMT_SESSION_ROLE) == "supervisor"
        assert session.get(SHIFT_MGMT_SESSION_LOGIN_AT)


def test_expired_login_is_cleared(monkeypatch):
    app = _app()
    with app.test_request_context():
        from flask import session

        session[SHIFT_MGMT_SESSION_USER_ID] = 7
        session[SHIFT_MGMT_SESSION_LOGIN_AT] = "2000-01-01T00:00:00+00:00"
        found = get_approved_shift_mgmt_user_from_session()
        assert found is None
        assert session.get(SHIFT_MGMT_SESSION_USER_ID) is None
