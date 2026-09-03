"""Tests for sales-coordination read-only commitment lines."""
from __future__ import annotations

import unittest
from datetime import date

from planning.sales_coordination_service import (
    build_sales_coordination,
    expand_sales_coordination_lines,
    parse_material_tracking_fields,
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

    def test_parse_material_tracking_fields(self):
        arrived = parse_material_tracking_fields(
            {
                "material_subcon": "ARRIVED",
                "material_in_date": "2026-08-01",
                "material_need_date": "2026-07-20",
            }
        )
        self.assertEqual(arrived["material_status"], "Arrived")
        self.assertEqual(arrived["material_in_date"], "2026-08-01")
        self.assertEqual(arrived["material_need_date"], "2026-07-20")

        expected = parse_material_tracking_fields({"material_subcon": "2026-09-15"})
        self.assertEqual(expected["material_status"], "Expected")
        self.assertEqual(expected["material_in_date"], "2026-09-15")

        empty = parse_material_tracking_fields({})
        self.assertEqual(empty["material_status"], "")
        self.assertIsNone(empty["material_in_date"])

    def test_includes_qty_buyer_status_and_sorts_aps_before_nps(self):
        orders = [
            {
                "sales_order_no": "SO/9",
                "customer_po_no": "PO-9",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "NPS26-2",
                        "process_sheet_no": "NPS26-2",
                        "inventory_code": "N-1",
                        "description": "NPS part",
                        "pp_qty": 20,
                        "due_date": "2026-08-01",
                        "buyer": "Alex",
                        "material_subcon": "ARRIVED",
                        "material_need_date": "2026-07-15",
                        "current_stage_desc": "CNC",
                        "current_stage_status": "I",
                        "erp_stage_mode": "open",
                        "shipped_completed": False,
                        "partials": [{"pp_partial_no": 1, "partial_qty": 8}],
                    },
                    {
                        "pp_voucher_no": "APS26-1",
                        "process_sheet_no": "APS26-1",
                        "inventory_code": "A-1",
                        "description": "APS part",
                        "pp_qty": 10,
                        "due_date": "2026-08-19",
                        "buyer": "",
                        "material_subcon": "2026-08-10",
                        "shipped_completed": False,
                        "partials": [],
                    },
                ],
            }
        ]
        lines = expand_sales_coordination_lines(orders)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["process_sheet_no"], "APS26-1")
        self.assertEqual(lines[0]["qty"], 10)
        self.assertEqual(lines[0]["partial_qty"], 10)
        self.assertEqual(lines[0]["material_status"], "Expected")
        self.assertEqual(lines[0]["material_in_date"], "2026-08-10")
        self.assertEqual(lines[1]["process_sheet_no"], "NPS26-2")
        self.assertEqual(lines[1]["partial_qty"], 8)
        self.assertEqual(lines[1]["buyer"], "Alex")
        self.assertEqual(lines[1]["material_status"], "Arrived")
        self.assertIn("CNC", lines[1]["order_status"])


if __name__ == "__main__":
    unittest.main()
