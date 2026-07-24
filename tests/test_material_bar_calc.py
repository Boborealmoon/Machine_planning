"""Unit tests for simple PS material calculator."""
from planning.material_bar_calc import compute_calc


def test_target_is_qty_times_per_unit_plus_buffer():
    r = compute_calc(
        {
            "order_qty": 10,
            "material_per_unit_mm": 42,
            "buffer_length_mm": 8,
        },
        [],
    )
    assert r["length_per_piece_mm"] == 50
    assert r["target_total_mm"] == 500
    assert r["returnable_mm"] == -500


def test_returnable_from_issued_batches():
    r = compute_calc(
        {
            "order_qty": 2,
            "material_per_unit_mm": 100,
            "buffer_length_mm": 0,
        },
        [
            {"batch_no": "B1", "length_mm": 300},
            {"batch_no": "B2", "length_mm": 50},
        ],
    )
    assert r["target_total_mm"] == 200
    assert r["issued_total_mm"] == 350
    assert r["returnable_mm"] == 150
    assert len(r["issued_batches"]) == 2
