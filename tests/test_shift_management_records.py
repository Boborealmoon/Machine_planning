"""Shift record index: one row per filed shift, no database."""

from datetime import date

from planning.shift_management_service import merge_shift_records


def test_merge_groups_report_hoto_and_tickets_for_one_shift():
    items = merge_shift_records(
        reports=[
            {
                "work_date": date(2026, 10, 1),
                "shift_out": "Day",
                "lines": [
                    {"process_sheet_no": "MPS-1", "produced_qty": 4, "description": "Pin"},
                    {"process_sheet_no": ""},
                ],
            }
        ],
        checklists=[
            {
                "work_date": "2026-10-01",
                "shift_out": "Day",
                "doc_status": "submitted",
                "submitted_at": "2026-10-01T20:05",
                "outgoing_supervisor": "Alex",
                "incoming_supervisor": "Bee",
                "submitted_by_name": "Alex",
            }
        ],
        tickets=[
            {
                "work_date": date(2026, 10, 1),
                "shift_out": "Day",
                "ticket_count": 2,
                "open_ticket_count": 1,
            }
        ],
    )
    assert len(items) == 1
    row = items[0]
    assert row["work_date"] == "2026-10-01"
    assert row["shift_out"] == "Day"
    assert row["report_filed"] is True
    assert row["report_line_count"] == 1
    assert row["hoto_status"] == "submitted"
    assert row["hoto_submitted_at"].startswith("2026-10-01T20:05")
    assert row["outgoing_supervisor"] == "Alex"
    assert row["ticket_count"] == 2
    assert row["open_ticket_count"] == 1


def test_blank_report_does_not_invent_a_shift():
    items = merge_shift_records(
        reports=[
            {
                "work_date": "2026-10-01",
                "shift_out": "Night",
                "lines": [{}, {"process_sheet_no": ""}],
            }
        ],
        checklists=[],
        tickets=[{"work_date": "2026-10-01", "shift_out": "Night", "ticket_count": 0}],
    )
    assert items == []


def test_draft_hoto_and_night_sort_ahead_of_day():
    items = merge_shift_records(
        reports=[],
        checklists=[
            {"work_date": "2026-10-01", "shift_out": "Day", "doc_status": "draft"},
            {"work_date": "2026-10-01", "shift_out": "Night", "doc_status": "submitted"},
            {"work_date": "2026-09-30", "shift_out": "Night", "doc_status": "submitted"},
        ],
        tickets=[],
    )
    assert [(row["work_date"], row["shift_out"]) for row in items] == [
        ("2026-10-01", "Night"),
        ("2026-10-01", "Day"),
        ("2026-09-30", "Night"),
    ]
    assert items[1]["hoto_status"] == "draft"
    assert items[1]["report_filed"] is False
