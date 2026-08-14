"""Lane completed-op filtering for board load vs queue mutation refresh."""

from planning.queue_visibility import (
    filter_completed_lane_blocks_fast,
    filter_completed_lane_blocks_for_load,
)


def test_lite_load_does_not_touch_catalog(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("lite lane filter must not load ERP/catalog context")

    monkeypatch.setattr(
        "planning.queue_visibility.catalog_lane_context_for_blocks",
        boom,
    )
    blocks = [
        {
            "block_id": 2,
            "execution_status": "NOT_STARTED",
            "scheduled_qty": 4,
        }
    ]
    assert filter_completed_lane_blocks_for_load(object(), blocks, lite=True) == blocks


def test_fast_filter_hides_done_keeps_open():
    blocks = [
        {"block_id": 1, "execution_status": "DONE", "scheduled_qty": 4},
        {"block_id": 2, "execution_status": "NOT_STARTED", "scheduled_qty": 4},
    ]
    kept = filter_completed_lane_blocks_fast(blocks)
    assert [row["block_id"] for row in kept] == [2]
