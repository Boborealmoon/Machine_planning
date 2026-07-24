"""Tests for factory floor plan service."""

from __future__ import annotations

from planning.floor_plan_service import FLOOR_LAYOUT_MACHINES


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
