"""Tests for sales-coordination read-only commitment lines."""
from __future__ import annotations

import unittest
from datetime import date

from planning.sales_coordination_service import (
    build_sales_coordination,
    expand_sales_coordination_lines,
    week_label,
)


class SalesCoordinationTests(unittest.TestCase):
    def test_week_label_uses_full_weekday(self):
        # 2026-08-18 is a Tuesday, ISO week 34
        self.assertEqual(week_label(date(2026, 8, 18)), "Week 34 - Tuesday")
        self.assertEqual(week_label(date(2026, 8, 19)), "Week 34 - Wednesday")

    def test_prop_edd_drives_week_over_due_date(self):
        orders = [
            {
                "sales_order_no": "SO/1",
                "customer_name": "Acme",
                "customer_po_no": "PO-HEADER",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-100026",
                        "process_sheet_no": "APS26-100026",
                        "inventory_code": "D61063EB",
                        "description": "BUSH, OVERSIZE",
                        "customer_po_no": "3056043022/00",
                        "due_date": "2026-08-19",
                        "coway_proposed_edd": "2026-08-18",
                        "shipped_completed": False,
                        "is_frame_agreement": True,
                        "is_new_part": False,
                        "partials": [],
                    }
                ],
            }
        ]
        lines = expand_sales_coordination_lines(orders)
        self.assertEqual(len(lines), 1)
        row = lines[0]
        self.assertEqual(row["process_sheet_no"], "APS26-100026")
        self.assertEqual(row["sales_order_no"], "SO/1")
        self.assertEqual(row["part_no"], "D61063EB")
        self.assertEqual(row["customer_po_no"], "3056043022/00")
        self.assertEqual(row["due_date"], "2026-08-19")
        self.assertEqual(row["proposed_edd"], "2026-08-18")
        self.assertEqual(row["week"], "Week 34 - Tuesday")
        self.assertTrue(row["is_frame_agreement"])

    def test_falls_back_to_due_date_when_no_prop_edd(self):
        orders = [
            {
                "sales_order_no": "SO/2",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "NPS26-1",
                        "process_sheet_no": "NPS26-1",
                        "inventory_code": "P-1",
                        "description": "Bracket",
                        "due_date": "2026-08-19",
                        "coway_proposed_edd": "",
                        "shipped_completed": False,
                        "is_new_part": True,
                        "partials": [],
                    }
                ],
            }
        ]
        row = expand_sales_coordination_lines(orders)[0]
        self.assertIsNone(row["proposed_edd"])
        self.assertEqual(row["week"], "Week 34 - Wednesday")
        self.assertTrue(row["is_new_part"])

    def test_skips_shipped_and_expands_partials(self):
        orders = [
            {
                "sales_order_no": "SO/3",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS-DONE",
                        "process_sheet_no": "APS-DONE",
                        "shipped_completed": True,
                        "partials": [],
                    },
                    {
                        "pp_voucher_no": "APS-OPEN",
                        "process_sheet_no": "APS-OPEN",
                        "inventory_code": "X",
                        "description": "Part",
                        "due_date": "2026-08-20",
                        "shipped_completed": False,
                        "partials": [
                            {"pp_partial_no": 1, "coway_proposed_edd": "2026-08-18"},
                            {"pp_partial_no": 2, "coway_proposed_edd": "2026-08-19"},
                        ],
                    },
                ],
            }
        ]
        lines = expand_sales_coordination_lines(orders)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["pp_partial_no"], 1)
        self.assertEqual(lines[0]["proposed_edd"], "2026-08-18")
        self.assertEqual(lines[1]["pp_partial_no"], 2)
        self.assertEqual(lines[1]["proposed_edd"], "2026-08-19")

    def test_build_payload(self):
        result = build_sales_coordination([])
        self.assertTrue(result["ok"])
        self.assertEqual(result["line_count"], 0)
        self.assertEqual(result["lines"], [])


if __name__ == "__main__":
    unittest.main()
