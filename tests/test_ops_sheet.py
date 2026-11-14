"""OPS Sheet parsing and turnaround-time calculation."""
from __future__ import annotations

import os
from datetime import datetime

import pytest
from openpyxl import Workbook

from app import app
from planning.ops_sheet_scan import (
    compute_tat,
    header_field,
    infer_operations,
    parse_ops_workbook,
)
from planning.ops_sheet_service import OpsSheetError, prepare_line_update

DALIA = (
    r"Z:\Public\OperationsDoc\0. Manufacturing Progress Report"
    r"\Shared SOE Attachment Dump\0.RFQ\RFQ Current"
    r"\20261021_Dalia Life X & Manganese Tender\OPS Sheet (RFQ_20261021).xlsx"
)


def test_header_aliases_map_onto_the_template_fields():
    assert header_field("i-250") == "turn_i250"
    assert header_field("J-210") == "turn_i250"
    assert header_field("5 Axis") == "mill_5axis"
    assert header_field("5 Axis\n(i-800)") == "mill_5axis_i800"
    assert header_field("Thk/Ø") == "raw_thk"
    assert header_field("TAT") is None
    assert header_field("Milling (mins)") is None


def test_remark_tags_set_the_operation_count():
    assert infer_operations("2 TN 2 ML", [30, 90]) == (4, "remarks")
    assert infer_operations("2TN", [60]) == (2, "remarks")
    assert infer_operations("Repeated order MONEL K500*2", [10, 35]) == (2, "cycles")


def test_turnaround_is_cycle_times_qty_plus_setup_times_operations():
    line = _line(qty=10, setup=100, mill_3axis=10, turn_quick=35, ops_auto=2)
    tat = compute_tat(line, [], {})
    assert tat["ops_effective"] == 2
    assert tat["breaks"][0]["minutes"] == 650
    assert tat["breaks"][0]["hours"] == 10.83


def test_extra_columns_join_the_tat_measure():
    line = _line(qty=4, setup=180, turn_quick=60, ops_auto=2, ops_basis="remarks")
    per_piece = compute_tat(line, [{"column_id": 1, "apply_mode": "per_piece"}], {1: 10})
    assert per_piece["breaks"][0]["minutes"] == 640
    per_op = compute_tat(line, [{"column_id": 2, "apply_mode": "per_operation"}], {2: 15})
    assert per_op["breaks"][0]["minutes"] == 630
    flat = compute_tat(line, [{"column_id": 3, "apply_mode": "flat"}], {3: 30})
    assert flat["breaks"][0]["minutes"] == 630


def test_quantity_breaks_each_get_a_turnaround():
    line = _line(qty=8, setup=180, mill_3axis=10, turn_quick=30, ops_auto=3)
    line["qty_breaks"] = [8, 40]
    line["rfq_qty_text"] = "8, 40"
    tat = compute_tat(line, [], {})
    assert [item["minutes"] for item in tat["breaks"]] == [860, 2140]
    assert [item["hours"] for item in tat["breaks"]] == [14.33, 35.67]


def test_workbook_reads_the_time_sheet_and_simple_formulas(tmp_path):
    path = tmp_path / "0. Completed" / "JOB-1" / "OPS Sheet job.xlsx"
    path.parent.mkdir(parents=True)
    _write_ops_sheet(path, [
        ["BB18-KS1217-01", "GUIDE BUSH", 4, "Alloy", "66-KS0014-10", "=7.25*25.4", None, 26, 180, None, None, None, None, 60, None, None, None, None, None, None, None, "No", "2TN", 1500],
    ])
    parsed = parse_ops_workbook(str(path), str(tmp_path))
    assert parsed["status"] == "completed"
    assert parsed["rfq_folder"] == "JOB-1"
    assert parsed["date_in"].isoformat() == "2026-11-06"
    line = parsed["lines"][0]
    assert line["raw_thk"] == 184.15
    assert line["turn_quick"] == 60
    assert line["ops_auto"] == 2
    assert line["nre_text"] == "1500"
    tat = compute_tat(line, [], {})
    assert tat["breaks"][0]["minutes"] == 600
    assert tat["breaks"][0]["hours"] == 10


def test_blank_template_has_no_lines(tmp_path):
    path = tmp_path / "OPS Sheet Rev 2.xlsx"
    _write_ops_sheet(path, [])
    parsed = parse_ops_workbook(str(path), str(tmp_path))
    assert parsed["status"] == "template"
    assert parsed["lines"] == []
    assert parsed["rfq_folder"] == "RFQ Current"


def test_page_renders_the_tat_formula(monkeypatch):
    monkeypatch.setenv("PLANNER_PASSCODE", "")
    monkeypatch.setenv("ADMIN_PASSCODE", "")
    client = app.test_client()
    response = client.get("/ops-sheets")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "RFQ library" in html
    assert "Supply Chain" in html
    assert "Import from RFQ folder" in html
    assert 'href="/ops-sheets"' in html


