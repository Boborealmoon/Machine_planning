"""Unit tests for MPP partial-save scope helpers (no DB)."""
from planning.mpp_planner_queue_service import (
    _mpp_queue_overrun_warnings,
    _save_scope_slugs,
)


def test_save_scope_none_means_full_legacy_save():
    assert _save_scope_slugs({"machines": {}}) is None


def test_save_scope_empty_dirty_is_noop():
    assert _save_scope_slugs({"dirtyMachines": []}) == set()
    assert _save_scope_slugs({"dirtyMachineSlugs": []}) == set()


def test_save_scope_normalizes_slugs():
    assert _save_scope_slugs({"dirtyMachines": ["CNC35", " cnc36 "]}) == {"cnc35", "cnc36"}


def test_overrun_warning_message():
    warnings = _mpp_queue_overrun_warnings(
        {
            "cnc35": {
                "cycles": [
                    {
                        "ops": [
                            {"jobId": "nps26-0223::p1::op10", "palletCount": 2, "pcsPerPallet": 100},
                        ]
                    }
                ]
            }
        },
        {
            "nps26-0223::p1::op10": {"psId": "NPS26-0223", "qty": 100, "out": 0},
        },
    )
    assert len(warnings) == 1
    assert "NPS26-0223" in warnings[0]
    assert "200" in warnings[0]
    assert "100" in warnings[0]
