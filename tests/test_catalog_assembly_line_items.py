from planning.assembly_classify import (
    attach_catalog_assembly_line_items,
    host_child_ps_id,
    hosted_sr_child_donor_guesses,
    is_component_child_ps,
    parent_ps_id_from_child,
)


def _entry(ps_id, part_no, **overrides):
    row = {
        "ps_id": ps_id,
        "source_ps_id": ps_id,
        "part_no": part_no,
        "part_desc": overrides.pop("part_desc", part_no),
        "inventory_code": part_no,
        "display_qty": 1,
        "source_line_item_no": "1",
        "status": "Outstanding",
        "current_stage_desc": "",
        "execution_status": "",
    }
    row.update(overrides)
    return row


def test_child_ps_ids():
    assert is_component_child_ps("N26-[SR]22") is False
    assert is_component_child_ps("NPS26-0321") is False
    assert is_component_child_ps("NPS26-0321-1") is True
    assert is_component_child_ps("NPS26-0321-10") is True
    assert is_component_child_ps("N26-[SR]22-1") is True
    assert parent_ps_id_from_child("NPS26-0321-10") == "NPS26-0321"
    assert parent_ps_id_from_child("N26-[SR]22") == ""
    assert parent_ps_id_from_child("N26-[SR]22-1") == "N26-[SR]22"
    assert host_child_ps_id("N26-[SR]22", "NPS26-0321-12") == "N26-[SR]22-12"
    assert host_child_ps_id("N26-[SR]22", "NPS26-0321-1") == "N26-[SR]22-1"
    assert hosted_sr_child_donor_guesses("N26-[SR]22-12", ["NPS26-0321", "N26-[SR]22", "NPS26-0321-12"]) == [
        "NPS26-0321-12"
    ]
    assert hosted_sr_child_donor_guesses("NPS26-0321-12", ["NPS26-0321"]) == []


def test_parent_nests_own_comp_line_items():
    entries = [
        _entry("NPS26-0321", "KIT-001"),
        _entry("NPS26-0321-2", "CHILD-B", display_qty=10),
        _entry("NPS26-0321-1", "CHILD-A", display_qty=5),
        _entry("NPS26-0321-10", "CHILD-J", display_qty=3),
    ]
    attach_catalog_assembly_line_items(entries)
    parent = entries[0]
    kids = parent["assembly_line_items"]
    assert parent["assembly_line_item_count"] == 3
    assert [item["process_sheet_no"] for item in kids] == [
        "NPS26-0321-1",
        "NPS26-0321-2",
        "NPS26-0321-10",
    ]
    assert kids[0]["part_no"] == "CHILD-A"
    assert kids[0]["related_from"] == ""
    assert entries[1]["assembly_line_items"] == []


def test_sr_without_comp_sheets_borrows_related_assembly_line_items():
    entries = [
        _entry(
            "N26-[SR]22",
            "BB14-KS0188-05 REV 04",
            source_line_item_no="0",
            status="History",
        ),
        _entry("NPS26-0321", "BB14-KS0188-05 REV 04"),
        _entry("NPS26-0321-1", "BB18-KS1209-02 REV 06", part_desc="3 LEG LOCKING PROBE"),
        _entry("NPS26-0321-2", "BB18-KS1211-04 REV 00"),
    ]
    attach_catalog_assembly_line_items(entries)
    sr = entries[0]
    assert sr["assembly_line_item_count"] == 2
    assert sr["assembly_line_items_related_from"] == "NPS26-0321"
    assert [item["process_sheet_no"] for item in sr["assembly_line_items"]] == [
        "N26-[SR]22-1",
        "N26-[SR]22-2",
    ]
    assert sr["assembly_line_items"][0]["related_from"] == "NPS26-0321"
    assert sr["assembly_line_items"][0]["donor_ps_id"] == "NPS26-0321-1"
    assert sr["assembly_line_items"][0]["source_ps_id"] == "N26-[SR]22-1"
    assert sr["assembly_line_items"][0]["part_no"] == "BB18-KS1209-02 REV 06"
    nps = entries[1]
    assert "assembly_line_items_related_from" not in nps
    assert nps["assembly_line_item_count"] == 2
    assert nps["assembly_line_items"][0]["process_sheet_no"] == "NPS26-0321-1"
    assert nps["assembly_line_items"][0]["related_from"] == ""
    assert nps["assembly_line_items"][0]["source_ps_id"] == "NPS26-0321-1"


