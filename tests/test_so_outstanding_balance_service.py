"""Tests for SO outstanding balance line expansion and pricing."""
from __future__ import annotations

import unittest
from datetime import date

from planning.so_outstanding_balance_service import (
    NOPP_PS_TYPE,
    build_outstanding_balance,
    commitment_date,
    expand_outstanding_lines,
    ps_type,
    restrict_orders_to_open_so_lines,
    stage_label,
    summarize_by_customer,
    week_label,
)


class SoOutstandingBalanceTests(unittest.TestCase):
    def test_commitment_prefers_partial_coway_over_po_due(self):
        pp = {
            "due_date": "2026-08-14",
            "coway_proposed_edd": "2026-07-28",
        }
        partial = {"coway_proposed_edd": "2026-07-20"}
        self.assertEqual(commitment_date(pp, partial).isoformat(), "2026-07-20")

    def test_commitment_falls_back_to_po_due(self):
        pp = {"due_date": "2026-08-14", "coway_proposed_edd": "", "partials": []}
        self.assertEqual(commitment_date(pp).isoformat(), "2026-08-14")

    def test_week_label_and_undated(self):
        self.assertIsNone(week_label(None))
        self.assertEqual(week_label(date(2026, 7, 28)), "Week 31 - Tue")

    def test_uses_partial_qty_for_amounts_and_allocates_remaining(self):
        orders = [
            {
                "sales_order_no": "SO/100",
                "customer_name": "Acme",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS1",
                        "process_sheet_no": "APS1",
                        "source_line_item_no": "1",
                        "inventory_code": "P-1",
                        "description": "Widget housing",
                        "due_date": "2026-08-14",
                        "coway_proposed_edd": "2026-07-28",
                        "so_det_qty": 10,
                        "pp_qty": 10,
                        "qty_shipped": 4,
                        "unit_selling_price": 100,
                        "shipped_completed": False,
                        "partials": [
                            {
                                "pp_partial_no": 1,
                                "partial_qty": 4,
                                "coway_proposed_edd": "2026-07-20",
                                "current_stage_desc": "CNC",
                                "current_stage_status": "I",
                            },
                            {
                                "pp_partial_no": 2,
                                "partial_qty": 6,
                                "coway_proposed_edd": "2026-08-01",
                                "current_stage_desc": "Pack",
                                "current_stage_status": "R",
                            },
                        ],
                    },
                    {
                        "pp_voucher_no": "APS2",
                        "process_sheet_no": "APS2",
                        "source_line_item_no": "2",
                        "so_det_qty": 5,
                        "unit_selling_price": 50,
                        "shipped_completed": True,
                        "partials": [],
                    },
                ],
            }
        ]
        pricing = {
            "SO/100|1": {"exch_rate": 1.5, "unit_cost": 100},
        }
        lines = expand_outstanding_lines(orders, pricing)
        self.assertEqual(len(lines), 2)

        first, second = lines
        self.assertEqual(first["pp_qty"], 4)
        self.assertEqual(first["remaining_qty"], 4)  # remaining pool 6, first takes 4
        self.assertEqual(first["so_qty"], 10)
        self.assertEqual(first["line_value_home"], 1500.0)  # SO value: 100 * 10 * 1.5
        self.assertEqual(first["pp_value_home"], 600.0)  # 100 * 4 * 1.5
        self.assertEqual(first["outstanding_balance_home"], 600.0)
        self.assertEqual(first["part_desc"], "Widget housing")
        self.assertEqual(first["status"], "CNC - In process")
        self.assertEqual(first["week"], "Week 30 - Mon")

        self.assertEqual(second["pp_qty"], 6)
        self.assertEqual(second["remaining_qty"], 2)  # 6 remaining after first
        self.assertEqual(second["line_value_home"], 1500.0)  # same SO line value
        self.assertEqual(second["pp_value_home"], 900.0)  # 100 * 6 * 1.5
        self.assertEqual(second["outstanding_balance_home"], 300.0)  # 100 * 2 * 1.5

        payload = build_outstanding_balance(orders, pricing)
        self.assertEqual(payload["summary"]["line_count"], 2)
        # SO value counted once per SO line even when split across partials
        self.assertEqual(payload["summary"]["line_value_home"], 1500.0)
        self.assertEqual(payload["summary"]["outstanding_balance_home"], 900.0)
        self.assertEqual(payload["by_customer"][0]["pp_qty"], 10)
        self.assertEqual(payload["by_customer"][0]["line_value_home"], 1500.0)

    def test_ps_type_and_customer_breakdown(self):
        self.assertEqual(ps_type("APS26-1"), "APS")
        self.assertEqual(ps_type("NPS26-2"), "NPS")
        self.assertEqual(ps_type("PPS26-3"), "PPS")

        lines = [
            {
                "customer_name": "Beta",
                "sales_order_no": "SO/B",
                "source_line_item_no": "1",
                "pp_qty": 2,
                "remaining_qty": 1,
                "line_value_home": 200,
                "outstanding_balance_home": 100,
            },
            {
                "customer_name": "Alpha",
                "sales_order_no": "SO/A",
                "source_line_item_no": "1",
                "pp_qty": 5,
                "remaining_qty": 5,
                "line_value_home": 500,
                "outstanding_balance_home": 500,
            },
        ]
        by_customer = summarize_by_customer(lines)
        self.assertEqual([row["customer_name"] for row in by_customer], ["Alpha", "Beta"])
        self.assertEqual(by_customer[0]["pp_qty"], 5)
        self.assertEqual(by_customer[0]["line_value_home"], 500)

    def test_stage_label_no_wo_and_complete(self):
        self.assertEqual(
            stage_label({"erp_stage_mode": "unassigned", "partials": []}),
            "No WO assigned",
        )
        self.assertEqual(
            stage_label(
                {
                    "erp_stage_mode": "completed",
                    "erp_last_stage_desc": "Pack",
                    "partials": [],
                }
            ),
            "All stages complete - Pack",
        )

    def test_fallback_pp_qty_when_no_partials(self):
        orders = [
            {
                "sales_order_no": "SO/1",
                "customer_name": "A",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS",
                        "process_sheet_no": "APS",
                        "source_line_item_no": "1",
                        "so_det_qty": 2,
                        "pp_qty": 2,
                        "qty_shipped": 0,
                        "unit_selling_price": 25,
                        "shipped_completed": False,
                        "due_date": "",
                        "partials": [],
                    }
                ],
            }
        ]
        row = expand_outstanding_lines(orders, {})[0]
        self.assertEqual(row["pp_qty"], 2)
        self.assertEqual(row["line_value_home"], 50.0)
        self.assertEqual(row["outstanding_balance_home"], 50.0)

    def test_skips_zero_remaining_partials(self):
        orders = [
            {
                "sales_order_no": "SO/1",
                "customer_name": "A",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS1",
                        "process_sheet_no": "APS1",
                        "source_line_item_no": "1",
                        "so_det_qty": 8,
                        "pp_qty": 8,
                        "qty_shipped": 4,
                        "unit_selling_price": 10,
                        "shipped_completed": False,
                        "partials": [
                            {"pp_partial_no": 1, "partial_qty": 4},
                            {"pp_partial_no": 2, "partial_qty": 4},
                        ],
                    }
                ],
            }
        ]
        lines = expand_outstanding_lines(orders, {})
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["pp_partial_no"], 1)
        self.assertEqual(lines[0]["remaining_qty"], 4)

    def test_stage_label_no_pp(self):
        self.assertEqual(
            stage_label({"erp_stage_mode": "no_pp", "partials": []}),
            "No PP assigned",
        )

    def test_restrict_drops_closed_so_lines_and_adds_nopp(self):
        orders = [
            {
                "sales_order_no": "SO/OPEN",
                "customer_name": "Acme",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS-OPEN",
                        "process_sheet_no": "APS-OPEN",
                        "source_line_item_no": "1",
                        "so_det_qty": 10,
                        "pp_qty": 10,
                        "qty_shipped": 0,
                        "unit_selling_price": 5,
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            },
            {
                "sales_order_no": "SO/CLOSED",
                "customer_name": "Beta",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS-CLOSED",
                        "process_sheet_no": "APS-CLOSED",
                        "source_line_item_no": "1",
                        "so_det_qty": 2,
                        "pp_qty": 2,
                        "qty_shipped": 0,
                        "unit_selling_price": 9,
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            },
        ]
        open_so_lines = [
            {
                "sales_order_no": "SO/OPEN",
                "line_item_no": "1",
                "customer_name": "Acme",
                "so_det_qty": 10,
                "qty_shipped": 3,
                "remaining_qty": 7,
                "unit_selling_price_fc": 5,
                "description": "Housing",
                "inventory_code": "P-1",
            },
            {
                "sales_order_no": "SO/NOPP",
                "line_item_no": "2",
                "customer_name": "Gamma",
                "so_det_qty": 8,
                "qty_shipped": 1,
                "remaining_qty": 7,
                "unit_selling_price_fc": 20,
                "exch_rate": 1,
                "description": "Bracket",
                "inventory_code": "P-2",
                "due_date": "2026-09-01",
            },
        ]
        scoped = restrict_orders_to_open_so_lines(orders, open_so_lines)
        so_nos = {row["sales_order_no"] for row in scoped}
        self.assertEqual(so_nos, {"SO/OPEN", "SO/NOPP"})

        payload = build_outstanding_balance(scoped, {})
        by_so = {row["sales_order_no"]: row for row in payload["lines"]}
        self.assertEqual(len(payload["lines"]), 2)
        self.assertEqual(by_so["SO/OPEN"]["remaining_qty"], 7)
        self.assertEqual(by_so["SO/OPEN"]["qty_shipped"], 3)
        self.assertEqual(by_so["SO/NOPP"]["ps_type"], NOPP_PS_TYPE)
        self.assertEqual(by_so["SO/NOPP"]["status"], "No PP assigned")
        self.assertEqual(by_so["SO/NOPP"]["remaining_qty"], 7)
        self.assertEqual(by_so["SO/NOPP"]["outstanding_balance_home"], 140.0)

    def test_restrict_none_leaves_orders_unchanged(self):
        orders = [{"sales_order_no": "SO/1", "pp_vouchers": [{"pp_voucher_no": "APS1"}]}]
        self.assertIs(restrict_orders_to_open_so_lines(orders, None), orders)


