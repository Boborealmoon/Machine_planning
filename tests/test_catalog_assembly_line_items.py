from planning.assembly_classify import (
    attach_catalog_assembly_line_items,
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
        "NPS26-0321-1",
        "NPS26-0321-2",
    ]
    assert sr["assembly_line_items"][0]["related_from"] == "NPS26-0321"
    assert sr["assembly_line_items"][0]["part_no"] == "BB18-KS1209-02 REV 06"
    nps = entries[1]
    assert "assembly_line_items_related_from" not in nps
    assert nps["assembly_line_item_count"] == 2
    assert nps["assembly_line_items"][0]["related_from"] == ""


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
