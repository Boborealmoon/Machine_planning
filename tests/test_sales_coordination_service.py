"""Tests for sales-coordination read-only commitment lines."""
from __future__ import annotations

import os
import unittest
from datetime import date
from unittest.mock import patch

from app import app
from planning.sales_coordination_service import (
    build_sales_coordination,
    expand_sales_coordination_lines,
    normalize_coordination_update,
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
                "first_posted_datetime": "2026-07-28 09:00:00",
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
        self.assertEqual(row["posted_date"], "2026-07-28")
        self.assertEqual(row["po_date"], "2026-07-28")
        self.assertEqual(row["proposed_edd"], "2026-08-18")
        self.assertEqual(row["week"], "Week 34 - Tuesday")
        self.assertTrue(row["is_frame_agreement"])

    def test_posted_date_falls_back_to_order_date(self):
        orders = [
            {
                "sales_order_no": "SO/posted",
                "order_date": "2026-06-01",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-9",
                        "process_sheet_no": "APS26-9",
                        "inventory_code": "X",
                        "description": "Part",
                        "due_date": "2026-08-19",
                        "order_date": "2026-06-15",
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            }
        ]
        row = expand_sales_coordination_lines(orders)[0]
        self.assertEqual(row["posted_date"], "2026-06-15")

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

    def test_merges_customer_code_and_name(self):
        orders = [
            {
                "sales_order_no": "SO/9",
                "customer_code": "CA30",
                "customer_name": "Acme Pte Ltd",
                "customer_short_name": "Acme",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-1",
                        "process_sheet_no": "APS26-1",
                        "customer_code": "PP-CODE",
                        "shipped_completed": False,
                        "partials": [
                            {
                                "pp_partial_no": 1,
                                "customer_code": "PART-CODE",
                                "party_name": "Partial Name",
                            }
                        ],
                    }
                ],
            }
        ]
        row = expand_sales_coordination_lines(orders)[0]
        self.assertEqual(row["customer_code"], "CA30")
        self.assertEqual(row["customer_name"], "Acme Pte Ltd")

    def test_customer_falls_back_to_process_sheet_then_partial(self):
        orders = [
            {
                "sales_order_no": "SO/10",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "NPS26-2",
                        "process_sheet_no": "NPS26-2",
                        "customer_code": "PP1",
                        "shipped_completed": False,
                        "partials": [
                            {
                                "pp_partial_no": 1,
                                "customer_code": "P1",
                                "party_name": "Partial Co",
                            }
                        ],
                    }
                ],
            }
        ]
        row = expand_sales_coordination_lines(orders)[0]
        self.assertEqual(row["customer_code"], "PP1")
        self.assertEqual(row["customer_name"], "Partial Co")

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

        rolled = parse_material_tracking_fields(
            {
                "material_subcon": "2026-09-05",
                "assembly_material_subcon": "2027-01-08",
                "assembly_material_status": "Expected",
            }
        )
        self.assertEqual(rolled["material_status"], "Expected")
        self.assertEqual(rolled["material_in_date"], "2027-01-08")

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

    def test_assembly_parent_uses_tracker_child_arrival(self):
        orders = [
            {
                "sales_order_no": "SO/2602442",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "NPS26-0321",
                        "process_sheet_no": "NPS26-0321",
                        "inventory_code": "BB14-KS0188-05 REV 04",
                        "description": "R.L.M.S LOCKDOWN MECHANISM",
                        "due_date": "2027-01-18",
                        "material_subcon": "2026-09-05",
                        "assembly_material_subcon": "2027-01-08",
                        "assembly_material_status": "Expected",
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            }
        ]
        row = expand_sales_coordination_lines(orders)[0]
        self.assertEqual(row["process_sheet_no"], "NPS26-0321")
        self.assertEqual(row["material_status"], "Expected")
        self.assertEqual(row["material_in_date"], "2027-01-08")

    def test_po_date_line_item_order_qty_and_erp_remarks(self):
        orders = [
            {
                "sales_order_no": "SO/2601",
                "order_date": "2026-09-02",
                "first_posted_datetime": "2026-09-04 08:00:00",
                "external_remarks": "Ship with the October lot",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-0245",
                        "process_sheet_no": "APS26-0245",
                        "source_line_item_no": "12",
                        "inventory_code": "D64438EB",
                        "description": "BUSH",
                        "customer_po_no": "556385",
                        "so_det_qty": 12,
                        "pp_qty": 12,
                        "due_date": "2026-10-30",
                        "remarks": "Confirm heat number",
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            }
        ]
        row = expand_sales_coordination_lines(orders)[0]
        self.assertEqual(row["po_date"], "2026-09-02")
        self.assertEqual(row["posted_date"], "2026-09-04")
        self.assertEqual(row["line_item_no"], "12")
        self.assertEqual(row["customer_po_no"], "556385")
        self.assertEqual(row["part_no"], "D64438EB")
        self.assertEqual(row["order_qty"], 12)
        self.assertEqual(row["customer_remarks"], "Ship with the October lot")
        self.assertEqual(row["coway_remarks"], "Confirm heat number")
        self.assertIsNone(row["committed_schedule"])
        self.assertEqual(row["pp_partial_no"], 1)

    def test_normalize_committed_schedule_and_remarks(self):
        parsed = normalize_coordination_update(
            {
                "pp_voucher_no": " APS26-1 ",
                "committed_schedule": "30/09/2026",
                "customer_remarks": "  hold  ",
            }
        )
        self.assertEqual(parsed["pp_voucher_no"], "APS26-1")
        self.assertEqual(parsed["pp_partial_no"], 1)
        self.assertEqual(parsed["committed_schedule"], "2026-09-30")
        self.assertEqual(parsed["customer_remarks"], "hold")
        self.assertNotIn("coway_remarks", parsed)

        cleared = normalize_coordination_update(
            {"pp_voucher_no": "NPS26-2", "pp_partial_no": "3", "committed_schedule": "-"}
        )
        self.assertEqual(cleared["pp_partial_no"], 3)
        self.assertIsNone(cleared["committed_schedule"])

        with self.assertRaises(ValueError):
            normalize_coordination_update(
                {"pp_voucher_no": "APS26-1", "committed_schedule": "next Friday"}
            )


class SalesCoordinationRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_page_includes_date_columns_export_and_sort(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/sales-coordination")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("data-sort=\"po_date\"", html)
        self.assertIn("data-sort=\"committed_schedule\"", html)
        self.assertIn("data-sort=\"due_date\"", html)
        self.assertIn("data-sort=\"line_item_no\"", html)
        self.assertIn("data-sort=\"order_qty\"", html)
        self.assertIn("id=\"sc-export\"", html)
        self.assertIn("id=\"sc-select-all\"", html)
        self.assertIn("sc-col-check", html)
        self.assertIn("PO date", html)
        self.assertIn("PO number", html)
        self.assertIn("Inventory code", html)
        self.assertIn("Customer remarks", html)
        self.assertIn("Coway remarks", html)
        self.assertIn("Committed schedule", html)
        self.assertIn("sc-20261112-columns", html)
        self.assertIn('id="sc-columns"', html)
        self.assertIn('id="sc-col-filter"', html)
        self.assertIn('data-sort="customer"', html)
        po_date = html.find('data-sort="po_date"')
        customer_col = html.find('data-sort="customer"')
        ps_no = html.find('data-sort="process_sheet_no"')
        self.assertTrue(ps_no < customer_col < po_date)
        po_no = html.find('data-sort="customer_po_no"')
        line = html.find('data-sort="line_item_no"')
        due = html.find('data-sort="due_date"')
        qty = html.find('data-sort="order_qty"')
        customer = html.find('data-sort="customer_remarks"')
        coway = html.find('data-sort="coway_remarks"')
        commit = html.find('data-sort="committed_schedule"')
        self.assertTrue(po_date < po_no < line < due < qty < customer < coway < commit)

    def test_api_includes_posted_and_proposed_edd(self):
        payload = {
            "active": [
                {
                    "sales_order_no": "SO/1",
                    "customer_name": "Acme",
                    "first_posted_datetime": "2026-07-28 09:00:00",
                    "pp_vouchers": [
                        {
                            "pp_voucher_no": "APS26-100026",
                            "process_sheet_no": "APS26-100026",
                            "inventory_code": "D61063EB",
                            "description": "BUSH",
                            "due_date": "2026-08-19",
                            "coway_proposed_edd": "2026-08-18",
                            "shipped_completed": False,
                            "partials": [],
                        }
                    ],
                }
            ],
            "frame_agreement_parts": [],
        }
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}), patch(
            "planning.sales_orders_route._fetch_sales_orders",
            return_value=payload,
        ), patch(
            "planning.sales_orders_route._job_count",
            return_value=1,
        ):
            response = self.client.get("/api/sales-coordination")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(len(data["lines"]), 1)
        row = data["lines"][0]
        self.assertEqual(row["posted_date"], "2026-07-28")
        self.assertEqual(row["po_date"], "2026-07-28")
        self.assertEqual(row["proposed_edd"], "2026-08-18")
        self.assertEqual(row["due_date"], "2026-08-19")
        self.assertIsNone(row["committed_schedule"])

    def test_patch_rejects_a_bad_committed_date(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.patch(
                "/api/sales-coordination/lines",
                json={"updates": [{"pp_voucher_no": "APS26-1", "committed_schedule": "next Friday"}]},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("not a date", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