def test_borrowed_line_item_op_cards_use_host_ps_id():
    child_card = {
        "card_kind": "single",
        "ps_id": "NPS26-0321-12",
        "source_ps_id": "NPS26-0321-12",
        "job_no": "NPS26-0321-12",
        "source_op_no": "20",
        "operation_name": "Turning 20",
    }
    entries = [
        _entry("N26-[SR]22", "KIT-001"),
        _entry("NPS26-0321", "KIT-001"),
        _entry(
            "NPS26-0321-12",
            "CHILD-L",
            op_cards=[child_card],
            ops=[{"source_ps_id": "NPS26-0321-12", "source_op_no": "20"}],
        ),
    ]
    attach_catalog_assembly_line_items(entries)
    kid = entries[0]["assembly_line_items"][0]
    assert kid["process_sheet_no"] == "N26-[SR]22-12"
    assert kid["donor_ps_id"] == "NPS26-0321-12"
    assert kid["op_cards"][0]["ps_id"] == "N26-[SR]22-12"
    assert kid["op_cards"][0]["source_ps_id"] == "N26-[SR]22-12"
    assert kid["op_cards"][0]["donor_ps_id"] == "NPS26-0321-12"
    assert kid["ops"][0]["source_ps_id"] == "N26-[SR]22-12"
    assert entries[2]["op_cards"][0]["source_ps_id"] == "NPS26-0321-12"
    assert entries[2]["ops"][0]["source_ps_id"] == "NPS26-0321-12"


def test_own_children_win_over_related_root():
    entries = [
        _entry("N26-[SR]22", "KIT-001"),
        _entry("N26-[SR]22-1", "SR-CHILD"),
        _entry("NPS26-0321", "KIT-001"),
        _entry("NPS26-0321-1", "NPS-CHILD"),
    ]
    attach_catalog_assembly_line_items(entries)
    sr = entries[0]
    assert [item["process_sheet_no"] for item in sr["assembly_line_items"]] == ["N26-[SR]22-1"]
    assert "assembly_line_items_related_from" not in sr


def test_empty_own_children_borrow_donor_ops():
    child_card = {
        "card_kind": "single",
        "ps_id": "NPS26-0321-10",
        "source_ps_id": "NPS26-0321-10",
        "source_op_no": "20",
        "operation_name": "Turning",
    }
    entries = [
        _entry("N26-[SR]22", "KIT-001"),
        _entry("N26-[SR]22-10", "SR-CHILD"),
        _entry("NPS26-0321", "KIT-001"),
        _entry(
            "NPS26-0321-10",
            "NPS-CHILD",
            op_cards=[child_card],
            ops=[{"source_ps_id": "NPS26-0321-10", "source_op_no": "20", "op_type": "Turning"}],
        ),
    ]
    attach_catalog_assembly_line_items(entries)
    sr = entries[0]
    assert [item["process_sheet_no"] for item in sr["assembly_line_items"]] == ["N26-[SR]22-10"]
    assert sr["assembly_line_items_related_from"] == "NPS26-0321"
    kid = sr["assembly_line_items"][0]
    assert kid["donor_ps_id"] == "NPS26-0321-10"
    assert kid["op_cards"][0]["source_op_no"] == "20"
    assert kid["op_cards"][0]["ps_id"] == "N26-[SR]22-10"
    assert kid["op_cards"][0]["donor_ps_id"] == "NPS26-0321-10"


