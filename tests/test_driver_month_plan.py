"""Shop-floor month plan: work details only, no sales figures."""
from __future__ import annotations

import os
import unittest
from datetime import date
from unittest.mock import patch

from app import app
from planning.delivery_commitment_service import shop_month_work_lines
from planning.driver_view_route import DRIVER_VIEW_PATH


class ShopMonthWorkLineTests(unittest.TestCase):
    def test_keeps_work_details_and_drops_sales_figures(self):
        lines = [
            {
                "row_id": "late",
                "ps_type": "APS",
                "process_sheet_no": "APS1",
                "part_no": "P-2",
                "part_desc": "Later due",
                "open_qty": 2,
                "partial_qty": 2,
                "status": "Packing",
                "delivered": True,
                "delivery_date": "2026-10-03",
                "due_date": "2026-10-28",
                "slices": [],
                "sales_order_no": "SO-SECRET",
                "unit_cost": 99.5,
                "order_value": 497.5,
                "partial_revenue": 199,
                "amount": 199,
                "exch_rate": 1.35,
            },
            {
                "row_id": "nps",
                "ps_type": "NPS",
                "process_sheet_no": "NPS26-0360",
                "pp_partial_no": 1,
                "part_no": "BB27-KS0040-24",
                "part_desc": "FLUSHING ADAPTOR INLET",
                "partial_qty": 10,
                "open_qty": 10,
                "status": "CNC",
                "program_pic": "AL",
                "proposed_cnc": ["MC01", "MC02"],
                "due_date": "2026-10-20",
                "coway_edd": "2026-10-22",
                "material_need_date": "2026-10-01",
                "week": "Week 43",
                "okay": True,
                "slices": [{"plan_month": "2026-10", "qty": 4}],
                "sales_order_no": "SO-9",
                "unit_cost": 12.5,
                "order_value": 1000,
                "partial_revenue": 400,
                "amount": 50,
                "exch_rate": 1.2,
            },
            {
                "row_id": "other-type",
                "ps_type": "MPS",
                "process_sheet_no": "MPS1",
                "slices": [{"plan_month": "2026-10", "qty": 8}],
                "unit_cost": 9,
                "amount": 72,
                "sales_order_no": "SO-MPS",
            },
            {
                "row_id": "next-month",
                "ps_type": "NPS",
                "process_sheet_no": "NPS-NOV",
                "slices": [{"plan_month": "2026-11", "qty": 3}],
                "amount": 30,
                "sales_order_no": "SO-NOV",
            },
        ]

        rows = shop_month_work_lines(lines, "2026-10")

        self.assertEqual([row["ps"] for row in rows], ["NPS26-0360 #1", "APS1"])
        self.assertEqual(rows[0]["month_qty"], 4)
        self.assertEqual(rows[0]["partial_qty"], 10)
        self.assertEqual(rows[0]["proposed_cnc"], "MC01, MC02")
        self.assertEqual(rows[0]["program_pic"], "AL")
        self.assertTrue(rows[0]["okay"])
        self.assertEqual(rows[1]["month_qty"], 2)
        self.assertTrue(rows[1]["delivered"])
        blob = repr(rows)
        for banned in (
            "unit_cost",
            "order_value",
            "partial_revenue",
            "exch_rate",
            "sales_order_no",
            "SO-SECRET",
            "SO-9",
            "SO-MPS",
            "SO-NOV",
            "12.5",
            "99.5",
            "497.5",
            "MPS1",
            "NPS-NOV",
        ):
            self.assertNotIn(banned, blob)


class DriverMonthPlanRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_page_has_month_tab(self):
        response = self.client.get(DRIVER_VIEW_PATH)
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("This month", html)
        self.assertIn("Month qty", html)
        self.assertNotIn("Order value", html)
        self.assertNotIn("U/Cost", html)

    def test_api_stays_open_and_omits_prices_when_plan_is_locked(self):
        today = date.today()
        month = f"{today.year:04d}-{today.month:02d}"
        line = {
            "row_id": "r1",
            "ps_type": "NPS",
            "process_sheet_no": "NPS26-0360",
            "pp_partial_no": 1,
            "part_no": "BB27",
            "part_desc": "INLET",
            "partial_qty": 5,
            "open_qty": 5,
            "status": "CNC",
            "program_pic": "",
            "slices": [{"plan_month": month, "qty": 5}],
            "unit_cost": 99.5,
            "order_value": 497.5,
            "partial_revenue": 497.5,
            "amount": 497.5,
            "exch_rate": 1,
            "sales_order_no": "SO-SECRET",
        }

        class _Db:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        env = {"MONTHLY_DELIVERY_PLAN_PASSCODE": "plan-secret", "PLANNER_PASSCODE": ""}
        with patch.dict(os.environ, env), patch(
            "planning.monthly_delivery_plan_route._load_outstanding",
            return_value=([line], 1),
        ), patch(
            "planning.driver_view_route.planner_db",
            return_value=_Db(),
        ), patch(
            "planning.driver_view_route.load_commitments",
            return_value=[],
        ), patch(
            "planning.driver_view_route.load_okay_row_ids",
            return_value=set(),
        ), patch(
            "planning.driver_view_route.build_commitment_view",
            return_value={"lines": [line]},
        ), patch(
            "planning.driver_view_route.attach_program_pic_labels",
        ), patch(
            "planning.driver_view_route.apply_okay_flags",
        ):
            locked = self.client.get("/api/monthly-delivery-plan")
            opened = self.client.get("/api/trial/delivery-schedule/month-plan")

        self.assertEqual(locked.status_code, 401)
        self.assertEqual(opened.status_code, 200)
        payload = opened.get_json()
        self.assertEqual(payload["month"], month)
        self.assertEqual(payload["summary"]["line_count"], 1)
        self.assertEqual(payload["summary"]["qty"], 5)
        self.assertNotIn("amount", payload["summary"])
        self.assertEqual(payload["lines"][0]["ps"], "NPS26-0360 #1")
        self.assertEqual(payload["lines"][0]["month_qty"], 5)
        text = opened.get_data(as_text=True)
        for banned in ("unit_cost", "order_value", "SO-SECRET", "497.5", "99.5", "sales_order_no"):
            self.assertNotIn(banned, text)


if __name__ == "__main__":
    unittest.main()
