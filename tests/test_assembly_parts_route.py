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


def test_serialize_overlay_date_accepts_date_and_datetime():
    from datetime import date, datetime

    assert parts._serialize_overlay_date(None) is None
    assert parts._serialize_overlay_date(date(2026, 8, 6)) == "2026-08-06"
    assert (
        parts._serialize_overlay_date(datetime(2026, 8, 6, 13, 14, 15))
        == "2026-08-06 13:14:15"
    )
    assert parts._serialize_overlay_date("2026-08-06") == "2026-08-06"


def test_json_safe_decimal_and_date():
    from datetime import date
    from decimal import Decimal

    payload = parts._json_safe(
        {
            "so_det_qty": Decimal("12.5"),
            "due": date(2026, 8, 14),
            "children": [{"qty_shipped": Decimal("1")}],
        }
    )
    assert payload["so_det_qty"] == 12.5
    assert payload["due"] == "2026-08-14"
    assert payload["children"][0]["qty_shipped"] == 1.0


def test_complete_view_uses_planner_cache_not_live(monkeypatch):
    hierarchy = [
        {
            "type": "FG",
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053",
            "inventory_code": "KIT-001",
            "total_qty": 5,
        },
        {
            "type": "COMP",
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053-1",
            "inventory_code": "CHILD-A",
            "total_qty": 5,
        },
    ]

    monkeypatch.setattr(
        parts,
        "_load_complete_from_cache",
        lambda: ([_root(status="History")], hierarchy),
    )
    monkeypatch.setattr(parts, "_load_bom", lambda part_nos, view: [])
    monkeypatch.setattr(
        parts,
        "_timed_live_query",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("live ERP should not run")),
    )
    monkeypatch.setattr(parts, "_enrich_families", lambda jobs: jobs)

    jobs = parts._fetch_assembly_parts_uncached(view="complete")
    assert len(jobs) == 1
    assert jobs[0]["children"][0]["process_sheet_no"] == "APS26-0053-1"


def test_query_failed_timeout_message():
    class QueryCanceled(Exception):
        pass

    assert parts._query_failed_timeout(QueryCanceled("canceling statement due to statement timeout"))
    assert parts._query_failed_timeout(RuntimeError("other")) is None


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
            child["material_in_date"] = None
            child["material_subcon"] = ""
            child["remark"] = ""
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


def test_sr_ids_are_roots_not_children():
    assert parts._is_component_child_ps("N26-[SR]22") is False
    assert parts._is_component_child_ps("NPS26-0321") is False
    assert parts._is_component_child_ps("NPS26-0321-1") is True
    assert parts._is_component_child_ps("N26-[SR]22-1") is True
    assert parts._job_ps_type("N26-[SR]22") == "SR"
    assert parts._job_ps_type("NPS26-0321") == "NPS"


def test_related_process_sheets_surface_sr_sibling():
    jobs = [
        {
            "ps_id": "NPS26-0321",
            "part_no": "BB14-KS0188-05 REV 04",
            "children": [{"process_sheet_no": "NPS26-0321-1"}],
        }
    ]
    related_rows = [
        {
            "ps_id": "NPS26-0321",
            "part_no": "BB14-KS0188-05 REV 04",
            "status": "Outstanding",
            "sales_order_no": "SO/2602442",
        },
        {
            "ps_id": "N26-[SR]22",
            "part_no": "BB14-KS0188-05 REV 04",
            "status": "History",
            "sales_order_no": "Direct PP",
            "due_date": "2026-10-20",
        },
        {
            "ps_id": "NPS26-0321-17",
            "part_no": "BB14-KS0188-05 REV 04",
            "status": "Outstanding",
        },
    ]
    parts.attach_related_process_sheets(jobs, related_rows)
    job = jobs[0]
    assert job["ps_type"] == "NPS"
    assert [item["ps_id"] for item in job["related_process_sheets"]] == ["N26-[SR]22"]
    related = job["related_process_sheets"][0]
    assert related["ps_type"] == "SR"
    assert related["status"] == "History"
    assert related["process_sheets_url"] == "/process-sheets?q=N26-[SR]22"


def test_open_and_complete_sql_include_sr():
    from planning.assembly_bom_route import _OPEN_ROOT_SQL, assembly_ps_id_sql

    assert "[SR]" in assembly_ps_id_sql("c.ps_id")
    assert "[SR]" in _OPEN_ROOT_SQL
    assert "[SR]" in parts._COMPLETE_CHILD_CACHE_SQL
    assert "UPPER(TRIM(c.part_no)) = ANY(%s)" in parts._RELATED_ROOTS_SQL
