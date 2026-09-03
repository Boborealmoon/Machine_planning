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


def test_overrun_warning_when_erp_qty_already_met():
    """Queued pcs with open WO qty 0 (qty == out) must warn, not be silently skipped."""
    warnings = _mpp_queue_overrun_warnings(
        {
            "cnc41": {
                "cycles": [
                    {
                        "ops": [
                            {"jobId": "nps26-0341::p1::op20", "palletCount": 1, "pcsPerPallet": 1},
                        ]
                    }
                ]
            }
        },
        {
            "nps26-0341::p1::op20": {"psId": "NPS26-0341", "qty": 5, "out": 5},
        },
    )
    assert len(warnings) == 1
    assert "NPS26-0341" in warnings[0]
    assert "already met" in warnings[0].lower()


def plan_bulk_schedule_cycles(qty, rem, pallets_per_cycle, pcs_per_pallet):
    """Mirror of static/js/mpp_planner.js planBulkScheduleCycles (full + leftover partial)."""
    effective_pcs = max(1, int(pcs_per_pallet or 1))
    pal_per_cycle = max(1, int(pallets_per_cycle or 1))
    left = min(max(0, int(qty or 0)), max(0, int(rem or 0)))
    max_per_cycle = pal_per_cycle * effective_pcs
    cycles: list[dict[str, int]] = []
    while left >= effective_pcs:
        cycle_pcs = min(left, max_per_cycle)
        pallets = min(pal_per_cycle, cycle_pcs // effective_pcs)
        if pallets < 1:
            break
        cycles.append({"palletCount": pallets, "pcsPerPallet": effective_pcs})
        left -= pallets * effective_pcs
    partial_pcs = 0
    if left > 0:
        partial_pcs = left
        cycles.append({"palletCount": 1, "pcsPerPallet": left})
        left = 0
    return {
        "cycles": cycles,
        "palletCounts": [c["palletCount"] for c in cycles],
        "scheduledPcs": sum(c["palletCount"] * c["pcsPerPallet"] for c in cycles),
        "leftoverPcs": 0,
        "partialPcs": partial_pcs,
        "effectivePcs": effective_pcs,
    }


def test_bulk_schedule_plan_includes_leftover_partial_pallet():
    plan = plan_bulk_schedule_cycles(qty=10, rem=10, pallets_per_cycle=1, pcs_per_pallet=3)
    assert plan["palletCounts"] == [1, 1, 1, 1]
    assert plan["cycles"][-1] == {"palletCount": 1, "pcsPerPallet": 1}
    assert plan["scheduledPcs"] == 10
    assert plan["leftoverPcs"] == 0
    assert plan["partialPcs"] == 1


def test_bulk_schedule_plan_variable_last_cycle_with_partial():
    plan = plan_bulk_schedule_cycles(qty=10, rem=10, pallets_per_cycle=2, pcs_per_pallet=3)
    assert plan["palletCounts"] == [2, 1, 1]
    assert plan["cycles"] == [
        {"palletCount": 2, "pcsPerPallet": 3},
        {"palletCount": 1, "pcsPerPallet": 3},
        {"palletCount": 1, "pcsPerPallet": 1},
    ]
    assert plan["scheduledPcs"] == 10
    assert plan["partialPcs"] == 1


def test_bulk_schedule_plan_exact_fill():
    plan = plan_bulk_schedule_cycles(qty=9, rem=9, pallets_per_cycle=1, pcs_per_pallet=3)
    assert plan["palletCounts"] == [1, 1, 1]
    assert plan["scheduledPcs"] == 9
    assert plan["leftoverPcs"] == 0
    assert plan["partialPcs"] == 0


def test_bulk_schedule_plan_only_partial_leftover():
    plan = plan_bulk_schedule_cycles(qty=2, rem=2, pallets_per_cycle=1, pcs_per_pallet=3)
    assert plan["cycles"] == [{"palletCount": 1, "pcsPerPallet": 2}]
    assert plan["scheduledPcs"] == 2
    assert plan["partialPcs"] == 2
    assert plan["leftoverPcs"] == 0


def test_mpp_save_does_not_write_scheduler_blocks():
    import inspect

    from planning.mpp_planner_queue_service import (
        _save_one_mpp_machine_lane,
        save_mpp_planner_queue,
    )

    save_lane = inspect.getsource(_save_one_mpp_machine_lane)
    assert "_upsert_block_for_op" not in save_lane
    assert "_ensure_operation_for_op" not in save_lane
    save_queue = inspect.getsource(save_mpp_planner_queue)
    assert "_sync_machine_queue" not in save_queue


def test_mpp_load_detaches_mirrors_instead_of_rehydrating():
    import inspect

    from planning.mpp_planner_queue_service import (
        _mpp_cycle_ops_need_scheduler_blocks,
        ensure_mpp_planner_scheduler_lanes,
        load_mpp_planner_queue,
        recalculate_mpp_planner_machines,
    )

    assert _mpp_cycle_ops_need_scheduler_blocks(None) is False
    load_src = inspect.getsource(load_mpp_planner_queue)
    assert "detach_mpp_planner_scheduler_blocks" in load_src
    assert "rehydrate_mpp_scheduler_blocks_if_needed" not in load_src
    ensure_src = inspect.getsource(ensure_mpp_planner_scheduler_lanes)
    assert "detach_mpp_planner_scheduler_blocks" in ensure_src
    assert "rehydrate_mpp_scheduler_blocks_if_needed" not in ensure_src
    recalc_src = inspect.getsource(recalculate_mpp_planner_machines)
    assert "recalculate_machine" not in recalc_src
    assert '"recalculated": 0' in recalc_src


def test_main_planner_lane_queries_always_exclude_mpp_owned():
    import inspect

    from planning.catalog import _catalog_lane_qty_maps
    from planning.operation_sequence import main_planner_lane_block_ids

    lane_src = inspect.getsource(main_planner_lane_block_ids)
    assert "is_mpp_planner_machine_id" not in lane_src
    catalog_src = inspect.getsource(_catalog_lane_qty_maps)
    assert "scheduler_blocks_exclude_mpp_planner_clause" in catalog_src
