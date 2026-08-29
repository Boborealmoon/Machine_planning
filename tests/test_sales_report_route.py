"""Sales report route — open-month bucket tests."""
from __future__ import annotations

import unittest
from datetime import date

from planning.sales_report_route import (
    DATE_BASIS_POSTED,
    _build_open_month_summary,
    _build_past_month_summary,
    _build_ytd_grid,
    summarize_open_so_value,
)


class SalesReportOpenMonthTests(unittest.TestCase):
    def test_current_month_partitions_all_outstanding_lines(self):
        start_d = date(2026, 6, 1)
        end_d = date(2026, 6, 30)
        open_lines = [
            {"due_date": "2026-05-15", "remaining_qty": 1, "remaining_value": 100},
            {"due_date": "2026-06-10", "remaining_qty": 2, "remaining_value": 200},
            {"due_date": "2026-08-01", "remaining_qty": 3, "remaining_value": 300},
            {"due_date": None, "remaining_qty": 4, "remaining_value": 400},
        ]

        summary = _build_open_month_summary(open_lines, start_d, end_d)

        self.assertEqual(summary["overdue"]["remaining_value"], 100)
        self.assertEqual(summary["due_this_month"]["remaining_value"], 200)
        self.assertEqual(summary["outstanding_rest"]["remaining_value"], 700)
        self.assertEqual(
            summary["overdue"]["remaining_value"]
            + summary["due_this_month"]["remaining_value"]
            + summary["outstanding_rest"]["remaining_value"],
            1000,
        )


class SalesReportPastMonthTests(unittest.TestCase):
    def test_backlog_uses_original_so_due_not_partial_schedule(self):
        """Partial EDD inside ship month must not reclassify overdue PO as on-time."""
        start_d = date(2026, 2, 1)
        end_d = date(2026, 2, 28)
        shipments = [
            {
                "shipment_date": "2026-02-24",
                "due_date": "2026-01-29",
                "so_due_date": "2025-10-24",
                "qty_issued": 12,
                "total_home_amt": 1818.59,
            },
            {
                "shipment_date": "2026-04-30",
                "due_date": "2026-04-23",
                "so_due_date": "2025-10-24",
                "qty_issued": 40,
                "total_home_amt": 6109.70,
            },
        ]

        summary = _build_past_month_summary(shipments, start_d, end_d)

        self.assertEqual(summary["delivered"]["total_home_amt"], 0)
        self.assertAlmostEqual(summary["backlog_delivered"]["total_home_amt"], 1818.59, places=2)
        self.assertEqual(summary["early_delivered"]["total_home_amt"], 0)


class SalesReportYtdGridTests(unittest.TestCase):
    def test_ytd_grid_includes_mps_row(self):
        open_lines = [
            {
                "process_sheet_no": "MPS26-0001",
                "pp_type": "MPS",
                "due_date": "2026-06-15",
                "remaining_qty": 5,
                "remaining_value": 5000,
            },
        ]
        grid = _build_ytd_grid(open_lines, [], 2026, today=date(2026, 6, 25))
        row_ids = [row["id"] for row in grid["rows"]]
        self.assertIn("MPS", row_ids)
        mps_row = next(row for row in grid["rows"] if row["id"] == "MPS")
        june_cell = next(cell for cell in mps_row["cells"] if cell["month"] == 6)
        self.assertAlmostEqual(float(june_cell.get("on_hand") or 0), 5000.0, places=2)


