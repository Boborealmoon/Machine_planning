"""Tests for Assembly Parts Tracker (relaxed eligibility + new flags)."""
from flask import Flask

import planning.assembly_parts_route as parts
from planning.assembly_classify import (
    apply_stalled_child_flags,
    build_assembly_jobs,
)
from planning.assembly_parts_route import assembly_parts_bp
from tests.test_assembly_bom_route import _bom_rows, _hierarchy, _root


def test_monitor_still_excludes_leaf_only_components():
    rows = [
        row
        for row in _bom_rows()
        if row["source_inventory_code"] not in {"CHILD-A", "CHILD-B"}
    ]
    assert build_assembly_jobs([_root()], _hierarchy(), rows, require_subassembly_children=True) == []


def test_tracker_keeps_leaf_comp_children():
    rows = [
        row
        for row in _bom_rows()
        if row["source_inventory_code"] not in {"CHILD-A", "CHILD-B"}
    ]
    jobs = build_assembly_jobs(
        [_root()],
        _hierarchy(),
        rows,
        require_subassembly_children=False,
    )
    assert len(jobs) == 1
    job = jobs[0]
    assert job["component_count"] == 3
    assert "leaf_component" in job["flags"]
    assert all(not child["is_subassembly"] for child in job["children"])
    assert "leaf_component" in job["children"][0]["flags"]
    # leaf_component is info, not an anomaly by itself
    assert "leaf_component" not in job["warning_flags"]


def test_tracker_includes_nps_parent_with_only_leaf_comps():
    root = _root(ps_id="NPS26-0321", part_no="ASSY-NEW")
    hierarchy = [
        {
            "pp_voucher_no": "NPS26-0321",
            "process_sheet_no": "NPS26-0321",
            "type": "FG",
            "inventory_code": "ASSY-NEW",
            "sales_order_no": "SO/2600999",
        },
        {
            "pp_voucher_no": "NPS26-0321",
            "process_sheet_no": "NPS26-0321-1",
            "type": "COMP",
            "parent_inventory_code": "ASSY-NEW",
            "inventory_code": "LEAF-PART",
            "component_seq_no": 1,
            "total_qty": 2,
        },
    ]
    parent_bom = [
        {
            "source_inventory_code": "ASSY-NEW",
            "bom_code": "SMP-MAT01-REV00",
            "level": 1,
            "inventory_code": "ASSY-NEW",
            "material_inventory_code": "LEAF-PART",
            "description": "Purchased bush",
            "qty_parent": 1,
            "qty_fg": 1,
            "selected_bom_code": None,
            "in_house_production": "N",
        },
    ]
    jobs = build_assembly_jobs([root], hierarchy, parent_bom, require_subassembly_children=False)
    assert len(jobs) == 1
    assert jobs[0]["ps_id"] == "NPS26-0321"
    assert jobs[0]["children"][0]["process_sheet_no"] == "NPS26-0321-1"
    assert jobs[0]["children"][0]["part_no"] == "LEAF-PART"
    # Strict monitor still excludes
    assert build_assembly_jobs([root], hierarchy, parent_bom, require_subassembly_children=True) == []


def test_orphan_comp_and_qty_mismatch_flags():
    root = _root(partial_qty=5)
    hierarchy = _hierarchy()
    # CHILD-C appears as COMP but not on parent level-1 listing
    hierarchy = hierarchy + [
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053-9",
            "type": "COMP",
            "parent_inventory_code": "KIT-001",
            "inventory_code": "ORPHAN-X",
            "component_seq_no": 9,
            "total_qty": 99,
        }
    ]
    bom = _bom_rows() + [
        {
            "source_inventory_code": "ORPHAN-X",
            "bom_code": "ORPH-BOM",
            "level": 1,
            "inventory_code": "ORPHAN-X",
            "material_inventory_code": "RAW-X",
        }
    ]
    # Force qty mismatch on CHILD-A listing
    for row in bom:
        if row.get("material_inventory_code") == "CHILD-A" and row.get("level") == 1:
            row["qty_fg"] = 1
            row["qty_parent"] = 1

    job = build_assembly_jobs([root], hierarchy, bom, require_subassembly_children=False)[0]
    assert "orphan_comp" in job["flags"]
    orphan = next(c for c in job["children"] if c["part_no"] == "ORPHAN-X")
    assert "orphan_comp" in orphan["flags"]
    # Second CHILD-A has qty 10 vs expected 5 ? mismatch
    assert "qty_mismatch" in job["flags"]


