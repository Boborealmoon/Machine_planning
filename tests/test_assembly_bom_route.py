from flask import Flask

import planning.assembly_bom_route as assembly
from planning.assembly_bom_route import (
    assembly_bom_bp,
    bom_code_match_key,
    build_assembly_jobs,
    is_open_root,
)


def _root(**overrides):
    row = {
        "ps_id": "APS26-0053",
        "pp_partial_no": 1,
        "part_no": "KIT-001",
        "part_desc": "Assembly kit",
        "bom_code": "SMP-MAT01-REV00",
        "status": "Active",
        "partial_qty": 5,
        "qty_shipped": 0,
        "so_det_qty": 5,
        "sales_order_no": "SO/2600874",
    }
    row.update(overrides)
    return row


def _hierarchy():
    return [
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053",
            "type": "FG",
            "inventory_code": "KIT-001",
            "sales_order_no": "SO/2600874",
        },
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053-1",
            "type": "COMP",
            "parent_inventory_code": "KIT-001",
            "inventory_code": "CHILD-A",
            "component_seq_no": 1,
            "component_link_no": "1",
            "total_qty": 5,
        },
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053-2",
            "type": "COMP",
            "parent_inventory_code": "KIT-001",
            "inventory_code": "CHILD-A",
            "component_seq_no": 2,
            "component_link_no": "2",
            "total_qty": 10,
        },
        {
            "pp_voucher_no": "APS26-0053",
            "process_sheet_no": "APS26-0053-3",
            "type": "COMP",
            "parent_inventory_code": "KIT-001",
            "inventory_code": "CHILD-B",
            "component_seq_no": 3,
            "component_link_no": "3",
            "total_qty": 5,
        },
    ]


def _bom_rows():
    return [
        {
            "source_inventory_code": "KIT-001",
            "bom_code": "SMP-MAT01-REV00",
            "level": 1,
            "inventory_code": "KIT-001",
            "material_inventory_code": "CHILD-A",
            "description": "Machined bush",
            "selected_bom_code": "SMP-MAT-01_REV00",
            "in_house_production": "Y",
        },
        {
            "source_inventory_code": "KIT-001",
            "bom_code": "SMP-MAT01-REV00",
            "level": 1,
            "inventory_code": "KIT-001",
            "material_inventory_code": "CHILD-B",
            "description": "Machined sleeve",
            "selected_bom_code": None,
            "in_house_production": "Y",
        },
        {
            "source_inventory_code": "KIT-001",
            "bom_code": "SMP-MAT01-REV00",
            "level": 2,
            "inventory_code": "CHILD-A",
            "material_inventory_code": "RAW-A",
            "in_house_production": "N",
        },
        {
            "source_inventory_code": "CHILD-A",
            "bom_code": "SMP-MAT-01-REV00",
            "level": 1,
            "inventory_code": "CHILD-A",
            "material_inventory_code": "RAW-A",
        },
        {
            "source_inventory_code": "CHILD-A",
            "bom_code": "ALT-MAT01-REV00",
            "level": 1,
            "inventory_code": "CHILD-A",
            "material_inventory_code": "RAW-ALT",
        },
        {
            "source_inventory_code": "CHILD-B",
            "bom_code": "SMP-MAT01-REV00",
            "level": 1,
            "inventory_code": "CHILD-B",
            "material_inventory_code": "RAW-B",
        },
    ]


def test_open_root_filters_history_and_fully_shipped():
    assert is_open_root(_root())
    assert not is_open_root(_root(status="History"))
    assert not is_open_root(_root(qty_shipped=5))
    assert is_open_root(_root(so_det_qty=None, qty_shipped=99))


def test_bom_code_normalization_handles_hyphen_underscore_aliases():
    assert bom_code_match_key("SMP-MAT-01_REV00") == bom_code_match_key("SMP-MAT-01-REV00")
    assert bom_code_match_key("SMP-MAT01-REV00") == bom_code_match_key("SMP-MAT-01_REV00")


def test_build_groups_fg_components_and_derives_flags():
    jobs = build_assembly_jobs([_root()], _hierarchy(), _bom_rows())

    assert len(jobs) == 1
    job = jobs[0]
    assert job["component_count"] == 3
    assert job["distinct_child_count"] == 2
    assert job["max_depth"] == 2
    assert {"multiple_boms", "missing_bom", "bom_alias", "repeated_component"} <= set(job["flags"])
    assert job["has_anomaly"] is True
    first = job["children"][0]
    assert first["process_sheet_no"] == "APS26-0053-1"
    assert first["route_status"] == "alias"
    assert first["resolved_bom_code"] == "SMP-MAT-01-REV00"
    assert first["leaf_materials"] == ["RAW-A"]


