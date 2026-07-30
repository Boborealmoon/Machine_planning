"""Tests for factory floor plan service and monthly capacity bookings."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest

from planning.floor_plan_service import (
    FLOOR_LAYOUT_MACHINES,
    capacity_hours_by_machine_code,
    delete_machine_capacity_booking,
    fetch_bookings,
    fetch_floor_plan,
    normalize_planning_month,
    normalize_reserved_hours,
    reserved_pct,
    upsert_machine_capacity_booking,
)


def test_floor_layout_includes_cnc_41():
    codes = {m["machine_no"] for m in FLOOR_LAYOUT_MACHINES}
    assert "CNC 41" in codes


def test_floor_layout_has_all_fleet_machines():
    expected = {
        "CNC 10", "CNC 15", "CNC 20", "CNC 21", "CNC 22", "CNC 24", "CNC 25",
        "CNC 26", "CNC 27", "CNC 29", "CNC 30", "CNC 31", "CNC 32", "CNC 35",
        "CNC 36", "CNC 38", "CNC 39", "CNC 40", "CNC 41",
    }
    codes = {m["machine_no"] for m in FLOOR_LAYOUT_MACHINES}
    assert codes == expected


def test_reserved_pct_calculation():
    assert reserved_pct(40, 200) == 20.0
    assert reserved_pct(0, 200) == 0.0
    assert reserved_pct(50, 0) == 0.0


def test_normalize_reserved_hours_rejects_non_positive():
    assert normalize_reserved_hours("12.5") == 12.5
    with pytest.raises(ValueError, match="greater than 0"):
        normalize_reserved_hours(0)
    with pytest.raises(ValueError, match="greater than 0"):
        normalize_reserved_hours(-1)
    with pytest.raises(ValueError, match="must be a number"):
        normalize_reserved_hours("abc")


def test_normalize_planning_month():
    assert normalize_planning_month(2026, 7) == (2026, 7)
    with pytest.raises(ValueError):
        normalize_planning_month(2026, 13)
    with pytest.raises(ValueError):
        normalize_planning_month(1999, 1)


def test_capacity_hours_by_machine_code():
    report = {
        "groups": [
            {
                "machines": [
                    {"machine_code": "CNC 38", "effective_capacity_hours": 210.0},
                    {"machine_code": "CNC 39", "effective_capacity_hours": 105.5},
                ]
            }
        ]
    }
    assert capacity_hours_by_machine_code(report) == {
        "CNC 38": 210.0,
        "CNC 39": 105.5,
    }


class _FakeCursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None, one_row: dict[str, Any] | None = None):
        self._rows = rows or ([] if one_row is None else [one_row])

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeBookingConnection:
    """Minimal in-memory store for capacity booking SQL used by the service."""

    def __init__(self, machines: dict[int, str] | None = None):
        self.machines = machines or {38: "CNC 38", 39: "CNC 39"}
        self.bookings: dict[int, dict[str, Any]] = {}
        self._next_id = 1
        self.last_sql = ""

    def execute(self, sql: str, params: tuple | list | None = None):
        self.last_sql = " ".join(sql.split())
        params = tuple(params or ())
        sql_l = self.last_sql.lower()

        if "create table if not exists" in sql_l or "create index if not exists" in sql_l:
            return _FakeCursor()
        if "insert into public.planner_machines" in sql_l:
            return _FakeCursor()

        if "from public.planner_machines where machine_id" in sql_l:
            machine_id = int(params[0])
            if machine_id not in self.machines:
                return _FakeCursor()
            return _FakeCursor(one_row={"machine_id": machine_id, "machine_no": self.machines[machine_id]})

        if "insert into public.planner_machine_capacity_booking" in sql_l:
            machine_id, year, month, part_no, hours, label, notes = params
            key = None
            for booking_id, row in self.bookings.items():
                if (
                    row["machine_id"] == machine_id
                    and row["planning_year"] == year
                    and row["planning_month"] == month
                    and row["part_no"] == part_no
                ):
                    key = booking_id
                    break
            now = datetime(2026, 7, 27, 12, 0, 0)
            if key is None:
                key = self._next_id
                self._next_id += 1
                created = now
            else:
                created = self.bookings[key]["created_at"]
            row = {
                "booking_id": key,
                "machine_id": int(machine_id),
                "planning_year": int(year),
                "planning_month": int(month),
                "part_no": part_no,
                "reserved_hours": float(hours),
                "tag_label": label,
                "notes": notes,
                "created_at": created,
                "updated_at": now,
                "machine_no": self.machines[int(machine_id)],
            }
            self.bookings[key] = row
            return _FakeCursor(one_row=dict(row))

        if "coalesce(sum(reserved_hours), 0)" in sql_l:
            machine_id, year, month, exclude_part = params
            total = sum(
                float(row["reserved_hours"])
                for row in self.bookings.values()
                if row["machine_id"] == machine_id
                and row["planning_year"] == year
                and row["planning_month"] == month
                and row["part_no"] != exclude_part
            )
            return _FakeCursor(one_row={"total_hours": total})

        if "from public.planner_machine_capacity_booking b" in sql_l and "where b.planning_year" in sql_l:
            year, month = params
            matched = [
                dict(row)
                for row in self.bookings.values()
                if row["planning_year"] == year and row["planning_month"] == month
            ]
            matched.sort(key=lambda r: (r["machine_no"], r["part_no"]))
            return _FakeCursor(rows=matched)

        if "delete from public.planner_machine_capacity_booking" in sql_l:
            booking_id = int(params[0])
            if booking_id not in self.bookings:
                return _FakeCursor()
            del self.bookings[booking_id]
            return _FakeCursor(one_row={"booking_id": booking_id})

        raise AssertionError(f"Unexpected SQL in FakeBookingConnection: {self.last_sql}")


def test_upsert_two_parts_same_machine_month(monkeypatch):
    con = FakeBookingConnection()

    def fake_capacity(**kwargs):
        return 200.0

    monkeypatch.setattr(
        "planning.floor_plan_service._machine_effective_capacity_hours",
        lambda *args, **kwargs: fake_capacity(**kwargs),
    )

    first = upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-A",
        reserved_hours=40,
        tag_label="A",
    )
    second = upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-B",
        reserved_hours=60,
        tag_label="B",
    )

    assert first["booking_id"] != second["booking_id"]
    assert second["total_reserved_hours"] == 100.0
    assert second["over_capacity"] is False

    by_machine = fetch_bookings(con, 2026, 7)
    assert len(by_machine[38]) == 2
    assert {b["part_no"] for b in by_machine[38]} == {"PART-A", "PART-B"}
    assert sum(b["reserved_hours"] for b in by_machine[38]) == 100.0


def test_upsert_same_part_updates_hours(monkeypatch):
    con = FakeBookingConnection()
    monkeypatch.setattr(
        "planning.floor_plan_service._machine_effective_capacity_hours",
        lambda *args, **kwargs: 100.0,
    )

    first = upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-A",
        reserved_hours=40,
    )
    updated = upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-A",
        reserved_hours=55,
    )
    assert first["booking_id"] == updated["booking_id"]
    assert updated["reserved_hours"] == 55.0
    assert len(fetch_bookings(con, 2026, 7)[38]) == 1


def test_over_capacity_warning_still_saves(monkeypatch):
    con = FakeBookingConnection()
    monkeypatch.setattr(
        "planning.floor_plan_service._machine_effective_capacity_hours",
        lambda *args, **kwargs: 50.0,
    )
    booking = upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-A",
        reserved_hours=80,
    )
    assert booking["over_capacity"] is True
    assert booking["warning"]
    assert "exceeds effective capacity" in booking["warning"]


def test_month_isolation_and_delete(monkeypatch):
    con = FakeBookingConnection()
    monkeypatch.setattr(
        "planning.floor_plan_service._machine_effective_capacity_hours",
        lambda *args, **kwargs: 200.0,
    )

    july = upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-A",
        reserved_hours=40,
    )
    upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=8,
        part_no="PART-A",
        reserved_hours=25,
    )

    assert len(fetch_bookings(con, 2026, 7).get(38, [])) == 1
    assert len(fetch_bookings(con, 2026, 8).get(38, [])) == 1
    assert fetch_bookings(con, 2026, 7)[38][0]["reserved_hours"] == 40.0
    assert fetch_bookings(con, 2026, 8)[38][0]["reserved_hours"] == 25.0

    assert delete_machine_capacity_booking(con, july["booking_id"]) is True
    assert fetch_bookings(con, 2026, 7) == {}
    assert len(fetch_bookings(con, 2026, 8).get(38, [])) == 1


def test_fetch_floor_plan_includes_reserved_hours(monkeypatch):
    con = FakeBookingConnection({38: "CNC 38"})
    monkeypatch.setattr(
        "planning.floor_plan_service._machine_effective_capacity_hours",
        lambda *args, **kwargs: 200.0,
    )
    upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-A",
        reserved_hours=40,
    )
    upsert_machine_capacity_booking(
        con,
        machine_id=38,
        planning_year=2026,
        planning_month=7,
        part_no="PART-B",
        reserved_hours=20,
    )

    def fake_report(*args, **kwargs):
        return {
            "planning_year": 2026,
            "planning_month": 7,
            "planning_month_label": "July 2026",
            "capacity_basis": kwargs.get("capacity_basis") or "rest_of_month",
            "capacity_basis_label": "Rest of month",
            "capacity_window_label": "Rest of this month",
            "capacity_window_start": "2026-07-27",
            "capacity_window_end": "2026-07-31",
            "as_of_date": "2026-07-27",
            "groups": [
                {
                    "key": "multiaxis",
                    "label": "Multi-Axis",
                    "header_subtitle": "3X",
                    "effective_utilization_pct": 50.0,
                    "machines": [
                        {
                            "machine_id": 38,
                            "machine_code": "CNC 38",
                            "effective_utilization_pct": 98.3,
                            "effective_capacity_hours": 200.0,
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr("planning.floor_plan_service.build_group_capacity_report", fake_report)
    monkeypatch.setattr(
        "planning.floor_plan_service.fetch_machines",
        lambda _con: [{"machine_id": 38, "machine_no": "CNC 38", "machine_category": "TURNMILL", "shift_profile": "STANDARD"}],
    )

    # Tag query returns empty
    original_execute = con.execute

    def execute_with_tags(sql, params=None):
        sql_l = " ".join(sql.split()).lower()
        if "from public.planner_machine_part_tag" in sql_l:
            return _FakeCursor(rows=[])
        return original_execute(sql, params)

    con.execute = execute_with_tags

    payload = fetch_floor_plan(con, year=2026, month=7, capacity_basis="rest_of_month")
    machine = next(m for m in payload["machines"] if m["machine_no"] == "CNC 38")
    assert machine["reserved_hours"] == 60.0
    assert machine["effective_capacity_hours"] == 200.0
    assert machine["reserved_pct"] == 30.0
    assert machine["effective_utilization_pct"] == 98.3
    assert {b["part_no"] for b in machine["bookings"]} == {"PART-A", "PART-B"}
