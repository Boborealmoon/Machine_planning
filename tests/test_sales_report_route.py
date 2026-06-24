"""Sales report route — open-month bucket tests."""
from __future__ import annotations

import unittest
from datetime import date

from planning.sales_report_route import _build_open_month_summary, _build_past_month_summary


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


if __name__ == "__main__":
    unittest.main()
