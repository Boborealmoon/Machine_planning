"""Temp reject PS delete must drop planner_temp_process_sheet before the planner row."""

from __future__ import annotations

import pytest

from planning.process_sheets import (
    canonical_temp_planner_ps_id,
    delete_temp_process_sheet,
    is_temp_planner_ps_id,
)


class _FakeCursor:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _FakeCon:
    def __init__(self, *, ps_exists=True, temp_exists=True, operations=None, blocks=None):
        self.statements = []
        self.ps_exists = ps_exists
        self.temp_exists = temp_exists
        self.temp_deleted = False
        self.operations = list(operations or [])
        self.blocks = list(blocks or [])

    def execute(self, sql, params=None):
        text = " ".join(str(sql).split())
        self.statements.append((text, params))
        lowered = text.lower()
        if lowered.startswith("savepoint ") or lowered.startswith("release savepoint ") or lowered.startswith("rollback to savepoint "):
            return _FakeCursor([])
        if "from planner_process_sheet" in lowered and lowered.strip().startswith("select"):
            row = {"planner_ps_id": params[0]} if self.ps_exists else None
            return _FakeCursor([row] if row else [])
        if "from planner_temp_process_sheet" in lowered and lowered.strip().startswith("select"):
            row = {"planner_ps_id": params[0]} if self.temp_exists and not self.temp_deleted else None
            return _FakeCursor([row] if row else [])
        if "from planner_operation" in lowered:
            return _FakeCursor(self.operations)
        if "from planner_run_block" in lowered and lowered.strip().startswith("select"):
            return _FakeCursor(self.blocks)
        if lowered.startswith("delete from planner_temp_process_sheet"):
            self.temp_deleted = True
            self.temp_exists = False
            return _FakeCursor([])
        if lowered.startswith("delete from planner_process_sheet"):
            if self.temp_exists and not self.temp_deleted:
                raise RuntimeError(
                    'update or delete on table "planner_process_sheet" violates foreign key constraint '
                    '"planner_temp_process_sheet_planner_ps_id_fkey"'
                )
            self.ps_exists = False
            return _FakeCursor([])
        return _FakeCursor([])


def _deleted_tables(con):
    out = []
    for sql, _params in con.statements:
        lowered = sql.lower()
        if lowered.startswith("delete from "):
            out.append(lowered.split()[2])
    return out


def test_canonical_temp_planner_ps_id_strips_display_space_and_url_encoding():
    assert canonical_temp_planner_ps_id("[Temp]NPS26-0321-15") == "[Temp]NPS26-0321-15"
    assert canonical_temp_planner_ps_id("[Temp] NPS26-0321-15") == "[Temp]NPS26-0321-15"
    assert canonical_temp_planner_ps_id("%5BTemp%5DNPS26-0321-15") == "[Temp]NPS26-0321-15"
    assert is_temp_planner_ps_id("[temp]NPS26-0321-15")


def test_delete_temp_process_sheet_rejects_non_temp_ids():
    with pytest.raises(ValueError, match="Only \\[Temp\\]"):
        delete_temp_process_sheet(_FakeCon(), "NPS26-0321")


def test_delete_temp_process_sheet_drops_registry_before_planner_row():
    con = _FakeCon()
    result = delete_temp_process_sheet(con, "[Temp] NPS26-0321-15")
    assert result["deleted"] is True
    assert result["planner_ps_id"] == "[Temp]NPS26-0321-15"
    tables = _deleted_tables(con)
    assert "planner_temp_process_sheet" in tables
    assert "planner_process_sheet" in tables
    assert tables.index("planner_temp_process_sheet") < tables.index("planner_process_sheet")


def test_delete_temp_process_sheet_cleans_queued_blocks_and_sequence():
    con = _FakeCon(
        operations=[{"operation_id": 9}],
        blocks=[{"block_id": 44}],
    )
    delete_temp_process_sheet(con, "[Temp]NPS26-0360")
    tables = _deleted_tables(con)
    assert tables == [
        "planner_operation_sequence",
        "planner_run_block_segment",
        "planner_run_block",
        "planner_operation",
        "planner_temp_process_sheet",
        "planner_process_sheet",
    ]


def test_delete_temp_process_sheet_route_is_registered():
    from app import app

    rules = {
        (rule.rule, method)
        for rule in app.url_map.iter_rules()
        for method in (rule.methods or set())
    }
    assert ("/api/temp-process-sheets/<path:planner_ps_id>", "DELETE") in rules
    assert ("/api/temp-process-sheets/<path:planner_ps_id>/delete", "POST") in rules


def test_delete_route_accepts_encoded_temp_id(monkeypatch):
    from unittest.mock import patch

    from app import app

    captured = {}

    def fake_delete(con, planner_ps_id):
        captured["planner_ps_id"] = planner_ps_id
        return {"ok": True, "planner_ps_id": planner_ps_id, "deleted": True}

    class _Ctx:
        def __enter__(self):
            return _FakeCon()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr("planning.process_sheets.delete_temp_process_sheet", fake_delete)
    monkeypatch.setattr("planning.process_sheets.planner_db", lambda: _Ctx())
    monkeypatch.setattr("planning.process_sheets._ensure_planner_temp_process_sheet_table", lambda con: None)
    with patch("app._invalidate_pp_vouchers_with_ops_cache"):
        client = app.test_client()
        encoded = "%5BTemp%5DNPS26-0321-15"
        response = client.delete(f"/api/temp-process-sheets/{encoded}")
    assert response.status_code == 200, response.get_data(as_text=True)
    assert captured["planner_ps_id"] == "[Temp]NPS26-0321-15"
    payload = response.get_json()
    assert payload["deleted"] is True


def test_delete_post_fallback_route(monkeypatch):
    from unittest.mock import patch

    from app import app

    def fake_delete(con, planner_ps_id):
        return {"ok": True, "planner_ps_id": planner_ps_id, "deleted": True}

    class _Ctx:
        def __enter__(self):
            return _FakeCon()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr("planning.process_sheets.delete_temp_process_sheet", fake_delete)
    monkeypatch.setattr("planning.process_sheets.planner_db", lambda: _Ctx())
    monkeypatch.setattr("planning.process_sheets._ensure_planner_temp_process_sheet_table", lambda con: None)
    with patch("app._invalidate_pp_vouchers_with_ops_cache"):
        client = app.test_client()
        response = client.post("/api/temp-process-sheets/%5BTemp%5DNPS26-0360/delete")
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.get_json()["deleted"] is True
