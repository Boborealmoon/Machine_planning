"""On-time delivery aggregations - process sheet PO due vs last delivery."""
from __future__ import annotations

import re
import unittest
from unittest.mock import patch

from flask import Flask

from planning.on_time_delivery import (
    aggregate_on_time_delivery,
    apply_benchmark,
    build_overview_sections,
    classify_process_sheets,
    filter_process_sheets,
    select_year_segment,
    year_segment,
)
from planning.on_time_delivery_route import on_time_delivery_bp


def _ps(
    ps: str,
    *,
    ship: str,
    due: str,
    pp_type: str | None = None,
    qty: float = 1,
    value: float = 100,
    so: str = "SO/1",
    line: str = "1",
    customer: str = "Acme",
    part: str = "P1",
    so_qty: float = 1,
    qty_shipped: float = 1,
    sales_person_code: str = "",
    sales_person_name: str = "",
    production_due: str | None = None,
) -> dict:
    return {
        "process_sheet_no": ps,
        "pp_voucher_no": ps,
        "pp_type": pp_type,
        "sales_order_no": so,
        "line_item_no": line,
        "inventory_code": part,
        "description": f"{part} desc",
        "customer_code": "C1",
        "customer_name": customer,
        "sales_person_code": sales_person_code,
        "sales_person_name": sales_person_name,
        "delivery_date": ship,
        "po_due_date": due,
        "production_due_date": production_due,
        "proposed_edd": production_due,
        "pp_qty": qty,
        "amount": value,
        "so_det_qty": so_qty,
        "qty_shipped": qty_shipped,
    }


