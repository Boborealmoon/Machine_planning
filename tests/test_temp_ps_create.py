"""Temp PS create must return JSON-safe payloads and skip taken identities."""

from __future__ import annotations

from datetime import date, datetime

from planning.process_sheets import (
    TEMP_PARTIAL_MIN,
    _allocate_temp_planner_identity,
    _parse_temp_due_date,
    _temp_planner_ps_id_for_sequence,
    _temp_ps_created_payload,
)


class _FakeCursor:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _FakeCon:
    def __init__(self, existing_ids=None, existing_partials=None, max_partial=None):
        self.existing_ids = set(existing_ids or [])
        self.existing_partials = set(existing_partials or [])
        self.max_partial = max_partial
        self.statements = []

    def execute(self, sql, params=None):
        text = " ".join(str(sql).split())
        self.statements.append((text, params))
        lowered = text.lower()
        if "max(pp_partial_no)" in lowered:
            return _FakeCursor([{"mx": self.max_partial}])
        if "select 1 as ok" in lowered:
            planner_ps_id, source_ps_id, next_partial = params
            taken = planner_ps_id in self.existing_ids or (
                source_ps_id,
                next_partial,
            ) in self.existing_partials
            return _FakeCursor([{"ok": 1}] if taken else [])
        if "from planner_temp_process_sheet" in lowered:
            return _FakeCursor([{"due_date": date(2026, 9, 9), "selected_bom_code": "NPS-TEMP-REWORK"}])
        if "from planner_bom_variation" in lowered:
            return _FakeCursor([])
        return _FakeCursor([])


def test_allocate_skips_legacy_temp_id_without_high_partial():
    con = _FakeCon(existing_ids={"[Temp]NPS26-0001"})
    planner_ps_id, partial = _allocate_temp_planner_identity(con, "NPS26-0001")
    assert planner_ps_id == "[Temp]NPS26-0001-2"
    assert partial == TEMP_PARTIAL_MIN + 1


def test_allocate_uses_first_id_when_free():
    con = _FakeCon()
    planner_ps_id, partial = _allocate_temp_planner_identity(con, "NPS26-0001")
    assert planner_ps_id == "[Temp]NPS26-0001"
    assert partial == TEMP_PARTIAL_MIN


def test_temp_planner_ps_id_for_sequence():
    assert _temp_planner_ps_id_for_sequence("NPS26-0001", 1) == "[Temp]NPS26-0001"
    assert _temp_planner_ps_id_for_sequence("NPS26-0001", 2) == "[Temp]NPS26-0001-2"


def test_parse_preview_due_date_does_not_block_create():
    assert _parse_temp_due_date(date(2026, 9, 9), strict=False) == date(2026, 9, 9)
    assert _parse_temp_due_date(datetime(2026, 9, 9, 8, 30), strict=False) == date(2026, 9, 9)
    assert _parse_temp_due_date("09/09/2026", strict=False) == date(2026, 9, 9)
    assert _parse_temp_due_date("not-a-date", strict=False) is None


def test_created_payload_is_json_serializable():
    from flask import json as flask_json

    payload = _temp_ps_created_payload(
        _FakeCon(),
        planner_ps_id="[Temp]NPS26-0001",
        source_ps_id="NPS26-0001",
        source_pp_partial_no=1,
        temp_partial_no=TEMP_PARTIAL_MIN,
        qty=3.0,
        preview={"part_no": "ABC", "part_desc": "Part", "due_date": "2026-09-09"},
    )
    assert "row" not in payload
    assert "temp_record" not in payload
    dumped = flask_json.dumps(payload)
    assert "[Temp]NPS26-0001" in dumped
    assert "datetime" not in dumped.lower()


def test_create_route_returns_created_payload(monkeypatch):
    from unittest.mock import patch

    from app import app

    class _Ctx:
        def __enter__(self):
            return _FakeCon()

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_create(con, source_ps_id, pp_partial_no, qty, remarks="", due_date=""):
        return {
            "planner_ps_id": "[Temp]NPS26-0001",
            "ps_id": "[Temp]NPS26-0001",
            "display_ps_id": "[Temp] NPS26-0001",
            "source_ps_id": source_ps_id,
            "is_temp_ps": True,
            "planned_qty": qty,
            "reject_qty": qty,
        }

    monkeypatch.setattr("planning.process_sheets.create_temp_process_sheet", fake_create)
    monkeypatch.setattr("planning.process_sheets.planner_db", lambda: _Ctx())
    monkeypatch.setattr("planning.process_sheets._ensure_planner_temp_process_sheet_table", lambda con: None)
    with patch("app._invalidate_pp_vouchers_with_ops_cache"):
        client = app.test_client()
        response = client.post(
            "/api/temp-process-sheets",
            json={"source_ps_id": "NPS26-0001", "qty": 3},
        )
    assert response.status_code == 200, response.get_data(as_text=True)
    payload = response.get_json()
    assert payload["planner_ps_id"] == "[Temp]NPS26-0001"
    assert payload["is_temp_ps"] is True
