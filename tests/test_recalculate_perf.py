"""Guards so queue recalculate stays off per-day / per-card DB chatter."""

from datetime import date, datetime

from planning.machines import (
    INTERVAL_CACHE_CAPACITY_CTX,
    INTERVAL_CACHE_DATE_RANGE,
    INTERVAL_CACHE_WINDOWS,
    machine_work_intervals_for_day,
)


class _BoomCon:
    def execute(self, *_args, **_kwargs):
        raise AssertionError("prefetched interval cache must not query the database")


def test_machine_work_intervals_use_cached_day_without_db():
    work_day = date(2026, 9, 2)
    start = datetime(2026, 9, 2, 8, 30)
    end = datetime(2026, 9, 2, 12, 0)
    cache = {(1, "2026-09-02"): [(start, end)]}
    assert machine_work_intervals_for_day(_BoomCon(), 1, work_day, interval_cache=cache) == [(start, end)]


def test_machine_work_intervals_use_capacity_prefetch_without_db():
    work_day = date(2026, 9, 2)
    cache = {
        INTERVAL_CACHE_CAPACITY_CTX: {
            "overrides": {},
            "holidays": set(),
            "profiles_by_name": {
                "NORMAL_DAY_NIGHT": {
                    "profile_name": "NORMAL_DAY_NIGHT",
                    "capacity_minutes": 0,
                    "start_minute": 510,
                    "note": "",
                }
            },
            "shift_profiles": {22: "STANDARD"},
            "fallback_profile": None,
        },
        INTERVAL_CACHE_WINDOWS: [],
        INTERVAL_CACHE_DATE_RANGE: (date(2026, 8, 1), date(2027, 9, 1)),
    }
    intervals = machine_work_intervals_for_day(_BoomCon(), 22, work_day, interval_cache=cache)
    assert intervals
    assert intervals[0][0] == datetime(2026, 9, 2, 8, 30)
    assert cache[(22, "2026-09-02")] == intervals


def test_recalculate_machine_prefetsches_capacity_and_batches_state():
    import inspect

    from planning.blocks import _recalculate_machine_inner, recalculate_machine
    from planning.operation_sequence import sync_machine_operation_sequence
    from planning.scheduler_state import refresh_states_for_machine

    recalc_src = inspect.getsource(_recalculate_machine_inner)
    assert "prepare_machine_interval_cache" in recalc_src
    assert "PREDICTED_END_CHANGED" not in recalc_src
    assert "execute_values" in inspect.getsource(sync_machine_operation_sequence)
    assert "ON CONFLICT (block_id) DO UPDATE SET" in inspect.getsource(refresh_states_for_machine)
    assert "refresh_machine_queue_state(con, block_id" not in inspect.getsource(refresh_states_for_machine)
    wrapper_src = inspect.getsource(recalculate_machine)
    assert "_recalculate_machine_inner" in wrapper_src


def test_queue_delete_does_not_inline_recalculate():
    import inspect

    from planning.operation_sequence import resync_machine_lane_after_remove
    from planning.planner_routes import _trial_delete_response, api_trial_delete_block

    sig = inspect.signature(resync_machine_lane_after_remove)
    assert sig.parameters["recalculate"].default is False
    assert "if recalculate and tail" in inspect.getsource(resync_machine_lane_after_remove)
    assert "recalculate=False" in inspect.getsource(api_trial_delete_block)
    assert '"recalculated": False' in inspect.getsource(_trial_delete_response)