class ClassifyTests(unittest.TestCase):
    def test_last_delivery_vs_po_due_columns(self):
        rows = classify_process_sheets(
            [_ps("NPS26-0001", ship="2026-03-20", due="2026-03-10")]
        )
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["po_due_date"], "2026-03-10")
        self.assertEqual(row["delivery_date"], "2026-03-20")
        self.assertEqual(row["days"], 10)
        self.assertEqual(row["status"], "late")
        self.assertFalse(row["on_time"])
        self.assertEqual(row["qty"], 1)
        self.assertEqual(row["value"], 100)

    def test_early_counts_as_on_time(self):
        rows = classify_process_sheets(
            [_ps("APS26-0002", ship="2026-01-20", due="2026-01-31")]
        )
        self.assertEqual(rows[0]["status"], "early")
        self.assertTrue(rows[0]["on_time"])
        self.assertEqual(rows[0]["days"], -11)

    def test_exact_due_is_on_time(self):
        rows = classify_process_sheets(
            [_ps("APS26-0003", ship="2026-04-15", due="2026-04-15")]
        )
        self.assertEqual(rows[0]["status"], "on_time")
        self.assertTrue(rows[0]["on_time"])
        self.assertEqual(rows[0]["days"], 0)

    def test_ignores_pp_schedule_dates(self):
        rows = classify_process_sheets(
            [
                _ps(
                    "NPS26-0004",
                    ship="2026-02-24",
                    due="2026-01-29",
                    production_due="2026-02-20",
                )
            ]
        )
        self.assertEqual(rows[0]["po_due_date"], "2026-01-29")
        self.assertEqual(rows[0]["days"], 26)
        self.assertEqual(rows[0]["proposed_edd"], "2026-02-20")
        self.assertEqual(rows[0]["edd_days"], 4)
        self.assertEqual(rows[0]["edd_status"], "late")

    def test_skips_incomplete_so_lines(self):
        rows = classify_process_sheets(
            [
                _ps(
                    "NPS26-0005",
                    ship="2026-03-01",
                    due="2026-03-10",
                    so_qty=10,
                    qty_shipped=4,
                )
            ]
        )
        self.assertEqual(rows, [])

    def test_skips_component_child_sheets(self):
        rows = classify_process_sheets(
            [
                _ps("NPS26-0321", ship="2026-03-01", due="2026-03-10"),
                _ps("NPS26-0321-1", ship="2026-03-01", due="2026-03-10"),
            ]
        )
        self.assertEqual([row["process_sheet_no"] for row in rows], ["NPS26-0321"])

    def test_skips_missing_dates(self):
        incomplete = _ps("NPS26-0006", ship="2026-03-01", due="2026-03-10")
        incomplete["po_due_date"] = None
        self.assertEqual(classify_process_sheets([incomplete]), [])

    def test_proposed_edd_is_a_separate_benchmark(self):
        rows = classify_process_sheets(
            [
                _ps("NPS26-0007", ship="2026-03-12", due="2026-03-01", production_due="2026-03-15"),
                _ps("NPS26-0008", ship="2026-03-09", due="2026-03-20"),
            ]
        )
        by_ps = {row["process_sheet_no"]: row for row in rows}
        self.assertEqual(by_ps["NPS26-0007"]["status"], "late")
        self.assertEqual(by_ps["NPS26-0007"]["edd_status"], "early")
        self.assertIsNone(by_ps["NPS26-0008"]["edd_days"])
        switched = {row["process_sheet_no"]: row for row in apply_benchmark(rows, "proposed_edd")}
        self.assertEqual(switched["NPS26-0007"]["status"], "early")
        self.assertTrue(switched["NPS26-0007"]["on_time"])
        self.assertEqual(switched["NPS26-0007"]["days"], -3)
        self.assertEqual(switched["NPS26-0008"]["status"], "early")
        self.assertTrue(switched["NPS26-0008"]["on_time"])
        self.assertEqual(switched["NPS26-0008"]["days"], -11)
        self.assertEqual(year_segment(by_ps["NPS26-0008"], 2026, "proposed_edd"), "due")
        kept = apply_benchmark(rows, "po_due")
        self.assertEqual(kept[0]["days"], rows[0]["days"])

    def test_year_segments_keep_other_years_out_of_the_chart(self):
        rows = classify_process_sheets(
            [
                _ps("NPS26-1", ship="2026-03-02", due="2026-03-10"),
                _ps("NPS25-1", ship="2026-01-06", due="2025-12-17"),
                _ps("NPS26-2", ship="2026-02-01", due="2027-01-15"),
                _ps("NPS26-3", ship="2025-12-20", due="2026-01-10"),
            ]
        )
        self.assertEqual(year_segment(rows[0], 2026, "po_due"), "due")
        by_ps = {row["process_sheet_no"]: year_segment(row, 2026, "po_due") for row in rows}
        self.assertEqual(by_ps["NPS26-1"], "due")
        self.assertEqual(by_ps["NPS25-1"], "carried_in")
        self.assertEqual(by_ps["NPS26-2"], "early_ship")
        self.assertEqual(by_ps["NPS26-3"], "due")
        chart = select_year_segment(rows, year=2026, benchmark="po_due", segment="due")
        in_year = [row for row in chart if row["month"]]
        outside = [row for row in chart if not row["month"]]
        self.assertEqual(
            sorted(row["process_sheet_no"] for row in in_year),
            ["NPS26-1"],
        )
        self.assertEqual(
            [row["process_sheet_no"] for row in outside],
            ["NPS26-3"],
        )
        self.assertIsNone(outside[0]["month"])


