"""Process sheet trace: pushed BOM line items through to allocated batch / heat."""
import os
from unittest.mock import patch

from app import app
from planning.process_sheet_trace_service import build_trace, lot_identity


def test_lot_identity_prefers_the_location_that_still_holds_the_allocation():
    identity = lot_identity(
        [
            {
                "reference_no": "M2314/01/19",
                "allocation_qty": 0,
                "remaining_qty": 0,
            },
            {
                "reference_no": "M/03992/25",
                "allocation_qty": 384,
                "remaining_qty": 384,
            },
        ]
    )
    assert identity["batch_no"] == "M/03992/25"
    assert identity["other_refs"] == ["M2314/01/19"]


def test_simple_sheet_traces_the_pushed_material_to_its_batch():
    payload = build_trace(
        {
            "pp_voucher_no": "NPS26-0484",
            "inventory_code": "PART-1",
            "bom_code": "SMP-MAT-01_REV01",
            "pp_qty": 12,
            "status": "O",
            "source_voucher_no": "SO/2600001",
            "source_line_item_no": 1,
        },
        [
            {
                "pp_partial_no": 1,
                "inventory_code": "PART-1",
                "bom_code": "SMP-MAT-01_REV01",
                "line_item_no": 1,
                "material_inventory_code": "MONEL K500*2_D25.4",
                "qty": 32,
                "in_house_production": "N",
            }
        ],
        [],
        [
            {
                "alloc_voucher_no": "IC03384ISA",
                "inventory_code": "MONEL K500*2_D25.4",
                "lot_no": 1,
                "alloc_qty": 384,
                "remain_alloc_qty": 384,
                "issued_alloc_qty": 0,
                "alloc_to_voucher_no": "M057854MPS",
            }
        ],
        [
            {
                "inventory_code": "MONEL K500*2_D25.4",
                "lot_no": 1,
                "reference_no": "M/03992/25",
                "allocation_qty": 384,
                "remaining_qty": 384,
            }
        ],
        {"PART-1": "Finished part", "MONEL K500*2_D25.4": "Monel bar"},
        query="NPS26-0484",
    )

    assert payload["found"] is True
    assert payload["special"] is False
    assert payload["header"]["part_desc"] == "Finished part"
    assert len(payload["lines"]) == 1
    assert payload["lines"][0]["sub_part"] == ""
    material = payload["lines"][0]["materials"][0]
    assert material["inventory_code"] == "MONEL K500*2_D25.4"
    assert material["description"] == "Monel bar"
    assert material["allocations"][0]["batch_no"] == "M/03992/25"
    assert material["allocations"][0]["lot_no"] == 1
    assert material["allocations"][0]["remain_qty"] == 384
    assert material["required_qty"] == 384
    assert payload["header"]["sales_order_no"] == "SO/2600001"
    assert payload["header"]["sales_order_line"] == "1"


def test_special_bom_lists_each_sub_part_line_and_marks_a_shared_material():
    payload = build_trace(
        {
            "pp_voucher_no": "NPS26-0321",
            "inventory_code": "BB14-PARENT",
            "bom_code": "SMP-MAT01-REV00",
            "pp_qty": 30,
            "source_voucher_no": "SO/2602442",
            "source_line_item_no": 1,
        },
        [
            {
                "inventory_code": "BB14-PARENT",
                "line_item_no": 1,
                "material_inventory_code": "BB18-A",
                "qty": 1,
                "in_house_production": "Y",
                "bom_code": "SMP-MAT01-REV00",
            },
            {
                "inventory_code": "BB14-PARENT",
                "line_item_no": 2,
                "material_inventory_code": "BB18-B",
                "qty": 1,
                "in_house_production": "Y",
                "bom_code": "SMP-MAT01-REV00",
            },
            {
                "inventory_code": "BB18-A",
                "line_item_no": 1,
                "material_inventory_code": "RAW-A",
                "qty": 26,
                "in_house_production": "N",
                "bom_code": "SMP-MAT-01_REV00",
            },
            {
                "inventory_code": "BB18-B",
                "line_item_no": 1,
                "material_inventory_code": "RAW-A",
                "qty": 36,
                "in_house_production": "N",
                "bom_code": "SMP-MAT-01_REV00",
            },
        ],
        [
            {
                "process_sheet_no": "NPS26-0321",
                "inventory_code": "BB14-PARENT",
                "type": "FG",
            },
            {
                "process_sheet_no": "NPS26-0321-1",
                "inventory_code": "BB18-A",
                "component_line_item_no": "1",
                "type": "COMP",
                "inventory_main_desc": "Sub A",
            },
            {
                "process_sheet_no": "NPS26-0321-2",
                "inventory_code": "BB18-B",
                "component_line_item_no": "2",
                "type": "COMP",
                "inventory_main_desc": "Sub B",
            },
        ],
        [
            {
                "alloc_voucher_no": "IC1",
                "inventory_code": "RAW-A",
                "lot_no": 2,
                "alloc_qty": 100,
                "remain_alloc_qty": 0,
                "issued_alloc_qty": 100,
                "alloc_to_voucher_no": "M1MPS",
            },
            {
                "alloc_voucher_no": "IC1",
                "inventory_code": "RAW-A",
                "lot_no": 2,
                "alloc_qty": 100,
                "remain_alloc_qty": 0,
                "issued_alloc_qty": 100,
                "alloc_to_voucher_no": "M1MPS",
            },
        ],
        [
            {
                "inventory_code": "RAW-A",
                "lot_no": 2,
                "reference_no": "M/04373/26",
                "allocation_qty": 10,
                "remaining_qty": 0,
            },
            {
                "inventory_code": "RAW-A",
                "lot_no": 2,
                "reference_no": "HEAT-9",
                "allocation_qty": 0,
                "remaining_qty": 0,
            },
        ],
    )

    assert payload["special"] is True
    assert [line["process_sheet_no"] for line in payload["lines"]] == [
        "NPS26-0321-1",
        "NPS26-0321-2",
    ]
    assert payload["lines"][0]["sub_part"] == "BB18-A"
    assert payload["lines"][0]["materials"][0]["inventory_code"] == "RAW-A"
    assert payload["lines"][0]["materials"][0]["shared"] is True
    assert payload["lines"][1]["materials"][0]["shared"] is True
    alloc = payload["lines"][0]["materials"][0]["allocations"][0]
    assert alloc["batch_no"] == "M/04373/26"
    assert alloc["other_refs"] == []
    assert len(payload["lines"][0]["materials"][0]["allocations"]) == 1