def test_unresolved_selected_route_is_flagged():
    bom_rows = _bom_rows()
    bom_rows[0]["selected_bom_code"] = "UNKNOWN-REV99"

    job = build_assembly_jobs([_root()], _hierarchy(), bom_rows)[0]

    assert "unresolved_bom" in job["flags"]
    assert job["children"][0]["route_status"] == "unresolved"


def test_inhouse_marker_is_context_not_a_subassembly_requirement():
    rows = _bom_rows()
    for row in rows:
        if row["source_inventory_code"] == "KIT-001" and row.get("level") == 1:
            row["in_house_production"] = "N"

    job = build_assembly_jobs([_root()], _hierarchy(), rows)[0]
    assert job["children"]
    assert all(child["in_house"] is False for child in job["children"])


def test_component_without_its_own_bom_is_not_a_subassembly():
    rows = [
        row
        for row in _bom_rows()
        if row["source_inventory_code"] not in {"CHILD-A", "CHILD-B"}
    ]

    assert build_assembly_jobs([_root()], _hierarchy(), rows) == []


def test_include_history_merges_live_open_job_missing_from_staged_bom(monkeypatch):
    assembly._cache.clear()
    live_job = {"ps_id": "NPS26-0321", "due_date": "2027-01-18", "has_anomaly": True}
    hist_job = {"ps_id": "APS26-0053", "due_date": "2025-03-21", "has_anomaly": False}
    monkeypatch.setattr(assembly, "_fetch_assembly_jobs_uncached", lambda: [live_job])
    monkeypatch.setattr(
        assembly,
        "_fetch_historical_assembly_jobs_uncached",
        lambda: [hist_job],
    )

    jobs = assembly.fetch_assembly_jobs(refresh=True, include_history=True)

    assert [job["ps_id"] for job in jobs] == ["APS26-0053", "NPS26-0321"]


def test_include_history_prefers_live_open_over_duplicate_history(monkeypatch):
    assembly._cache.clear()
    live_job = {"ps_id": "APS26-0053", "due_date": "2025-03-21", "source": "live"}
    hist_job = {"ps_id": "APS26-0053", "due_date": "2025-03-21", "source": "history"}
    monkeypatch.setattr(assembly, "_fetch_assembly_jobs_uncached", lambda: [live_job])
    monkeypatch.setattr(
        assembly,
        "_fetch_historical_assembly_jobs_uncached",
        lambda: [hist_job],
    )

    jobs = assembly.fetch_assembly_jobs(refresh=True, include_history=True)

    assert len(jobs) == 1
    assert jobs[0]["source"] == "live"


def test_include_history_false_is_live_open_only(monkeypatch):
    assembly._cache.clear()
    live_job = {"ps_id": "NPS26-0321", "due_date": "2027-01-18"}
    monkeypatch.setattr(assembly, "_fetch_assembly_jobs_uncached", lambda: [live_job])
    monkeypatch.setattr(
        assembly,
        "_fetch_historical_assembly_jobs_uncached",
        lambda: (_ for _ in ()).throw(AssertionError("history should not run")),
    )

    jobs = assembly.fetch_assembly_jobs(refresh=True, include_history=False)

    assert [job["ps_id"] for job in jobs] == ["NPS26-0321"]


def test_include_history_keeps_staged_when_live_open_fails(monkeypatch):
    assembly._cache.clear()
    hist_job = {"ps_id": "APS26-0053", "due_date": "2025-03-21"}

    def _boom():
        raise RuntimeError("COMAIN down")

    monkeypatch.setattr(assembly, "_fetch_assembly_jobs_uncached", _boom)
    monkeypatch.setattr(
        assembly,
        "_fetch_historical_assembly_jobs_uncached",
        lambda: [hist_job],
    )

    jobs = assembly.fetch_assembly_jobs(refresh=True, include_history=True)

    assert [job["ps_id"] for job in jobs] == ["APS26-0053"]


def test_api_serializes_assembly_items(monkeypatch):
    sample = build_assembly_jobs([_root()], _hierarchy(), _bom_rows())
    monkeypatch.setattr(
        assembly,
        "fetch_assembly_jobs",
        lambda refresh=False, include_history=True: sample,
    )
    app = Flask(__name__, template_folder="../templates")
    app.register_blueprint(assembly_bom_bp)

    response = app.test_client().get("/api/assembly-boms")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["count"] == 1
    assert payload["anomaly_count"] == 1
    assert payload["include_history"] is True
    assert payload["items"][0]["ps_id"] == "APS26-0053"
