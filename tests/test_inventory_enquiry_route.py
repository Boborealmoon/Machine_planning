from planning.inventory_enquiry_route import _attach_lot_references, _serialize_lot_row


def test_attach_lot_references_adds_refs_per_inventory_code():
    rows = [
        {"inventory_code": "PART-A", "main_desc": "Alpha"},
        {"inventory_code": "PART-B", "main_desc": "Beta"},
    ]
    refs_by_code = {
        "PART-A": ["AM/0001/24", "AM/0002/24"],
    }

    out = _attach_lot_references(rows, refs_by_code)

    assert out[0]["lot_reference_nos"] == ["AM/0001/24", "AM/0002/24"]
    assert out[1]["lot_reference_nos"] == []


def test_serialize_lot_row_builds_stable_key():
    lot = _serialize_lot_row({
        "inventory_code": "PART-A",
        "reference_no": "AM/0001/24",
        "location_code": "AM",
        "lot_no": 2,
        "remaining_qty": 10,
    })
    assert lot["lot_key"] == "PART-A|AM/0001/24|AM|2"