def test_focus_keeps_only_the_requested_line_item():
    payload = build_trace(
        {"pp_voucher_no": "NPS26-0321", "inventory_code": "PARENT", "pp_qty": 1},
        [
            {
                "inventory_code": "PARENT",
                "line_item_no": 1,
                "material_inventory_code": "SUB-1",
                "qty": 1,
                "in_house_production": "Y",
            },
            {
                "inventory_code": "PARENT",
                "line_item_no": 2,
                "material_inventory_code": "SUB-2",
                "qty": 1,
                "in_house_production": "Y",
            },
            {
                "inventory_code": "SUB-2",
                "line_item_no": 1,
                "material_inventory_code": "RAW-2",
                "qty": 4,
                "in_house_production": "N",
            },
        ],
        [
            {
                "process_sheet_no": "NPS26-0321-2",
                "inventory_code": "SUB-2",
                "component_line_item_no": "2",
                "type": "COMP",
            }
        ],
        [],
        [],
        focus_process_sheet="NPS26-0321-2",
        query="NPS26-0321-2",
    )
    assert payload["focus_process_sheet"] == "NPS26-0321-2"
    assert len(payload["lines"]) == 1
    assert payload["lines"][0]["sub_part"] == "SUB-2"
    assert payload["lines"][0]["materials"][0]["inventory_code"] == "RAW-2"
    assert payload["lines"][0]["materials"][0]["allocations"] == []


def test_shared_material_keeps_only_the_batch_issued_to_that_job():
    payload = build_trace(
        {"pp_voucher_no": "N26-[SR]22", "inventory_code": "PARENT", "pp_qty": 2},
        [
            {
                "inventory_code": "PARENT",
                "line_item_no": 1,
                "material_inventory_code": "SUB-A",
                "qty": 1,
                "in_house_production": "Y",
            },
            {
                "inventory_code": "PARENT",
                "line_item_no": 3,
                "material_inventory_code": "SUB-C",
                "qty": 1,
                "in_house_production": "Y",
            },
            {
                "inventory_code": "SUB-A",
                "line_item_no": 2,
                "material_inventory_code": "ALU 6061_BAR_CTS",
                "qty": 1,
                "in_house_production": "N",
            },
            {
                "inventory_code": "SUB-C",
                "line_item_no": 2,
                "material_inventory_code": "ALU 6061_BAR_CTS",
                "qty": 1,
                "in_house_production": "N",
            },
        ],
        [
            {"process_sheet_no": "N26-[SR]22-1", "inventory_code": "SUB-A", "component_line_item_no": "1", "type": "COMP"},
            {"process_sheet_no": "N26-[SR]22-3", "inventory_code": "SUB-C", "component_line_item_no": "3", "type": "COMP"},
        ],
        [
            {
                "alloc_voucher_no": "IC-A",
                "inventory_code": "ALU 6061_BAR_CTS",
                "lot_no": 11,
                "alloc_qty": 2,
                "remain_alloc_qty": 0,
                "issued_alloc_qty": 2,
                "alloc_to_voucher_no": "M-A",
                "own_inventory_code": "SUB-A",
                "wo_voucher_no": "MFG-A",
            },
            {
                "alloc_voucher_no": "IC-C",
                "inventory_code": "ALU 6061_BAR_CTS",
                "lot_no": 12,
                "alloc_qty": 2,
                "remain_alloc_qty": 0,
                "issued_alloc_qty": 2,
                "alloc_to_voucher_no": "M-C",
                "own_inventory_code": "SUB-C",
                "wo_voucher_no": "MFG-C",
            },
        ],
        [
            {
                "inventory_code": "ALU 6061_BAR_CTS",
                "lot_no": 11,
                "reference_no": "M/04425/26",
                "allocation_qty": 0,
                "remaining_qty": 0,
            },
            {
                "inventory_code": "ALU 6061_BAR_CTS",
                "lot_no": 11,
                "reference_no": "M/04378/26",
                "allocation_qty": 0,
                "remaining_qty": 0,
            },
        ],
        issued_lots=[
            {
                "own_inventory_code": "SUB-A",
                "mps_voucher_no": "M-A",
                "inventory_code": "ALU 6061_BAR_CTS",
                "lot_no": 11,
                "reference_no": "JOB-BATCH-A",
            }
        ],
    )

    line_a = payload["lines"][0]["materials"][0]
    line_c = payload["lines"][1]["materials"][0]
    assert line_a["shared"] is False
    assert [row["lot_no"] for row in line_a["allocations"]] == [11]
    assert line_a["allocations"][0]["batch_no"] == "JOB-BATCH-A"
    assert line_a["allocations"][0]["work_order_no"] == "MFG-A"
    assert [row["lot_no"] for row in line_c["allocations"]] == [12]
    assert line_c["allocations"][0]["work_order_no"] == "MFG-C"


