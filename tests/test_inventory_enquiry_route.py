from planning.inventory_enquiry_route import (
    _attach_lot_references,
    _filter_lots_by_codes,
    _lot_summary_from_row,
    _serialize_lot_row,
)


def test_attach_lot_references_adds_summaries_per_inventory_code():
    rows = [
        {"inventory_code": "PART-A", "main_desc": "Alpha"},
        {"inventory_code": "PART-B", "main_desc": "Beta"},
    ]
    refs_by_code = {
        "PART-A": [
            {
                "reference_no": "AM/0001/24",
                "batch_count": 2,
                "lot_line_count": 2,
                "remaining_qty": 80,
                "original_qty": 100,
                "allocation_qty": 10,
                "available_qty": 70,
            },
            {
                "reference_no": "AM/0002/24",
                "batch_count": 1,
                "lot_line_count": 1,
                "remaining_qty": 12,
                "original_qty": 12,
                "allocation_qty": 0,
                "available_qty": 12,
            },
        ],
    }

    out = _attach_lot_references(rows, refs_by_code)

    assert out[0]["lot_reference_nos"] == ["AM/0001/24", "AM/0002/24"]
    assert out[0]["lot_summaries"][0]["remaining_qty"] == 80
    assert out[0]["lot_summaries"][0]["batch_count"] == 2
    assert out[1]["lot_reference_nos"] == []
    assert out[1]["lot_summaries"] == []


def test_lot_summary_from_row_skips_blank_reference():
    assert _lot_summary_from_row({"reference_no": "  ", "remaining_qty": 9}) is None
    summary = _lot_summary_from_row({
        "reference_no": "AM/0468/21",
        "batch_count": 1,
        "lot_line_count": 1,
        "remaining_qty": 1346,
    })
    assert summary["reference_no"] == "AM/0468/21"
    assert summary["remaining_qty"] == 1346


def test_serialize_lot_row_builds_stable_key_and_batch_no():
    lot = _serialize_lot_row({
        "inventory_code": "PART-A",
        "reference_no": "AM/0001/24",
        "location_code": "AM",
        "lot_no": 2,
        "remaining_qty": 10,
    })
    assert lot["lot_key"] == "PART-A|AM/0001/24|AM|2"
    assert lot["batch_no"] == "2"


def test_attach_lot_references_matches_codes_case_insensitively():
    rows = [{"inventory_code": "cuzn19al6*3_d38.1"}]
    refs_by_code = {
        "CUZN19AL6*3_D38.1": [{"reference_no": "AM/0388/20", "remaining_qty": 100}],
    }
    out = _attach_lot_references(rows, refs_by_code)
    assert out[0]["lot_reference_nos"] == ["AM/0388/20"]
    assert out[0]["lot_summaries"][0]["remaining_qty"] == 100


def test_filter_lots_by_codes_is_case_insensitive():
    lots = [{"inventory_code": "CuZn19Al6*3_D38.1", "remaining_qty": 10}]
    out = _filter_lots_by_codes(lots, ["CUZN19AL6*3_D38.1"])
    assert len(out) == 1
