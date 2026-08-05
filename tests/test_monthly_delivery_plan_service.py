"""Tests for monthly delivery plan commitment-month bucketing."""
from __future__ import annotations

import unittest

from planning.monthly_delivery_plan_service import (
    build_monthly_delivery_plan,
    commitment_date,
    expand_delivery_lines,
)
from planning.process_sheets import _so_line_pricing_key


class MonthlyDeliveryPlanTests(unittest.TestCase):
    def test_commitment_prefers_coway_edd_over_po_due(self):
        pp = {"due_date": "2026-08-14", "coway_proposed_edd": "2026-07-28"}
        self.assertEqual(commitment_date(pp).isoformat(), "2026-07-28")

    def test_commitment_falls_back_to_po_due(self):
        pp = {"due_date": "2026-08-14", "coway_proposed_edd": ""}
        self.assertEqual(commitment_date(pp).isoformat(), "2026-08-14")

    def test_partial_coway_overrides_pp_coway(self):
        pp = {"due_date": "2026-08-14", "coway_proposed_edd": "2026-07-01"}
        partial = {"coway_proposed_edd": "2026-09-15", "partial_qty": 2}
        self.assertEqual(commitment_date(pp, partial).isoformat(), "2026-09-15")

    def test_month_bucket_uses_commitment_and_splits_partial_revenue(self):
        orders = [
            {
                "sales_order_no": "SO/100",
                "customer_name": "Acme",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-1",
                        "process_sheet_no": "APS26-1",
                        "inventory_code": "P-1",
                        "description": "Widget",
                        "due_date": "2026-08-14",
                        "pp_qty": 10,
                        "so_det_qty": 10,
                        "unit_selling_price": 100,
                        "amount": 1000,
                        "shipped_completed": False,
                        "partials": [
                            {
                                "pp_partial_no": 1,
                                "partial_qty": 4,
                                "coway_proposed_edd": "2026-07-28",
                            },
                            {
                                "pp_partial_no": 2,
                                "partial_qty": 6,
                                "coway_proposed_edd": "2026-08-10",
                            },
                        ],
                    }
                ],
            }
        ]

        plan = build_monthly_delivery_plan(orders, year=2026)
        jul = plan["months"][6]
        aug = plan["months"][7]

        self.assertEqual(jul["line_count"], 1)
        self.assertEqual(jul["qty"], 4)
        self.assertEqual(jul["target_revenue"], 400.0)

        self.assertEqual(aug["line_count"], 1)
        self.assertEqual(aug["qty"], 6)
        self.assertEqual(aug["target_revenue"], 600.0)

        self.assertEqual(plan["year_summary"]["target_revenue"], 1000.0)

    def test_amount_uses_unit_cost_times_exch_rate(self):
        orders = [
            {
                "sales_order_no": "SO/200",
                "customer_name": "Beta",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "NPS26-9",
                        "process_sheet_no": "NPS26-9",
                        "source_line_item_no": "10",
                        "due_date": "2026-08-01",
                        "pp_qty": 5,
                        "so_det_qty": 5,
                        "unit_selling_price": 10,
                        "shipped_completed": False,
                        "partials": [
                            {
                                "pp_partial_no": 1,
                                "partial_qty": 5,
                                "coway_proposed_edd": "2026-08-05",
                            }
                        ],
                    }
                ],
            }
        ]
        key = _so_line_pricing_key("SO/200", "10")
        pricing = {key: {"unit_cost": 20.0, "exch_rate": 1.5}}
        plan = build_monthly_delivery_plan(orders, year=2026, pricing_by_key=pricing)
        aug = plan["months"][7]
        # 5 x 20 x 1.5 = 150
        self.assertEqual(aug["target_revenue"], 150.0)
        line = aug["lines"][0]
        self.assertEqual(line["unit_cost"], 20.0)
        self.assertEqual(line["exch_rate"], 1.5)
        self.assertEqual(line["amount"], 150.0)
        self.assertEqual(line["qty"], 5)

    def test_week_only_when_coway_edd_set(self):
        orders = [
            {
                "sales_order_no": "SO/300",
                "customer_name": "Gamma",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-2",
                        "process_sheet_no": "APS26-2",
                        "due_date": "2026-08-14",
                        "pp_qty": 1,
                        "unit_selling_price": 10,
                        "shipped_completed": False,
                        "partials": [],
                    },
                    {
                        "pp_voucher_no": "APS26-3",
                        "process_sheet_no": "APS26-3",
                        "due_date": "2026-08-14",
                        "coway_proposed_edd": "2026-08-03",
                        "pp_qty": 1,
                        "unit_selling_price": 10,
                        "shipped_completed": False,
                        "partials": [],
                    },
                ],
            }
        ]
        lines = expand_delivery_lines(orders)
        by_ps = {row["process_sheet_no"]: row for row in lines}
        self.assertIsNone(by_ps["APS26-2"]["week"])
        self.assertIsNotNone(by_ps["APS26-3"]["week"])
        self.assertTrue(by_ps["APS26-3"]["week"].startswith("Week "))

    def test_skips_shipped_completed_and_collects_undated(self):
        orders = [
            {
                "sales_order_no": "SO/1",
                "customer_name": "A",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS1",
                        "process_sheet_no": "APS1",
                        "due_date": "2026-07-01",
                        "pp_qty": 1,
                        "unit_selling_price": 50,
                        "shipped_completed": True,
                        "partials": [],
                    },
                    {
                        "pp_voucher_no": "APS2",
                        "process_sheet_no": "APS2",
                        "due_date": "",
                        "coway_proposed_edd": "",
                        "pp_qty": 2,
                        "unit_selling_price": 25,
                        "shipped_completed": False,
                        "partials": [],
                    },
                ],
            }
        ]
        lines = expand_delivery_lines(orders)
        self.assertEqual(len(lines), 1)
        plan = build_monthly_delivery_plan(orders, year=2026)
        self.assertEqual(plan["year_summary"]["undated_count"], 1)
        self.assertEqual(plan["year_summary"]["target_revenue"], 0.0)


if __name__ == "__main__":
    unittest.main()