def test_missing_comp_sheet_for_inhouse_listing_part():
    root = _root()
    hierarchy = [
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053",
            "type": "FG",
            "inventory_code": "KIT-001",
        },
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053-1",
            "type": "COMP",
            "parent_inventory_code": "KIT-001",
            "inventory_code": "CHILD-A",
            "component_seq_no": 1,
            "total_qty": 5,
        },
    ]
    bom = [
        {
            "source_inventory_code": "KIT-001",
            "bom_code": "SMP-MAT01-REV00",
            "level": 1,
            "material_inventory_code": "CHILD-A",
            "description": "A",
            "selected_bom_code": "SMP-MAT-01-REV00",
            "in_house_production": "Y",
            "qty_fg": 1,
        },
        {
            "source_inventory_code": "KIT-001",
            "bom_code": "SMP-MAT01-REV00",
            "level": 1,
            "material_inventory_code": "CHILD-MISSING",
            "description": "Missing sheet part",
            "selected_bom_code": "X",
            "in_house_production": "Y",
            "qty_fg": 1,
        },
        {
            "source_inventory_code": "CHILD-A",
            "bom_code": "SMP-MAT-01-REV00",
            "level": 1,
            "material_inventory_code": "RAW-A",
        },
    ]
    job = build_assembly_jobs([root], hierarchy, bom, require_subassembly_children=False)[0]
    assert "missing_comp_sheet" in job["flags"]
    missing = next(c for c in job["children"] if c.get("missing_comp_sheet"))
    assert missing["part_no"] == "CHILD-MISSING"
    assert missing["process_sheet_no"] == ""


def test_stalled_child_when_overdue_and_not_queued():
    job = {
        "flags": ["nested_assembly"],
        "warning_flags": [],
        "due_date": "2020-01-01",
        "is_open": True,
        "children": [
            {
                "process_sheet_no": "APS26-0053-1",
                "status": "Active",
                "due_date": "2020-01-01",
                "in_house": True,
                "queued_machines": [],
                "material_in": False,
                "flags": [],
            }
        ],
    }
    apply_stalled_child_flags(job)
    assert "stalled_child" in job["flags"]
    assert job["children"][0]["stalled"] is True
    assert "stalled_child" in job["warning_flags"]


def test_api_assembly_parts_serializes(monkeypatch):
    sample = build_assembly_jobs(
        [_root()],
        _hierarchy(),
        _bom_rows(),
        require_subassembly_children=False,
    )
    for job in sample:
        job["children_ready"] = 0
        job["children_total"] = len(job["children"])
        job["readiness_label"] = f"0/{job['children_total']}"
        job["has_issues"] = bool(job.get("warning_flags"))
        for child in job["children"]:
            child["material_in"] = False
            child["queued_machines"] = []
            child["needs_scheduling"] = True
            child["ready"] = False
            child["status"] = "Active"
            child["current_stage_desc"] = "CNC"
            child["current_stage_status"] = "R"

    monkeypatch.setattr(
        parts,
        "fetch_assembly_parts",
        lambda refresh=False, view="active": sample,
    )
    app = Flask(__name__, template_folder="../templates")
    app.register_blueprint(assembly_parts_bp)

    response = app.test_client().get("/api/assembly-parts?view=active")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["count"] == 1
    assert payload["child_count"] == 3
    assert payload["items"][0]["ps_id"] == "APS26-0053"
    assert payload["items"][0]["children"][0]["process_sheet_no"] == "APS26-0053-1"