def test_line_items_copy_child_bom_op_cards():
    child_card = {
        "card_kind": "single",
        "ps_id": "NPS26-0321-1",
        "source_ps_id": "NPS26-0321-1",
        "source_op_no": "20",
        "operation_name": "Turning 20",
        "remaining_qty": 4,
        "cycle_minutes_per_qty": 4.5,
        "setup_minutes": 30,
    }
    child_op = {
        "source_op_no": "20",
        "op_type": "Turning",
        "cycle_time": 4.5,
        "setup_time": 30,
    }
    entries = [
        _entry("NPS26-0321", "KIT-001"),
        _entry(
            "NPS26-0321-1",
            "CHILD-A",
            display_qty=4,
            selected_bom_code="SMP-MAT-01_REV00",
            erp_bom_code="SMP-MAT01-REV00",
            current_stage_no=20,
            op_cards=[child_card],
            ops=[child_op],
            all_ops=[child_op],
        ),
    ]
    attach_catalog_assembly_line_items(entries)
    kid = entries[0]["assembly_line_items"][0]
    assert kid["ps_id"] == "NPS26-0321-1"
    assert kid["selected_bom_code"] == "SMP-MAT-01_REV00"
    assert kid["erp_bom_code"] == "SMP-MAT01-REV00"
    assert kid["op_cards"] == [child_card]
    assert kid["op_cards"][0]["cycle_minutes_per_qty"] == 4.5
    assert kid["ops"][0]["cycle_time"] == 4.5
    assert kid["all_ops"][0]["setup_time"] == 30
    assert kid["op_cards"][0]["operation_name"] == "Turning 20"


def test_duplicate_partial_rows_dedupe_to_one_line_item():
    entries = [
        _entry("NPS26-0321", "KIT-001"),
        _entry("NPS26-0321-4", "CHILD-D", pp_partial_no=2, display_qty=4),
        _entry("NPS26-0321-4", "CHILD-D", pp_partial_no=1, display_qty=8),
    ]
    attach_catalog_assembly_line_items(entries)
    kids = entries[0]["assembly_line_items"]
    assert len(kids) == 1
    assert kids[0]["process_sheet_no"] == "NPS26-0321-4"
    assert kids[0]["qty"] == 8


def test_stamp_inventory_bom_ops_fills_nested_sr_child():
    from unittest.mock import patch

    from planning.catalog import stamp_inventory_bom_ops

    child = {
        "process_sheet_no": "N26-[SR]22-1",
        "ps_id": "N26-[SR]22-1",
        "part_no": "BB18-KS1209-02 REV 06",
        "inventory_code": "BB18-KS1209-02 REV 06",
        "display_qty": 4,
        "op_cards": [],
        "ops": [],
    }
    parent = {
        "ps_id": "N26-[SR]22",
        "op_cards": [{"operation_name": "Turning 20", "compatible_machine_group": "TURNING"}],
        "assembly_line_items": [child],
    }
    stages = {
        "BB18-KS1209-02": [
            {
                "inventory_code": "BB18-KS1209-02",
                "bom_code": "SMP-MAT-01_REV00",
                "stage_no": 10,
                "stage_desc": "Issue/ Verification",
            },
            {
                "inventory_code": "BB18-KS1209-02",
                "bom_code": "SMP-MAT-01_REV00",
                "stage_no": 20,
                "stage_desc": "Turnmill 20",
            },
            {
                "inventory_code": "BB18-KS1209-02",
                "bom_code": "SMP-MAT-01_REV00",
                "stage_no": 30,
                "stage_desc": "Turnmill 30",
            },
            {
                "inventory_code": "BB18-KS1209-02",
                "bom_code": "SMP-MAT-01_REV00",
                "stage_no": 40,
                "stage_desc": "Deburring",
            },
        ]
    }
    with patch("planning.flows.erp_domain_bom_stages_by_inventory", return_value=stages) as lookup:
        stamp_inventory_bom_ops([parent])
    lookup.assert_called_once()
    names = [card["operation_name"] for card in child["op_cards"]]
    assert names == ["Turnmill 20", "Turnmill 30"]
    assert child["ops"][0]["source_kind"] == "ERP_BOM"
    assert child["selected_bom_code"] == "SMP-MAT-01_REV00"
    assert child["op_cards"][0]["remaining_qty"] == 4
    assert parent["op_cards"][0]["operation_name"] == "Turning 20"