def test_issued_qty_follows_the_stock_issue_and_required_follows_the_bom():
    payload = build_trace(
        {"pp_voucher_no": "N26-[SR]22", "inventory_code": "PARENT", "pp_qty": 2, "source_voucher_no": "Direct PP", "source_line_item_no": 0},
        [
            {
                "inventory_code": "PARENT",
                "line_item_no": 4,
                "material_inventory_code": "SUB-PIN",
                "qty": 4,
                "in_house_production": "Y",
            },
            {
                "inventory_code": "SUB-PIN",
                "stage_no": 1,
                "line_item_no": 1,
                "material_inventory_code": "SUS316L*6_D25.4",
                "qty": 20,
                "bom_code": "SMP-MAT-01_REV00",
            },
            {
                "inventory_code": "SUB-PIN",
                "stage_no": 6,
                "line_item_no": 1,
                "material_inventory_code": "SUS316L*6_D25.4",
                "qty": 20,
                "bom_code": "MFG00200RW",
            },
        ],
        [
            {"process_sheet_no": "N26-[SR]22-4", "inventory_code": "SUB-PIN", "component_line_item_no": "4", "type": "COMP"},
        ],
        [
            {
                "alloc_voucher_no": "IC03058ISA",
                "inventory_code": "SUS316L*6_D25.4",
                "lot_no": 3,
                "alloc_qty": 160,
                "remain_alloc_qty": 0,
                "issued_alloc_qty": 160,
                "alloc_to_voucher_no": "M052707MPS",
                "own_inventory_code": "SUB-PIN",
                "wo_voucher_no": "MFG62006WO",
            }
        ],
        [
            {
                "inventory_code": "SUS316L*6_D25.4",
                "lot_no": 3,
                "reference_no": "M/04400/26",
                "allocation_qty": 1000,
                "remaining_qty": 1330,
            }
        ],
        issued_lots=[
            {
                "own_inventory_code": "SUB-PIN",
                "mps_voucher_no": "M052707MPS",
                "inventory_code": "SUS316L*6_D25.4",
                "lot_no": 3,
                "reference_no": "M/04371/26",
                "issued_qty": 500,
            }
        ],
    )

    assert payload["header"]["sales_order_no"] == ""
    assert payload["header"]["source_voucher_no"] == "Direct PP"
    assert payload["header"]["source_line"] == ""
    materials = payload["lines"][0]["materials"]
    assert len(materials) == 1
    assert materials[0]["bom_code"] == "SMP-MAT-01_REV00"
    assert materials[0]["qty"] == 20
    assert materials[0]["required_qty"] == 160
    alloc = materials[0]["allocations"][0]
    assert alloc["batch_no"] == "M/04371/26"
    assert alloc["issued_qty"] == 500
    assert alloc["alloc_qty"] == 160


def test_trace_page_and_api():
    client = app.test_client()
    with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
        page = client.get("/process-sheet-trace")
        assert page.status_code == 200
        body = page.get_data(as_text=True)
        assert "Process sheet trace" in body
        assert "pst-view" in body

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "secret"}):
            public_page = client.get("/process-sheet-trace")
            assert public_page.status_code == 200
            legacy = client.get("/planning-data/process-sheet-trace?ps=NPS26-0321")
            assert legacy.status_code == 302
            assert "/process-sheet-trace" in legacy.headers["Location"]

        with patch(
            "planning.process_sheet_trace_route.trace_process_sheet",
            return_value={"found": False, "query": "MISSING", "lines": []},
        ):
            missing = client.get("/api/process-sheet-trace?ps=MISSING")
        assert missing.status_code == 404

        blank = client.get("/api/process-sheet-trace")
        assert blank.status_code == 400
