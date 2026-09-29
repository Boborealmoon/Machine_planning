"""Shift windows for handover scans: day 08:01-20:00, night 20:01-08:00."""

from datetime import date, datetime

from planning.shift_management_report import build_shift_report_pdf
from planning.shift_management_service import (
    _guess_shift,
    group_scans_by_machine,
    shift_scan_bounds,
    shift_window_label,
)
from planning.utils import PLANNER_TZ


def test_day_window_is_0801_through_2000():
    start, end = shift_scan_bounds(date(2026, 9, 29), "Day")
    assert start == datetime(2026, 9, 29, 8, 1, tzinfo=PLANNER_TZ)
    assert end == datetime(2026, 9, 29, 20, 1, tzinfo=PLANNER_TZ)
    assert shift_window_label(date(2026, 9, 29), "Day") == "2026-09-29 08:01 to 2026-09-29 20:00"


def test_night_window_crosses_midnight():
    start, end = shift_scan_bounds(date(2026, 9, 29), "Night")
    assert start == datetime(2026, 9, 29, 20, 1, tzinfo=PLANNER_TZ)
    assert end == datetime(2026, 9, 30, 8, 1, tzinfo=PLANNER_TZ)
    assert shift_window_label(date(2026, 9, 29), "Night") == "2026-09-29 20:01 to 2026-09-30 08:00"


def test_guess_shift_keeps_closing_minute_on_the_outgoing_shift():
    assert _guess_shift(datetime(2026, 9, 29, 8, 0, 30, tzinfo=PLANNER_TZ)) == "Night"
    assert _guess_shift(datetime(2026, 9, 29, 8, 1, tzinfo=PLANNER_TZ)) == "Day"
    assert _guess_shift(datetime(2026, 9, 29, 20, 0, 30, tzinfo=PLANNER_TZ)) == "Day"
    assert _guess_shift(datetime(2026, 9, 29, 20, 1, tzinfo=PLANNER_TZ)) == "Night"


def test_group_scans_sums_qty_per_machine():
    grouped = group_scans_by_machine(
        [
            {"machine_no": "CNC 10", "qty_jump": 2, "rej_jump": 1},
            {"machine_no": "CNC 15", "qty_jump": 5, "rej_jump": 0},
            {"machine_no": "CNC 10", "qty_jump": 3, "rej_jump": 0},
        ]
    )
    assert [row["machine_no"] for row in grouped] == ["CNC 10", "CNC 15"]
    assert grouped[0]["qty"] == 5
    assert grouped[0]["reject"] == 1
    assert len(grouped[0]["scans"]) == 2


def test_report_pdf_builds_from_scans():
    pdf = build_shift_report_pdf(
        {
            "work_date": "2026-09-29",
            "shift_out": "Night",
            "shift_in": "Day",
            "window_label": "2026-09-29 20:01 to 2026-09-30 08:00",
            "generated_at": "2026-09-30 08:05",
            "summary": {
                "scan_count": 1,
                "scanned_qty": 4,
                "scanned_reject": 0,
                "scanned_machines": 1,
                "machines": 0,
                "pending_ack": 0,
                "open_tickets": 0,
                "urgent_jobs": 0,
                "open_ncrs": 0,
            },
            "scan_groups": [
                {
                    "machine_no": "CNC 10",
                    "qty": 4,
                    "reject": 0,
                    "scans": [
                        {
                            "scanned_at_label": "2026-09-29 21:15",
                            "process_sheet_no": "APS26-0298",
                            "op_no": "20",
                            "qty_jump": 4,
                            "rej_jump": 0,
                        }
                    ],
                }
            ],
            "handovers": [],
            "tickets": [],
        }
    )
    assert pdf.startswith(b"%PDF")