class AggregateTests(unittest.TestCase):
    def test_segregates_by_delivery_month_and_ps_type(self):
        sheets = [
            _ps("NPS26-1", ship="2026-01-20", due="2026-01-31", pp_type="NPS"),
            _ps("NPS26-2", ship="2026-01-28", due="2026-01-10", pp_type="NPS"),
            _ps("APS26-1", ship="2026-02-05", due="2026-02-05", pp_type="APS"),
            _ps("MPS26-1", ship="2026-01-15", due="2026-01-01", pp_type="MPS"),
            _ps("NPS26-3", ship="2026-03-01", due="2026-03-01", pp_type="NPS"),
        ]
        payload = aggregate_on_time_delivery(
            sheets,
            year=2026,
            pp_types=["APS", "NPS"],
        )
        summary = payload["summary"]
        self.assertEqual(summary["classified"], 4)
        self.assertEqual(summary["early"], 1)
        self.assertEqual(summary["on_time"], 2)
        self.assertEqual(summary["late"], 1)
        self.assertAlmostEqual(summary["on_time_rate"], 0.75)

        jan = payload["by_month"][0]
        self.assertEqual(jan["early"], 1)
        self.assertEqual(jan["late"], 1)
        self.assertEqual(jan["classified"], 2)

        feb = payload["by_month"][1]
        self.assertEqual(feb["on_time"], 1)

        by_id = {row["id"]: row for row in payload["by_ps"]}
        self.assertNotIn("MPS", by_id)
        self.assertEqual(by_id["NPS"]["early"], 1)
        self.assertEqual(by_id["NPS"]["late"], 1)
        self.assertEqual(by_id["APS"]["on_time"], 1)

        jan_ps = payload["by_month_ps"][0]["series"]
        self.assertEqual(jan_ps["NPS"]["early"], 1)
        self.assertEqual(jan_ps["NPS"]["late"], 1)
        self.assertEqual(jan_ps["APS"]["classified"], 0)

        hist = {item["id"]: item["count"] for item in payload["histogram"]["buckets"]}
        self.assertEqual(hist["neg_13_1"], 1)
        self.assertEqual(hist["on_time"], 2)
        self.assertEqual(hist["d15_30"], 1)

    def test_months_follow_delivery_not_po_due(self):
        sheets = [_ps("NPS26-9", ship="2026-03-02", due="2026-01-20", pp_type="NPS")]
        payload = aggregate_on_time_delivery(sheets, year=2026, pp_types=["NPS"])
        self.assertEqual(payload["by_month"][2]["late"], 1)
        self.assertEqual(payload["by_month"][0]["late"], 0)

    def test_filter_excludes_other_years(self):
        rows = classify_process_sheets(
            [_ps("NPS26-x", ship="2025-12-31", due="2025-12-01")]
        )
        filtered = filter_process_sheets(rows, year=2026, pp_types=["NPS"])
        self.assertEqual(filtered, [])

    def test_keeps_salesperson_and_filters_by_it(self):
        sheets = [
            _ps(
                "NPS26-a",
                ship="2026-01-20",
                due="2026-01-31",
                pp_type="NPS",
                sales_person_code="SP1",
                sales_person_name="Jane Tan",
            ),
            _ps(
                "NPS26-b",
                ship="2026-01-22",
                due="2026-01-10",
                pp_type="NPS",
                sales_person_code="SP2",
                sales_person_name="Alex Ng",
            ),
        ]
        classified = classify_process_sheets(sheets)
        by_ps = {row["process_sheet_no"]: row for row in classified}
        self.assertEqual(by_ps["NPS26-a"]["sales_person_name"], "Jane Tan")
        self.assertEqual(by_ps["NPS26-b"]["sales_person_name"], "Alex Ng")
        payload = aggregate_on_time_delivery(
            sheets,
            year=2026,
            pp_types=["NPS"],
            sales_persons=["Jane Tan"],
        )
        self.assertEqual(payload["summary"]["classified"], 1)
        self.assertEqual(payload["rows"][0]["process_sheet_no"], "NPS26-a")
        people = {item["id"]: item["label"] for item in payload["salespeople"]}
        self.assertIn("jane tan", people)
        self.assertEqual(people["jane tan"], "Jane Tan (SP1)")
        self.assertEqual(len(payload["source_rows"]), 2)

    def test_overview_splits_aps_nps_and_alice_pps(self):
        sheets = [
            _ps("APS26-1", ship="2026-01-10", due="2026-01-20", pp_type="APS"),
            _ps("NPS26-1", ship="2026-02-10", due="2026-02-01", pp_type="NPS"),
            _ps(
                "PPS26-alice",
                ship="2026-03-01",
                due="2026-03-10",
                pp_type="PPS",
                sales_person_name="Alice Tan",
                sales_person_code="ALICE",
            ),
            _ps(
                "PPS26-other",
                ship="2026-03-02",
                due="2026-03-01",
                pp_type="PPS",
                sales_person_name="Jane Tan",
            ),
        ]
        classified = classify_process_sheets(sheets)
        sections = {item["id"]: item for item in build_overview_sections(classified, year=2026)}
        self.assertEqual(sections["aps"]["summary"]["classified"], 1)
        self.assertEqual(sections["aps"]["summary"]["early"], 1)
        self.assertEqual(sections["nps"]["summary"]["classified"], 1)
        self.assertEqual(sections["nps"]["summary"]["late"], 1)
        self.assertEqual(sections["pps"]["subtitle"], "Alice only")
        self.assertEqual(sections["pps"]["summary"]["classified"], 1)
        self.assertEqual(sections["pps"]["rows"][0]["process_sheet_no"], "PPS26-alice")
        self.assertTrue(sections["pps"]["rows"][0]["on_time"])