def test_line_edits_are_checked_before_the_database():
    prepared = prepare_line_update({"rfq_qty_text": "8, 40, 80", "part_number": "BB18-1"})
    assert prepared["rfq_qty"] == 8
    assert prepared["qty_breaks"] == [8.0, 40.0, 80.0]
    with pytest.raises(OpsSheetError):
        prepare_line_update({"not_a_column": "x"})
    with pytest.raises(OpsSheetError):
        prepare_line_update({"setup_mins": -5})


def test_blank_file_name_is_rejected_before_the_database(monkeypatch):
    monkeypatch.setenv("PLANNER_PASSCODE", "")
    client = app.test_client()
    response = client.patch("/api/ops-sheets/files/1", json={"file_name": "   "})
    assert response.status_code == 400
    assert response.get_json()["error"] == "RFQ file name is required."


def test_unknown_line_field_is_rejected_before_the_database(monkeypatch):
    monkeypatch.setenv("PLANNER_PASSCODE", "")
    client = app.test_client()
    response = client.patch("/api/ops-sheets/lines/1", json={"fields": {"not_a_column": "x"}})
    assert response.status_code == 400


def test_blank_extra_column_is_rejected_before_the_database(monkeypatch):
    monkeypatch.setenv("PLANNER_PASSCODE", "")
    client = app.test_client()
    response = client.post("/api/ops-sheets/columns", json={"name": "   ", "apply_mode": "per_piece"})
    assert response.status_code == 400
    assert response.get_json()["error"] == "Column name is required."


def test_bad_operation_count_is_rejected(monkeypatch):
    monkeypatch.setenv("PLANNER_PASSCODE", "")
    client = app.test_client()
    response = client.patch("/api/ops-sheets/lines/1", json={"operation_count": -2})
    assert response.status_code == 400


@pytest.mark.skipif(not os.path.isfile(DALIA), reason="RFQ folder is not mounted")
def test_dalia_sheet_matches_its_tat_formulas():
    parsed = parse_ops_workbook(DALIA, os.path.dirname(os.path.dirname(DALIA)))
    assert parsed["status"] == "current"
    assert parsed["date_in"].isoformat() == "2026-10-26"
    by_row = parsed["lines"]
    guide = by_row[0]
    swivel = next(line for line in by_row if line["part_number"] == "BB94-KS0204-44" and "CAP" not in line["description"])
    cap = next(line for line in by_row if "CAP" in line["description"])
    assert compute_tat(guide, [], {})["breaks"][0] == {
        "qty": 4,
        "minutes": 600,
        "hours": 10,
        "detail": "60 min × 4 + 180 min × 2 ops",
    }
    assert compute_tat(swivel, [], {})["breaks"][0]["minutes"] == 1680
    assert compute_tat(swivel, [], {})["breaks"][0]["hours"] == 28
    assert compute_tat(cap, [], {})["breaks"][0]["minutes"] == 480
    assert compute_tat(cap, [], {})["ops_effective"] == 2


def _line(**values):
    line = {
        "rfq_qty": values.pop("qty"),
        "qty_breaks": [values.get("qty_breaks", None)],
        "setup_mins": values.pop("setup"),
        "ops_auto": values.pop("ops_auto"),
        "ops_basis": values.pop("ops_basis", "cycles"),
        "ops_override": None,
    }
    breaks = values.pop("qty_breaks", None)
    line["qty_breaks"] = [line["rfq_qty"]] if breaks is None else breaks
    line.update(values)
    return line


def _write_ops_sheet(path, data_rows):
    workbook = Workbook()
    time_sheet = workbook.active
    time_sheet.title = "Time"
    time_sheet["B1"] = "Date In:"
    time_sheet["C1"] = datetime(2026, 11, 6)
    time_sheet["E1"] = "Date Out:"
    time_sheet["F1"] = datetime(2026, 11, 6)
    headers_row2 = {
        2: "Part Number",
        3: "Descriptions",
        4: "RFQ QTY",
        5: "Material",
        7: "Raw Material (mm)",
        10: "Setup\n(mins)",
        11: "Milling (mins)",
        15: "Turning (mins)",
        18: "EDM (mins)",
        21: "Backend (mins)",
        23: "Fixture Required",
        24: "Engineering Remarks",
        25: "NRE (SGD)",
    }
    headers_row3 = {
        5: "Type",
        6: "Specification",
        7: "Thk/Ø",
        8: "Width",
        9: "Length",
        11: "3 Axis",
        12: "4 Axis",
        13: "5 Axis",
        14: "5 Axis\n(i-800)",
        15: "Quick Turn",
        16: "J-200",
        17: "i-250",
        18: "Wirecut",
        19: "EDM",
        20: "Superdrill",
        21: "Deburring",
        22: "Cleaning",
    }
    for col, value in headers_row2.items():
        time_sheet.cell(2, col, value)
    for col, value in headers_row3.items():
        time_sheet.cell(3, col, value)
    for offset, values in enumerate(data_rows):
        for col, value in enumerate(values, start=2):
            time_sheet.cell(4 + offset, col, value)
    ignored = workbook.create_sheet("TAT")
    ignored["B2"] = "Part Number"
    ignored["B4"] = "SHOULD-NOT-READ"
    ignored["K4"] = 9999
    workbook.save(path)
