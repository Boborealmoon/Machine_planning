"""Sales report allocation regression tests."""
from __future__ import annotations

import unittest

from planning.sales_report_alloc import (
    allocate_so_line_remaining,
    assign_shipment_partials,
    attribute_shipments,
    index_pp_jobs_by_so_line,
    sum_field,
)


class SalesReportAllocationTests(unittest.TestCase):
    def test_open_value_month_ownership_uses_so_due_date_not_pp_schedule_date(self):
        so_line = {
            "sales_order_no": "SO/1",
            "line_item_no": "1",
            "remaining_qty": 10,
            "remaining_value": 1000,
            "unit_selling_price": 100,
            "due_date": "2026-08-20",
            "inventory_code": "PART-1",
            "customer_name": "Customer",
        }
        pp_jobs = [
            {
                "pp_voucher_no": "APS26-0001",
                "process_sheet_no": "APS26-0001",
                "inventory_code": "PART-1",
                "pp_qty": 10,
                "production_due_date": "2026-06-28",
                "proposed_edd": "2026-06-25",
                "so_due_date": "2026-08-20",
            }
        ]

        allocated = allocate_so_line_remaining(so_line, pp_jobs)

        self.assertEqual(len(allocated), 1)
        self.assertEqual(allocated[0]["due_date"], "2026-08-20")
        self.assertEqual(allocated[0]["schedule_due_date"], "2026-06-25")

    def test_partial_expansion_keeps_so_due_month_ownership(self):
        so_line = {
            "sales_order_no": "SO/2",
            "line_item_no": "1",
            "remaining_qty": 10,
            "remaining_value": 1000,
            "unit_selling_price": 100,
            "due_date": "2026-09-15",
            "inventory_code": "PART-2",
        }
        pp_jobs = [
            {
                "pp_voucher_no": "NPS26-0002",
                "process_sheet_no": "NPS26-0002",
                "inventory_code": "PART-2",
                "pp_qty": 10,
                "production_due_date": "2026-07-20",
                "so_due_date": "2026-09-15",
            }
        ]
        partials_by_voucher = {
            "NPS26-0002": [
                {"pp_partial_no": 1, "partial_qty": 4, "production_due_date": "2026-07-05"},
                {"pp_partial_no": 2, "partial_qty": 6, "production_due_date": "2026-07-18"},
            ]
        }

        allocated = allocate_so_line_remaining(
            so_line,
            pp_jobs,
            partials_by_voucher=partials_by_voucher,
        )

        self.assertEqual(len(allocated), 2)
        self.assertTrue(all(row["due_date"] == "2026-09-15" for row in allocated))
        self.assertEqual(
            [row["schedule_due_date"] for row in allocated],
            ["2026-07-05", "2026-07-18"],
        )

    def test_shipment_partial_match_preserves_total_home_amt(self):
        partials_by_voucher = {
            "NPS25-0278": [
                {"pp_partial_no": 1, "partial_qty": 12, "proposed_edd": "2026-01-29"},
                {"pp_partial_no": 2, "partial_qty": 40, "proposed_edd": "2026-04-23"},
            ]
        }
        shipments = [
            {
                "sales_order_no": "SO/2502224",
                "line_item_no": "9",
                "pp_voucher_no": "NPS25-0278",
                "process_sheet_no": "NPS25-0278",
                "qty_issued": 12,
                "total_home_amt": 1818.59,
                "shipment_date": "2026-02-24",
                "due_date": "2025-10-24",
                "shipment_voucher_no": "LG05982SSH",
            },
            {
                "sales_order_no": "SO/2502224",
                "line_item_no": "9",
                "pp_voucher_no": "NPS25-0278",
                "process_sheet_no": "NPS25-0278",
                "qty_issued": 40,
                "total_home_amt": 6109.70,
                "shipment_date": "2026-04-30",
                "due_date": "2025-10-24",
                "shipment_voucher_no": "LG06926SSH",
            },
        ]
        before = sum_field(shipments, "total_home_amt")
        matched = assign_shipment_partials(shipments, partials_by_voucher)
        after = sum_field(matched, "total_home_amt")

        self.assertEqual(len(matched), 2)
        self.assertAlmostEqual(before, after, places=2)
        self.assertEqual(matched[0]["pp_partial_no"], 1)
        self.assertEqual(matched[1]["pp_partial_no"], 2)
        self.assertEqual(matched[0]["due_date"], "2026-01-29")
        self.assertEqual(matched[1]["due_date"], "2026-04-23")
        self.assertEqual(matched[0]["so_due_date"], "2025-10-24")

    def test_single_partial_multi_shipment_fifo_without_double_count(self):
        partials_by_voucher = {
            "NPS26-0024": [
                {"pp_partial_no": 1, "partial_qty": 112, "proposed_edd": "2026-03-24"},
            ]
        }
        shipments = [
            {
                "pp_voucher_no": "NPS26-0024",
                "qty_issued": 24,
                "total_home_amt": 3092.20,
                "shipment_date": "2026-02-26",
                "due_date": "2026-02-01",
                "shipment_voucher_no": "LG05571SSH",
            },
            {
                "pp_voucher_no": "NPS26-0024",
                "qty_issued": 26,
                "total_home_amt": 3323.50,
                "shipment_date": "2026-03-10",
                "due_date": "2026-02-01",
                "shipment_voucher_no": "LG06136SSH",
            },
            {
                "pp_voucher_no": "NPS26-0024",
                "qty_issued": 62,
                "total_home_amt": 7925.27,
                "shipment_date": "2026-03-31",
                "due_date": "2026-02-01",
                "shipment_voucher_no": "LG06285SSH",
            },
        ]
        before = sum_field(shipments, "total_home_amt")
        matched = assign_shipment_partials(shipments, partials_by_voucher)
        after = sum_field(matched, "total_home_amt")

        self.assertEqual(len(matched), 3)
        self.assertAlmostEqual(before, after, places=2)
        self.assertTrue(all(row["pp_partial_no"] == 1 for row in matched))
        self.assertTrue(all(row["due_date"] == "2026-03-24" for row in matched))


    def test_single_partial_multi_shipment_uses_ship_date_for_month(self):
        """NPS25-0290 pattern: one ERP partial, split DOs on different months."""
        partials_by_voucher = {
            "NPS25-0290": [
                {"pp_partial_no": 1, "partial_qty": 5, "proposed_edd": "2025-12-23"},
            ]
        }
        shipments = [
            {
                "pp_voucher_no": "NPS25-0290",
                "qty_issued": 2,
                "total_home_amt": 376.06,
                "shipment_date": "2026-01-20",
                "due_date": "2025-10-24",
                "shipment_voucher_no": "LG05396SSH",
            },
            {
                "pp_voucher_no": "NPS25-0290",
                "qty_issued": 3,
                "total_home_amt": 559.69,
                "shipment_date": "2026-02-10",
                "due_date": "2025-10-24",
                "shipment_voucher_no": "LG05645SSH",
            },
        ]
        matched = assign_shipment_partials(shipments, partials_by_voucher)

        self.assertEqual(matched[0]["due_date"], "2026-01-20")
        self.assertEqual(matched[1]["due_date"], "2026-02-10")
        self.assertEqual(matched[0]["partial_due_date"], "2025-12-23")
        self.assertEqual(matched[0]["so_due_date"], "2025-10-24")


if __name__ == "__main__":
    unittest.main()
