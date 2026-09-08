"""On-time delivery aggregations - process sheet PO due vs last delivery."""
from __future__ import annotations

import unittest
from unittest.mock import patch

from flask import Flask

from planning.on_time_delivery import (
    MONTH_BASIS_DELIVERY,
    MONTH_BASIS_PO_DUE,
    aggregate_on_time_delivery,
    collapse_to_process_sheets,
    filter_process_sheets,
)
from planning.on_time_delivery_route import on_time_delivery_bp


def _ship(
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
    so_due: str | None = None,
    sales_person_code: str = "",
    sales_person_name: str = "",
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
        "shipment_date": ship,
        "so_due_date": so_due if so_due is not None else due,
        "due_date": due,
        "qty_issued": qty,
        "total_home_amt": value,
    }


class CollapseTests(unittest.TestCase):
    def test_last_delivery_vs_original_po_due(self):
        rows = collapse_to_process_sheets(
            [
                _ship("NPS26-0001", ship="2026-02-01", due="2026-03-10", so_due="2026-03-10"),
                _ship("NPS26-0001", ship="2026-03-20", due="2026-03-01", so_due="2026-03-10"),
            ]
        )
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["po_due_date"], "2026-03-10")
        self.assertEqual(row["delivery_date"], "2026-03-20")
        self.assertEqual(row["days"], 10)
        self.assertEqual(row["status"], "late")
        self.assertFalse(row["on_time"])
        self.assertEqual(row["shipment_count"], 2)
        self.assertEqual(row["qty"], 2)
        self.assertEqual(row["value"], 200)

    def test_early_counts_as_on_time(self):
        rows = collapse_to_process_sheets(
            [_ship("APS26-0002", ship="2026-01-20", due="2026-01-31")]
        )
        self.assertEqual(rows[0]["status"], "early")
        self.assertTrue(rows[0]["on_time"])
        self.assertEqual(rows[0]["days"], -11)

    def test_exact_due_is_on_time(self):
        rows = collapse_to_process_sheets(
            [_ship("APS26-0003", ship="2026-04-15", due="2026-04-15")]
        )
        self.assertEqual(rows[0]["status"], "on_time")
        self.assertTrue(rows[0]["on_time"])
        self.assertEqual(rows[0]["days"], 0)

    def test_prefers_so_due_over_partial_schedule(self):
        rows = collapse_to_process_sheets(
            [
                _ship(
                    "NPS26-0004",
                    ship="2026-02-24",
                    due="2026-02-20",
                    so_due="2026-01-29",
                )
            ]
        )
        self.assertEqual(rows[0]["po_due_date"], "2026-01-29")
        self.assertEqual(rows[0]["days"], 26)


