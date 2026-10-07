"""S/O KPI extracts: material date gaps and exception flags."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from planning.so_kpi import build_so_kpi


def _order(**pp_overrides):
    pp = {
        "process_sheet_no": "NPS26-0001",
        "pp_voucher_no": "PP1",
        "inventory_code": "P-100",
        "description": "Bracket",
        "material_need_date": "2026-03-01",
        "material_subcon": "2026-03-04",
        "material_in_date": "",
        "delivery_date": "2026-03-20",
        "mtl_part_order": "AM/0719/23 CUAL1NI5FE5*2_D25.4",
        "quality_doc": "C of C",
        "ops_notes": "waiting on mill",
        "sales_notes": "customer aware",
        "remarks": "check grain",
        "due_date": "2026-04-15",
        "highlighted_partials": [],
        "exception_issues": {},
        "ps_highlighted": False,
        "coway_proposed_edd": "",
        "partials": [{"pp_partial_no": 1, "coway_proposed_edd": "2026-04-20"}],
    }
    pp.update(pp_overrides)
    return {
        "sales_order_no": "SO100",
        "customer_name": "Acme",
        "remarks": "ship complete",
        "first_posted_datetime": "2026-01-08 09:15:00",
        "pp_vouchers": [pp],
    }


class SheetCategoryTests(unittest.TestCase):
    def test_sr_sheets_are_their_own_category(self):
        from planning.utils import sheet_category

        self.assertEqual(sheet_category("M24-[SR]08"), "SR")
        self.assertEqual(sheet_category("N26-[SR]22"), "SR")
        self.assertEqual(sheet_category("NPS26-0166"), "NPS")
        self.assertEqual(sheet_category("APS26-0100"), "APS")
        self.assertEqual(sheet_category("PPS26-0529"), "PPS")
        self.assertEqual(sheet_category("MPS26-0001"), "MPS")
        self.assertEqual(sheet_category(""), "Other")


class SoKpiBuilderTests(unittest.TestCase):
    def test_different_need_and_arrival_dates_are_listed_with_remarks(self):
        report = build_so_kpi([_order()])
        self.assertEqual(len(report["material_rows"]), 1)
        row = report["material_rows"][0]
        self.assertEqual(row["material_need_date"], "2026-03-01")
        self.assertEqual(row["material_arrival_date"], "2026-03-04")
        self.assertEqual(row["day_gap"], 3)
        self.assertEqual(row["gap_label"], "3 days late")
        self.assertEqual(row["due_date"], "2026-04-15")
        self.assertEqual(row["edd_date"], "2026-04-20")
        self.assertEqual(row["ps_type"], "NPS")
        self.assertEqual(row["description"], "Bracket")
        self.assertEqual(row["delivery_date"], "2026-03-20")
        self.assertEqual(row["mtl_part_order"], "AM/0719/23 CUAL1NI5FE5*2_D25.4")
        self.assertEqual(row["quality_doc"], "C of C")
        self.assertEqual(row["ops_notes"], "waiting on mill")
        self.assertEqual(row["sales_notes"], "customer aware")
        self.assertEqual(report["material_summary"]["late"], 1)

    def test_matching_dates_and_missing_arrival_are_left_out(self):
        same = _order(material_subcon="2026-03-01")
        missing = _order(process_sheet_no="NPS26-0002", material_subcon="", material_in_date="")
        arrived_only = _order(process_sheet_no="NPS26-0003", material_subcon="ARRIVED", material_in_date="")
        report = build_so_kpi([same, missing, arrived_only])
        self.assertEqual(report["material_rows"], [])

    def test_early_arrival_is_omitted_and_planner_in_date_fallback_stays(self):
        early = _order(material_need_date="2026-03-10", material_subcon="2026-03-09")
        fallback = _order(
            process_sheet_no="NPS26-0002",
            material_need_date="2026-04-01",
            material_subcon="",
            material_in_date="2026-04-02",
        )
        report = build_so_kpi([early, fallback])
        self.assertEqual([row["process_sheet_no"] for row in report["material_rows"]], ["NPS26-0002"])
        row = report["material_rows"][0]
        self.assertEqual(row["material_arrival_date"], "2026-04-02")
        self.assertEqual(row["day_gap"], 1)
        self.assertEqual(row["gap_label"], "1 day late")
        self.assertEqual(report["material_summary"]["late"], 1)
        self.assertEqual(report["material_summary"]["early"], 0)

    def test_sheet_edd_lists_each_partial_date(self):
        report = build_so_kpi([
            _order(
                partials=[
                    {"pp_partial_no": 1, "coway_proposed_edd": "2026-05-01"},
                    {"pp_partial_no": 2, "coway_proposed_edd": "2026-04-20"},
                    {"pp_partial_no": 3, "coway_proposed_edd": "2026-04-20"},
                ],
            )
        ])
        self.assertEqual(report["material_rows"][0]["edd_date"], "2026-04-20, 2026-05-01")

    def test_exception_rows_include_posted_due_edd_and_remarks(self):
        order = _order(
            highlighted_partials=[2],
            exception_issues={"2": ["supply_chain", "qlty"]},
            partials=[
                {"pp_partial_no": 1, "coway_proposed_edd": "2026-04-01"},
                {"pp_partial_no": 2, "coway_proposed_edd": "2026-05-01"},
            ],
        )
        plain = _order(process_sheet_no="NPS26-0099", highlighted_partials=[], exception_issues={})
        report = build_so_kpi([order, plain])
        self.assertEqual(len(report["exception_rows"]), 1)
        row = report["exception_rows"][0]
        self.assertEqual(row["partial_label"], "2/2")
        self.assertEqual(row["description"], "Bracket")
        self.assertEqual(row["posted_date"], "2026-01-08")
        self.assertEqual(row["due_date"], "2026-04-15")
        self.assertEqual(row["edd_date"], "2026-05-01")
        self.assertEqual(row["exception_label"], "Supply Chain, Qlty")
        self.assertEqual(row["delivery_date"], "2026-03-20")
        self.assertEqual(row["mtl_part_order"], "AM/0719/23 CUAL1NI5FE5*2_D25.4")
        self.assertEqual(row["quality_doc"], "C of C")
        self.assertEqual(row["ops_notes"], "waiting on mill")
        self.assertEqual(row["sales_notes"], "customer aware")
        self.assertEqual(report["exception_summary"]["count"], 1)

    def test_flagged_partial_without_issue_list_is_others(self):
        report = build_so_kpi([_order(highlighted_partials=[1], exception_issues={})])
        self.assertEqual(report["exception_rows"][0]["exception_label"], "Others")
        self.assertEqual(report["exception_rows"][0]["edd_date"], "2026-04-20")


class SoKpiRouteTests(unittest.TestCase):
    def setUp(self):
        from app import app

        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_page_has_the_so_subtabs(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "REPORTS_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            page = self.client.get("/kpi")
        self.assertEqual(page.status_code, 200)
        html = page.get_data(as_text=True)
        self.assertIn('data-kpi-tab="material"', html)
        self.assertIn('data-kpi-tab="exceptions"', html)
        self.assertIn("Material dates", html)
        self.assertIn("Exceptions", html)
        self.assertIn('id="kpi-typebar"', html)
        self.assertIn('id="kpi-col-value"', html)
        self.assertIn(">Resolved<", html)

    def test_api_builds_both_extracts_from_active_orders(self):
        payload = {"active": [_order(highlighted_partials=[1], exception_issues={"1": ["sales"]})]}
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "REPORTS_PASSCODE": ""}):
            with patch("planning.sales_orders_route._fetch_sales_orders", return_value=payload) as fetch:
                response = self.client.get("/api/kpi/so-management")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["material_summary"]["count"], 1)
        self.assertEqual(body["exception_rows"][0]["exception_label"], "Sales")
        fetch.assert_called_once_with(active_only=True)
