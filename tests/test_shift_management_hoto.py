"""HOTO checklist field normalisation  -  no database."""

from datetime import date

from planning.shift_management_service import (
    HOTO_ATTENDANCE_ROWS,
    HOTO_CHECKLIST_ITEMS,
    _merge_sign,
    blank_hoto_checklist,
    hoto_submit_blockers,
    normalize_hoto_attendance,
    normalize_hoto_items,
)


def test_blank_checklist_matches_the_sheet():
    sheet = blank_hoto_checklist(date(2026, 9, 29), "Day")
    assert sheet["saved"] is False
    assert sheet["shift_out"] == "Day"
    assert sheet["work_date"] == "2026-09-29"
    assert [row["no"] for row in sheet["items"]] == [item["no"] for item in HOTO_CHECKLIST_ITEMS]
    assert all(row["status"] == "" and row["remarks"] == "" for row in sheet["items"])
    assert len(sheet["attendance"]) == HOTO_ATTENDANCE_ROWS
    assert sheet["attendance"][0] == {"no": 1, "name": "", "late": False, "remarks": ""}
    assert sheet["outgoing_sign_name"] == ""
    assert sheet["doc_status"] == "draft"
    assert sheet["locked"] is False


def test_items_keep_known_rows_and_drop_bad_status():
    rows = normalize_hoto_items(
        [
            {"no": 2, "status": "No Issue", "remarks": "  120 pcs  ", "checked_by": "Ah Lim"},
            {"no": 4, "status": "Maybe", "remarks": "open NCR", "checked_by": "Bee"},
            {"no": 5, "status": "Issue Raised", "remarks": "coolant leak"},
            {"no": 99, "status": "Done"},
            "nope",
        ]
    )
    assert len(rows) == 6
    assert rows[1]["status"] == "No Issue"
    assert rows[1]["remarks"] == "120 pcs"
    assert rows[1]["checked_by"] == "Ah Lim"
    assert rows[3]["status"] == ""
    assert rows[3]["remarks"] == "open NCR"
    assert rows[4]["status"] == "Issue Raised"
    assert rows[0]["status"] == ""
    assert HOTO_CHECKLIST_ITEMS[1]["see_href"] == "/erp-scanned-output"
    assert HOTO_CHECKLIST_ITEMS[3]["see_href"] == "/qaqc-view"


def test_attendance_pads_to_eleven_and_reads_late():
    rows = normalize_hoto_attendance(
        [
            {"no": 3, "name": " Ah Lim ", "late": "yes", "remarks": "Medical checkup"},
            {"no": 12, "name": "Extra"},
            {"no": 1, "name": "Bee", "late": False, "remarks": ""},
        ]
    )
    assert len(rows) == 11
    assert rows[0]["name"] == "Bee"
    assert rows[0]["late"] is False
    assert rows[2] == {
        "no": 3,
        "name": "Ah Lim",
        "late": True,
        "remarks": "Medical checkup",
    }
    assert rows[10]["no"] == 11
    assert rows[10]["name"] == ""


def test_signature_stamps_only_when_confirmed():
    name, stamped = _merge_sign("Ah Lim", "", None, confirm=False)
    assert name == "Ah Lim"
    assert stamped is None

    name, stamped = _merge_sign("Ah Lim", "Ah Lim", None, confirm=True)
    assert name == "Ah Lim"
    assert stamped is not None

    name, again = _merge_sign("Ah Lim", "Ah Lim", stamped, confirm=False)
    assert again == stamped

    cleared, cleared_at = _merge_sign("", "Ah Lim", stamped, confirm=False)
    assert cleared == ""
    assert cleared_at is None

    renamed, kept = _merge_sign("Yu Ting", "Ah Lim", stamped, confirm=False)
    assert renamed == "Yu Ting"
    assert kept == stamped


def test_submit_requires_both_reps_and_signatures():
    blank = blank_hoto_checklist(date(2026, 9, 29), "Day")
    assert hoto_submit_blockers(blank) == [
        "Add outgoing shift rep, incoming shift rep, outgoing signature, incoming signature before submitting."
    ]
    ready = dict(blank)
    ready.update(
        {
            "outgoing_supervisor": "Chang Peng",
            "incoming_supervisor": "Yu Ting",
            "outgoing_sign_name": "Chang Peng",
            "incoming_sign_name": "Yu Ting",
        }
    )
    assert hoto_submit_blockers(ready) == []