def test_stamp_inventory_bom_ops_fills_root_nps_with_rev_and_placeholder_voucher():
    from unittest.mock import patch

    from planning.catalog import stamp_inventory_bom_ops

    entry = {
        "ps_id": "NPS26-0465",
        "source_ps_id": "NPS26-0465",
        "part_no": "BB18-KS1526-02 REV 03",
        "inventory_code": "BB18-KS1526-02 REV 03",
        "bom_code": "PGM & TOOL LIST",
        "erp_bom_code": "PGM & TOOL LIST",
        "display_qty": 17,
        "op_cards": [],
        "ops": [],
        "flow_options": [],
    }
    stages = {
        "BB18-KS1526-02": [
            {
                "inventory_code": "BB18-KS1526-02",
                "bom_code": "SMP-MAT-01-REV00",
                "stage_no": 1,
                "stage_desc": "Issue/ Verification",
            },
            {
                "inventory_code": "BB18-KS1526-02",
                "bom_code": "SMP-MAT-01-REV00",
                "stage_no": 2,
                "stage_desc": "Turning 20",
            },
            {
                "inventory_code": "BB18-KS1526-02",
                "bom_code": "SMP-MAT-01-REV00",
                "stage_no": 3,
                "stage_desc": "Turning 25",
            },
            {
                "inventory_code": "BB18-KS1526-02",
                "bom_code": "SMP-MAT-01-REV00",
                "stage_no": 4,
                "stage_desc": "Turnmill 30",
            },
            {
                "inventory_code": "BB18-KS1526-02",
                "bom_code": "SMP-MAT-01-REV00",
                "stage_no": 5,
                "stage_desc": "Turnmill 40",
            },
        ]
    }
    with patch("planning.flows.erp_domain_bom_stages_by_inventory", return_value=stages) as lookup:
        stamp_inventory_bom_ops([entry])
    lookup.assert_called_once()
    names = [card["operation_name"] for card in entry["op_cards"]]
    assert names == ["Turning 20", "Turning 25", "Turnmill 30", "Turnmill 40"]
    assert entry["selected_bom_code"] == "SMP-MAT-01-REV00"
    assert entry["erp_bom_code"] == "SMP-MAT-01-REV00"
    assert any((flow.get("bom_code") or "") == "SMP-MAT-01-REV00" for flow in entry["flow_options"])


def test_preferred_machining_bom_picks_turnmill_route():
    from planning.flows import preferred_machining_bom_code

    rows = [
        {"bom_code": "SMP-MAT-01_REV00", "stage_desc": "Issue/ Verification"},
        {"bom_code": "SMP-MAT-01_REV00", "stage_desc": "Turnmill 20"},
        {"bom_code": "SMP-MAT-01_REV00", "stage_desc": "Turnmill 30"},
        {"bom_code": "PACK-ONLY", "stage_desc": "Packing & Engraving"},
    ]
    assert preferred_machining_bom_code(rows) == "SMP-MAT-01_REV00"
    assert preferred_machining_bom_code([]) == ""
    assert preferred_machining_bom_code(
        [{"bom_code": "PACK-ONLY", "stage_desc": "Packing & Engraving"}]
    ) == ""
    assert preferred_machining_bom_code(
        [
            {"bom_code": "ALT-MAT-01_REV00", "stage_desc": "Turning 20"},
            {"bom_code": "SMP-MAT-01_REV00", "stage_desc": "Turning 20"},
            {"bom_code": "SMP-MAT-01_REV00", "stage_desc": "Material issue"},
        ]
    ) == "SMP-MAT-01_REV00"