class AggregateTests(unittest.TestCase):
    def test_segregates_by_month_and_ps_type(self):
        shipments = [
            _ship("NPS26-1", ship="2026-01-20", due="2026-01-31", pp_type="NPS"),
            _ship("NPS26-2", ship="2026-01-28", due="2026-01-10", pp_type="NPS"),
            _ship("APS26-1", ship="2026-02-05", due="2026-02-05", pp_type="APS"),
            _ship("MPS26-1", ship="2026-01-15", due="2026-01-01", pp_type="MPS"),
            _ship("NPS26-3", ship="2026-03-01", due="2026-03-01"),  # missing dates skipped later? has dates
        ]
        payload = aggregate_on_time_delivery(
            shipments,
            year=2026,
            pp_types=["APS", "NPS"],
            month_basis=MONTH_BASIS_DELIVERY,
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

    def test_month_basis_po_due_uses_due_month(self):
        shipments = [
            _ship("NPS26-9", ship="2026-03-02", due="2026-01-20", pp_type="NPS"),
        ]
        by_delivery = aggregate_on_time_delivery(
            shipments, year=2026, pp_types=["NPS"], month_basis=MONTH_BASIS_DELIVERY
        )
        by_due = aggregate_on_time_delivery(
            shipments, year=2026, pp_types=["NPS"], month_basis=MONTH_BASIS_PO_DUE
        )
        self.assertEqual(by_delivery["by_month"][2]["late"], 1)
        self.assertEqual(by_due["by_month"][0]["late"], 1)
        self.assertEqual(by_due["by_month"][2]["late"], 0)

    def test_filter_excludes_other_years(self):
        rows = collapse_to_process_sheets(
            [_ship("NPS26-x", ship="2025-12-31", due="2025-12-01")]
        )
        filtered = filter_process_sheets(
            rows, year=2026, pp_types=["NPS"], month_basis=MONTH_BASIS_DELIVERY
        )
        self.assertEqual(filtered, [])

    def test_keeps_salesperson_and_filters_by_it(self):
        shipments = [
            _ship(
                "NPS26-a",
                ship="2026-01-20",
                due="2026-01-31",
                pp_type="NPS",
                sales_person_code="SP1",
                sales_person_name="Jane Tan",
            ),
            _ship(
                "NPS26-b",
                ship="2026-01-22",
                due="2026-01-10",
                pp_type="NPS",
                sales_person_code="SP2",
                sales_person_name="Alex Ng",
            ),
        ]
        collapsed = collapse_to_process_sheets(shipments)
        by_ps = {row["process_sheet_no"]: row for row in collapsed}
        self.assertEqual(by_ps["NPS26-a"]["sales_person_name"], "Jane Tan")
        self.assertEqual(by_ps["NPS26-b"]["sales_person_name"], "Alex Ng")
        payload = aggregate_on_time_delivery(
            shipments,
            year=2026,
            pp_types=["NPS"],
            month_basis=MONTH_BASIS_DELIVERY,
            sales_persons=["Jane Tan"],
        )
        self.assertEqual(payload["summary"]["classified"], 1)
        self.assertEqual(payload["rows"][0]["process_sheet_no"], "NPS26-a")
        people = {item["id"]: item["label"] for item in payload["salespeople"]}
        self.assertIn("jane tan", people)
        self.assertEqual(people["jane tan"], "Jane Tan (SP1)")
        self.assertEqual(len(payload["source_rows"]), 2)


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

    def test_page_renders_charts_and_filters(self):
        response = self.client.get("/on-time-delivery")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("On-time delivery", html)
        self.assertIn("otd-month-chart", html)
        self.assertIn("otd-ps-chart", html)
        self.assertIn("data-otd-basis=\"po_due\"", html)
        self.assertIn("otd-salesperson-btn", html)
        self.assertRegex(html, r'id="dd-ops"[\s\S]*href="/on-time-delivery"')
        self.assertNotRegex(html, r'id="dd-reports"[\s\S]*href="/on-time-delivery"')

    @patch("planning.on_time_delivery_route._fetch_ytd_report")
    def test_report_endpoint_aggregates_ytd_shipments(self, fetch_ytd):
        fetch_ytd.return_value = {
            "shipments_attributed": [
                _ship(
                    "NPS26-1",
                    ship="2026-06-10",
                    due="2026-06-01",
                    pp_type="NPS",
                    sales_person_name="Jane Tan",
                ),
                _ship(
                    "APS26-1",
                    ship="2026-06-01",
                    due="2026-06-10",
                    pp_type="APS",
                    sales_person_name="Alex Ng",
                ),
            ]
        }
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
        fetch_ytd.assert_called_once()

    @patch("planning.on_time_delivery_route._fetch_ytd_report")
    def test_defaults_to_aps_nps(self, fetch_ytd):
        fetch_ytd.return_value = {"shipments_attributed": []}
        response = self.client.get("/api/on-time-delivery/report?year=2026")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["pp_types"], ["APS", "NPS"])

    def test_rejects_bad_year(self):
        response = self.client.get("/api/on-time-delivery/report?year=1999")
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