class RouteTests(unittest.TestCase):
    def setUp(self):
        from pathlib import Path

        root = Path(__file__).resolve().parents[1]
        app = Flask(
            __name__,
            template_folder=str(root / "templates"),
            static_folder=str(root / "static"),
        )
        app.register_blueprint(on_time_delivery_bp)
        app.testing = True

        @app.context_processor
        def _nav_context():
            return {
                "machinist_board_path": "/machinist-board",
                "machinist_board_canonical_path": "/machinist-board",
                "finishing_queue_path": "/finishing-queue",
                "driver_view_path": "/driver-view",
                "planner_path": "/",
                "planner_gate_enabled": False,
                "planner_authenticated": False,
                "reports_gate_enabled": False,
                "finance_gate_enabled": False,
                "admin_gate_enabled": False,
                "scheduler_asset_version": "test",
                "active": "on_time_delivery",
            }

        self.client = app.test_client()

    def test_page_renders_charts_tabs_and_filters(self):
        response = self.client.get("/on-time-delivery")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("On-time delivery", html)
        self.assertIn("otd-month-chart", html)
        self.assertIn("otd-ps-chart", html)
        self.assertNotIn("data-otd-basis", html)
        self.assertNotIn("Month basis", html)
        self.assertIn("data-otd-tab=\"overview\"", html)
        self.assertIn("otd-salesperson-btn", html)
        self.assertIn('data-otd-benchmark="po_due"', html)
        self.assertIn('data-otd-benchmark="proposed_edd"', html)
        self.assertIn('id="otd-export-pdf"', html)
        self.assertIn('id="otd-benchmark-ref"', html)
        self.assertIn('data-otd-segment="due"', html)
        self.assertIn('id="otd-summary"', html)
        self.assertIn('id="otd-month-table"', html)
        ops_menu = re.search(r'id="dd-ops"(.*?)id="dd-sales-prod"', html, re.S)
        reports_menu = re.search(r'id="dd-reports"(.*?)id="dd-queries-data"', html, re.S)
        self.assertIsNotNone(ops_menu)
        self.assertIsNotNone(reports_menu)
        self.assertNotIn('href="/on-time-delivery"', ops_menu.group(1))
        self.assertIn('href="/on-time-delivery"', reports_menu.group(1))

    @patch("planning.on_time_delivery_route._fetch_delivered_process_sheets")
    def test_report_endpoint_aggregates_process_sheets(self, fetch_rows):
        fetch_rows.return_value = [
            _ps(
                "NPS26-1",
                ship="2026-06-10",
                due="2026-06-01",
                pp_type="NPS",
                sales_person_name="Jane Tan",
            ),
            _ps(
                "APS26-1",
                ship="2026-06-01",
                due="2026-06-10",
                pp_type="APS",
                sales_person_name="Alex Ng",
            ),
        ]
        response = self.client.get(
            "/api/on-time-delivery/report?year=2026&pp_types=APS,NPS&sales_person=Jane Tan"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["summary"]["classified"], 1)
        self.assertEqual(payload["summary"]["late"], 1)
        self.assertEqual(payload["rows"][0]["sales_person_name"], "Jane Tan")
        self.assertEqual(len(payload["source_rows"]), 2)
        self.assertEqual(len(payload["overview"]), 3)
        self.assertEqual(payload["overview"][0]["id"], "aps")
        fetch_rows.assert_called_once()

    @patch("planning.on_time_delivery_route._fetch_delivered_process_sheets")
    def test_defaults_to_aps_nps(self, fetch_rows):
        fetch_rows.return_value = []
        response = self.client.get("/api/on-time-delivery/report?year=2026")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["pp_types"], ["APS", "NPS"])

    def test_rejects_bad_year(self):
        response = self.client.get("/api/on-time-delivery/report?year=1999")
        self.assertEqual(response.status_code, 400)

    @patch("planning.on_time_delivery_route._fetch_delivered_process_sheets")
    def test_pdf_uses_selected_benchmark(self, fetch_rows):
        fetch_rows.return_value = [
            _ps(
                "NPS26-1",
                ship="2026-06-10",
                due="2026-06-01",
                production_due="2026-06-12",
                pp_type="NPS",
            ),
        ]
        response = self.client.get(
            "/api/on-time-delivery/report.pdf?year=2026&pp_types=NPS&benchmark=proposed_edd"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertTrue(response.data.startswith(b"%PDF"))
        self.assertIn("proposed-edd", response.headers["Content-Disposition"])
        fetch_rows.assert_called_once()


if __name__ == "__main__":
    unittest.main()