class SoOutstandingBalanceRouteTests(unittest.TestCase):
    def setUp(self):
        import os
        from unittest.mock import patch

        from app import app

        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        self._env = patch.dict(os.environ, {"PLANNER_PASSCODE": "", "REPORTS_PASSCODE": ""})
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def test_page_explains_active_export(self):
        response = self.client.get("/so-outstanding-balance")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("includes every currently open line", html)
        self.assertIn("so_outstanding_balance.js?v=sob-20260825a", html)

    def test_api_drops_closed_and_includes_nopp(self):
        from unittest.mock import patch

        active = [
            {
                "sales_order_no": "SO/OPEN",
                "customer_name": "Acme",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS-OPEN",
                        "process_sheet_no": "APS-OPEN",
                        "source_line_item_no": "1",
                        "so_det_qty": 10,
                        "pp_qty": 10,
                        "qty_shipped": 0,
                        "unit_selling_price": 5,
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            },
            {
                "sales_order_no": "SO/CLOSED",
                "customer_name": "Beta",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS-CLOSED",
                        "process_sheet_no": "APS-CLOSED",
                        "source_line_item_no": "1",
                        "so_det_qty": 2,
                        "pp_qty": 2,
                        "qty_shipped": 0,
                        "unit_selling_price": 9,
                        "shipped_completed": False,
                        "partials": [],
                    }
                ],
            },
        ]
        open_lines = [
            {
                "sales_order_no": "SO/OPEN",
                "line_item_no": "1",
                "customer_name": "Acme",
                "so_det_qty": 10,
                "qty_shipped": 3,
                "remaining_qty": 7,
                "unit_selling_price_fc": 5,
            },
            {
                "sales_order_no": "SO/NOPP",
                "line_item_no": "2",
                "customer_name": "Gamma",
                "so_det_qty": 4,
                "qty_shipped": 0,
                "remaining_qty": 4,
                "unit_selling_price_fc": 10,
            },
        ]
        with patch(
            "planning.sales_orders_route._fetch_sales_orders",
            return_value={"active": active, "complete": []},
        ), patch(
            "planning.process_sheets.fetch_so_line_pricing_map",
            return_value={},
        ), patch(
            "planning.so_outstanding_balance_route._fetch_open_so_lines",
            return_value=open_lines,
        ):
            response = self.client.get("/api/so-outstanding-balance")

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["ok"])
        so_nos = {row["sales_order_no"] for row in data["lines"]}
        self.assertEqual(so_nos, {"SO/OPEN", "SO/NOPP"})
        self.assertTrue(any(row["ps_type"] == NOPP_PS_TYPE for row in data["lines"]))


if __name__ == "__main__":
    unittest.main()
