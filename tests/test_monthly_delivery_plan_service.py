"""Tests for monthly delivery plan commitment-month bucketing."""
from __future__ import annotations

import unittest

from planning.first_article_service import attach_program_pic_labels, program_pic_label
from planning.monthly_delivery_plan_service import (
    build_monthly_delivery_plan,
    commitment_date,
    expand_delivered_lines,
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

    def test_delivered_lines_keep_jobs_shipped_in_the_year(self):
        orders = [
            {
                "sales_order_no": "SO/300",
                "customer_name": "Gamma",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "APS26-9",
                        "process_sheet_no": "APS26-9",
                        "source_line_item_no": "10",
                        "inventory_code": "P-9",
                        "description": "Shipped widget",
                        "due_date": "2026-09-01",
                        "delivery_date": "2026-10-03",
                        "pp_qty": 4,
                        "so_det_qty": 4,
                        "qty_shipped": 4,
                        "unit_selling_price": 50,
                        "shipped_completed": True,
                        "partials": [],
                    },
                    {
                        "pp_voucher_no": "NPS25-1",
                        "process_sheet_no": "NPS25-1",
                        "source_line_item_no": "20",
                        "delivery_date": "2025-10-03",
                        "pp_qty": 1,
                        "shipped_completed": True,
                        "partials": [],
                    },
                ],
            }
        ]
        lines = expand_delivered_lines(orders, year=2026)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["delivery_date"], "2026-10-03")
        self.assertTrue(lines[0]["delivered"])
        self.assertEqual(lines[0]["ps_type"], "APS")
        self.assertEqual(lines[0]["remaining_qty"], 4.0)


class ProgramPicLabelTests(unittest.TestCase):
    def setUp(self):
        self.pics = {
            4: {"pic_id": 4, "name": "Ananda"},
            7: {"pic_id": 7, "name": "Chuan Heng"},
        }

    def _label(self, job, saved=None, flagged_by_ps=None, flagged_by_part=None):
        return program_pic_label(
            job,
            pics_by_id=self.pics,
            saved_by_ps=saved or {},
            flagged_by_ps=flagged_by_ps or {},
            flagged_by_part=flagged_by_part or {},
        )

    def test_saved_programme_pic_wins_and_joins_names(self):
        label = self._label(
            {"process_sheet_no": "nps26-0439::1"},
            saved={"NPS26-0439": [7, 4]},
            flagged_by_ps={"NPS26-0439": {"pic_ids": [4]}},
        )
        self.assertEqual(label, "Chuan Heng / Ananda")

    def test_empty_save_falls_back_to_tracker_then_unique_part(self):
        sheet = self._label(
            {"process_sheet_no": "APS26-0001", "part_no": "BB18"},
            saved={"APS26-0001": []},
            flagged_by_ps={"APS26-0001": {"pic_ids": [4], "quote_part_no": "OTHER"}},
        )
        self.assertEqual(sheet, "Ananda")
        part = self._label(
            {"process_sheet_no": "", "part_no": "bb18-ks"},
            flagged_by_part={"BB18-KS": [{"pic_ids": [7], "quote_part_no": "BB18-KS"}]},
        )
        self.assertEqual(part, "Chuan Heng")
        ambiguous = self._label(
            {"part_no": "SHARED"},
            flagged_by_part={
                "SHARED": [
                    {"pic_ids": [4], "quote_part_no": "SHARED"},
                    {"pic_ids": [7], "quote_part_no": "SHARED"},
                ],
            },
        )
        self.assertEqual(ambiguous, "")

    def test_attach_skips_database_when_there_are_no_lines(self):
        class _Con:
            def execute(self, *_args, **_kwargs):
                raise AssertionError("no query expected")

        attach_program_pic_labels(_Con(), [])


if __name__ == "__main__":
    unittest.main()
