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


def test_overrun_warning_multi_pc_per_pallet_cnc35_case():
    """4 cycles × 3 pc/pal = 12 vs WO 10 — the Schedule-to-MPP ceil bug pattern."""
    warnings = _mpp_queue_overrun_warnings(
        {
            "cnc35": {
                "cycles": [
                    {"ops": [{"jobId": "nps26-0229::p1::op40", "palletCount": 1, "pcsPerPallet": 3}]}
                    for _ in range(4)
                ]
            }
        },
        {
            "nps26-0229::p1::op40": {"psId": "NPS26-0229", "qty": 10, "out": 0},
        },
    )
    assert len(warnings) == 1
    assert "NPS26-0229" in warnings[0]
    assert "12" in warnings[0]
    assert "10" in warnings[0]
    assert "remove 2 pc" in warnings[0]


def plan_bulk_schedule_cycles(qty, rem, pallets_per_cycle, pcs_per_pallet):
    """Mirror of static/js/mpp_planner.js planBulkScheduleCycles (full pallets only)."""
    effective_pcs = max(1, int(pcs_per_pallet or 1))
    pal_per_cycle = max(1, int(pallets_per_cycle or 1))
    left = min(max(0, int(qty or 0)), max(0, int(rem or 0)))
    max_per_cycle = pal_per_cycle * effective_pcs
    pallet_counts: list[int] = []
    while left >= effective_pcs:
        cycle_pcs = min(left, max_per_cycle)
        pallets = min(pal_per_cycle, cycle_pcs // effective_pcs)
        if pallets < 1:
            break
        pallet_counts.append(pallets)
        left -= pallets * effective_pcs
    return {
        "palletCounts": pallet_counts,
        "scheduledPcs": sum(p * effective_pcs for p in pallet_counts),
        "leftoverPcs": left,
        "effectivePcs": effective_pcs,
    }


def test_bulk_schedule_plan_does_not_overshoot_wo_qty():
    plan = plan_bulk_schedule_cycles(qty=10, rem=10, pallets_per_cycle=1, pcs_per_pallet=3)
    assert plan["palletCounts"] == [1, 1, 1]
    assert plan["scheduledPcs"] == 9
    assert plan["leftoverPcs"] == 1


def test_bulk_schedule_plan_variable_last_cycle_pallets():
    plan = plan_bulk_schedule_cycles(qty=10, rem=10, pallets_per_cycle=2, pcs_per_pallet=3)
    assert plan["palletCounts"] == [2, 1]
    assert plan["scheduledPcs"] == 9
    assert plan["leftoverPcs"] == 1


def test_bulk_schedule_plan_exact_fill():
    plan = plan_bulk_schedule_cycles(qty=9, rem=9, pallets_per_cycle=1, pcs_per_pallet=3)
    assert plan["palletCounts"] == [1, 1, 1]
    assert plan["scheduledPcs"] == 9
    assert plan["leftoverPcs"] == 0