class SalesReportPostedDateBasisTests(unittest.TestCase):
    def test_open_month_uses_posted_date_not_po_due(self):
        start_d = date(2026, 8, 1)
        end_d = date(2026, 8, 31)
        open_lines = [
            {
                "due_date": "2026-08-20",
                "first_posted_datetime": "2026-05-04",
                "remaining_qty": 1,
                "remaining_value": 100,
            },
            {
                "due_date": "2026-10-01",
                "first_posted_datetime": "2026-08-12",
                "remaining_qty": 2,
                "remaining_value": 200,
            },
            {
                "due_date": "2026-07-01",
                "first_posted_datetime": "2026-09-02",
                "remaining_qty": 3,
                "remaining_value": 300,
            },
        ]

        due_summary = _build_open_month_summary(open_lines, start_d, end_d)
        posted_summary = _build_open_month_summary(
            open_lines, start_d, end_d, basis=DATE_BASIS_POSTED
        )

        self.assertEqual(due_summary["due_this_month"]["remaining_value"], 100)
        self.assertEqual(due_summary["overdue"]["remaining_value"], 300)
        self.assertEqual(posted_summary["due_this_month"]["remaining_value"], 200)
        self.assertEqual(posted_summary["overdue"]["remaining_value"], 100)
        self.assertEqual(posted_summary["outstanding_rest"]["remaining_value"], 300)

    def test_past_month_classifies_shipments_by_posted_date(self):
        start_d = date(2026, 2, 1)
        end_d = date(2026, 2, 28)
        shipments = [
            {
                "shipment_date": "2026-02-10",
                "due_date": "2026-02-20",
                "so_due_date": "2026-02-20",
                "first_posted_datetime": "2026-01-08",
                "qty_issued": 1,
                "total_home_amt": 400,
            },
            {
                "shipment_date": "2026-02-18",
                "due_date": "2026-01-15",
                "so_due_date": "2026-01-15",
                "first_posted_datetime": "2026-02-03",
                "qty_issued": 1,
                "total_home_amt": 250,
            },
        ]

        due_summary = _build_past_month_summary(shipments, start_d, end_d)
        posted_summary = _build_past_month_summary(
            shipments, start_d, end_d, basis=DATE_BASIS_POSTED
        )

        self.assertAlmostEqual(due_summary["delivered"]["total_home_amt"], 400.0, places=2)
        self.assertAlmostEqual(due_summary["backlog_delivered"]["total_home_amt"], 250.0, places=2)
        self.assertAlmostEqual(posted_summary["delivered"]["total_home_amt"], 250.0, places=2)
        self.assertAlmostEqual(posted_summary["backlog_delivered"]["total_home_amt"], 400.0, places=2)

    def test_ytd_grid_current_onhand_follows_posted_month(self):
        open_lines = [
            {
                "process_sheet_no": "APS26-0001",
                "pp_type": "APS",
                "due_date": "2026-08-15",
                "first_posted_datetime": "2026-06-05",
                "remaining_qty": 1,
                "remaining_value": 800,
            },
        ]
        due_grid = _build_ytd_grid(open_lines, [], 2026, today=date(2026, 8, 20))
        posted_grid = _build_ytd_grid(
            open_lines, [], 2026, today=date(2026, 8, 20), basis=DATE_BASIS_POSTED
        )
        aps_due = next(row for row in due_grid["rows"] if row["id"] == "APS")
        aps_posted = next(row for row in posted_grid["rows"] if row["id"] == "APS")
        august_due = next(cell for cell in aps_due["cells"] if cell["month"] == 8)
        august_posted = next(cell for cell in aps_posted["cells"] if cell["month"] == 8)
        june_posted = next(cell for cell in aps_posted["cells"] if cell["month"] == 6)

        self.assertAlmostEqual(float(august_due.get("on_hand") or 0), 800.0, places=2)
        self.assertAlmostEqual(float(august_posted.get("backlog") or 0), 800.0, places=2)
        self.assertAlmostEqual(float(august_posted.get("on_hand") or 0), 0.0, places=2)
        self.assertAlmostEqual(float(june_posted.get("backlog_delivered") or 0), 0.0, places=2)


class SalesReportOpenSoValueTests(unittest.TestCase):
    def test_unique_so_line_remaining_qty_times_home_unit(self):
        rows = [
            {
                "sales_order_no": "SO/1",
                "line_item_no": "1",
                "so_det_qty": 10,
                "remaining_qty": 4,
                "unit_selling_price": 100,
                "line_value_home": 1000,
                "outstanding_balance_home": 400,
                "allocated_remaining_value": 200,
            },
            {
                "sales_order_no": "SO/1",
                "line_item_no": "1",
                "so_det_qty": 10,
                "remaining_qty": 4,
                "unit_selling_price": 100,
                "line_value_home": 1000,
                "outstanding_balance_home": 400,
                "allocated_remaining_value": 200,
            },
            {
                "sales_order_no": "SO/2",
                "line_item_no": "3",
                "so_det_qty": 5,
                "remaining_qty": 5,
                "unit_selling_price": 50,
            },
        ]

        summary = summarize_open_so_value(rows)

        self.assertEqual(summary["so_line_count"], 2)
        self.assertAlmostEqual(summary["line_value_home"], 1250.0, places=2)
        self.assertAlmostEqual(summary["outstanding_balance_home"], 650.0, places=2)
        self.assertAlmostEqual(summary["pct_left"], 52.0, places=1)

    def test_falls_back_to_qty_times_unit_when_named_fields_missing(self):
        summary = summarize_open_so_value(
            [
                {
                    "sales_order_no": "SO/9",
                    "line_item_no": "2",
                    "so_det_qty": 8,
                    "remaining_qty": 2,
                    "unit_selling_price": 12.5,
                }
            ]
        )
        self.assertAlmostEqual(summary["line_value_home"], 100.0, places=2)
        self.assertAlmostEqual(summary["outstanding_balance_home"], 25.0, places=2)
        self.assertAlmostEqual(summary["pct_left"], 25.0, places=1)


if __name__ == "__main__":
    unittest.main()
