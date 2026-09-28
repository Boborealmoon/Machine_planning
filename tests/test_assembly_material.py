"""Assembly Parts Tracker child-arrival rollup onto parent NPS/APS sheets."""
from planning.assembly_material import (
    apply_assembly_material_rollup,
    rollup_assembly_material,
)


def test_nps_0321_uses_latest_outstanding_child_arrival():
    rolled = rollup_assembly_material(
        parent_subcon="2026-09-05",
        children=[
            {"process_sheet_no": "NPS26-0321-1", "material_subcon": "2027-01-08"},
            {"process_sheet_no": "NPS26-0321-10", "material_subcon": "2026-09-12"},
            {"process_sheet_no": "NPS26-0321-3", "material_subcon": "2026-10-31"},
            {"process_sheet_no": "NPS26-0321-12", "material_subcon": "ARRIVED", "material_in": True},
            {"process_sheet_no": "NPS26-0321-17", "material_subcon": ""},
        ],
    )
    assert rolled is not None
    assert rolled["material_status"] == "Expected"
    assert rolled["material_in_date"] == "2027-01-08"
    assert rolled["material_subcon"] == "2027-01-08"
    assert rolled["source"] == "assembly_parts"
    assert rolled["pending_child_count"] == 4


def test_rollup_none_without_children():
    assert rollup_assembly_material(parent_subcon="2026-09-05", children=[]) is None
    assert rollup_assembly_material(parent_subcon="2026-09-05", children=None) is None


def test_all_children_arrived_keeps_parent_expected_date():
    rolled = rollup_assembly_material(
        parent_subcon="2026-09-05",
        children=[
            {"material_subcon": "ARRIVED"},
            {"material_in": True, "material_subcon": ""},
        ],
    )
    assert rolled["material_status"] == "Expected"
    assert rolled["material_in_date"] == "2026-09-05"
    assert rolled["source"] == "parent"


def test_all_children_arrived_and_parent_arrived():
    rolled = rollup_assembly_material(
        parent_subcon="ARRIVED",
        parent_material_in=True,
        parent_material_in_date="2026-08-01",
        children=[{"material_subcon": "ARRIVED"}],
    )
    assert rolled["material_status"] == "Arrived"
    assert rolled["material_subcon"] == "ARRIVED"
    assert rolled["pending_child_count"] == 0


def test_arrived_parent_still_waits_on_child_date():
    rolled = rollup_assembly_material(
        parent_subcon="ARRIVED",
        parent_material_in=True,
        children=[{"material_subcon": "2027-01-08"}],
    )
    assert rolled["material_status"] == "Expected"
    assert rolled["material_in_date"] == "2027-01-08"


def test_apply_sets_parent_not_child_sheet(monkeypatch):
    orders = [
        {
            "pp_vouchers": [
                {
                    "pp_voucher_no": "PP/1",
                    "process_sheet_no": "NPS26-0321",
                    "material_subcon": "2026-09-05",
                },
                {
                    "pp_voucher_no": "NPS26-0321-1",
                    "process_sheet_no": "NPS26-0321-1",
                    "material_subcon": "2027-01-08",
                },
            ]
        }
    ]
    monkeypatch.setattr(
        "planning.assembly_material.load_child_arrivals_by_parent",
        lambda _ids: {
            "NPS26-0321": [
                {"process_sheet_no": "NPS26-0321-1", "material_subcon": "2027-01-08"},
                {"process_sheet_no": "NPS26-0321-3", "material_subcon": "2026-10-31"},
            ]
        },
    )
    apply_assembly_material_rollup(orders)
    parent = orders[0]["pp_vouchers"][0]
    child = orders[0]["pp_vouchers"][1]
    assert parent["assembly_material_subcon"] == "2027-01-08"
    assert parent["assembly_material_in_date"] == "2027-01-08"
    assert parent["material_subcon"] == "2026-09-05"
    assert "assembly_material_subcon" not in child
