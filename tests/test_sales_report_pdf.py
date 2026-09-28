"""Sales report management PDF."""
from __future__ import annotations

import unittest

from flask import Flask

from planning.sales_report_pdf import build_sales_report_pdf, prepare_sales_report_pdf
from planning.sales_report_route import sales_report_bp


def _sample_payload() -> dict:
    spans = [{"label": f"M{i}", "span": 1, "tone": "past"} for i in range(1, 8)]
    spans.append({"label": "Sep-26", "span": 2, "tone": "current"})
    spans.append({"label": "Oct-26", "span": 1, "tone": "future"})
    subheads = ["Shipped"] * 7 + ["Backlog", "Onhand", "Onhand"]
    values = ["1,000.00"] * 7 + ["3,085.50", "63,779.23", "224,610.35"]

    def row(label, emphasis=""):
        return {
            "label": label,
            "emphasis": emphasis,
            "values": values,
            "open_year": "512,904.55",
            "open_all": "866,163.79",
        }

    return {
        "year": 2026,
        "focus_month": 9,
        "focus_label": "September 2026",
        "segment": "APS, NPS",
        "date_basis": "PO due date",
        "posted_basis": False,
        "filters": "",
        "generated_at": "24 Sep 2026, 15:54",
        "reconciliation": {
            "ok": True,
            "so_remaining": "866,163.79",
            "pp_allocated": "866,163.79",
            "shipped": "258,968.86",
        },
        "notes": [
            "NPS holds most of the September open value.",
            "Open remaining reconciles to the sales-order line total for this scope.",
        ],
        "year_kpis": [
            {"label": "YTD shipped", "value": "7,000.00", "sub": "Includes 1,000.00 backlog cleared", "tone": "shipped"},
            {"label": "Backlog now", "value": "3,085.50", "sub": "Still open", "tone": "cleared"},
            {"label": "Onhand now", "value": "63,779.23", "sub": "PO due this month", "tone": "on-hand"},
            {"label": "Sales left to achieve", "value": "41.8%", "sub": "outstanding", "tone": "achieve"},
        ],
        "month_kpis": [
            {"label": "Backlog", "value": "3,085.50", "sub": "2 lines", "tone": "cleared"},
            {"label": "Onhand", "value": "63,779.23", "sub": "25 lines", "tone": "on-hand"},
            {"label": "Shipped this month", "value": "258,968.86", "sub": "75 lines", "tone": "shipped"},
            {"label": "Booked this month", "value": "0.00", "sub": "0 lines", "tone": "booked"},
        ],
        "year_table": {
            "spans": spans,
            "subheads": subheads,
            "open_remaining": True,
            "open_year_label": "Due 2026",
            "open_all_label": "All years",
            "rows": [row("APS"), row("NPS"), row("Total", "total")],
        },
        "timing": {
            "headers": ["Month", "Backlog delivered", "On-time", "Early", "Total shipped"],
            "blocks": [
                {
                    "label": "APS",
                    "rows": [["Jan-26", "10.00", "20.00", "0.00", "30.00"]],
                    "total": ["Total", "10.00", "20.00", "0.00", "30.00"],
                },
                {
                    "label": "NPS",
                    "rows": [["Jan-26", "5.00", "15.00", "1.00", "21.00"]],
                    "total": ["Total", "5.00", "15.00", "1.00", "21.00"],
                },
            ],
        },
        "breakdown": {
            "title": "Breakdown by PP type",
            "subtitle": "September 2026 open position",
            "headers": ["PP type", "Backlog", "Onhand", "Shipped", "Booked"],
            "rows": [
                ["APS", "0.00", "2,305.50", "10.00", "0.00"],
                ["NPS", "3,085.50", "61,473.73", "248,968.86", "0.00"],
                ["Total", "3,085.50", "63,779.23", "258,968.86", "0.00"],
            ],
            "numeric": [1, 2, 3, 4],
        },
        "groups": [
            {
                "title": "By salesperson",
                "subtitle": "September 2026",
                "headers": ["Salesperson", "Backlog", "Onhand", "Shipped", "Booked"],
                "rows": [
                    ["Alex Tan (AT)", "3,085.50", "40,000.00", "100,000.00", "0.00"],
                    ["Total", "3,085.50", "63,779.23", "258,968.86", "0.00"],
                ],
                "numeric": [1, 2, 3, 4],
            },
            {
                "title": "By customer",
                "subtitle": "September 2026",
                "headers": ["Customer", "Backlog", "Onhand", "Shipped", "Booked"],
                "rows": [
                    ["Acme Parts (ACME)", "0.00", "20,000.00", "80,000.00", "0.00"],
                    ["Total", "3,085.50", "63,779.23", "258,968.86", "0.00"],
                ],
                "numeric": [1, 2, 3, 4],
            },
        ],
        "sections": [
            {
                "title": "Backlog",
                "hint": "Still open, PO due before this month",
                "line_count": 1,
                "total": "3,085.50",
                "columns": ["Sales order", "Line", "PS", "Part", "Customer", "Salesperson", "Due", "Qty", "Home amt"],
                "numeric": [7, 8],
                "widths": [1.3, 0.5, 1.2, 2.0, 1.6, 1.4, 0.95, 0.65, 1.05],
                "groups": [
                    {
                        "type": "NPS",
                        "line_count": 1,
                        "rows": [[
                            "SO/1001", "1", "NPS26-0008", "PIN-1 - Guide pin",
                            "Acme Parts (ACME)", "Alex Tan (AT)", "2026-08-12", "40", "3,085.50",
                        ]],
                        "totals": ["Total", "", "", "", "", "", "", "40", "3,085.50"],
                    }
                ],
            },
            {
                "title": "Onhand",
                "hint": "Unfinished open value, PO due in this month",
                "line_count": 1,
                "total": "2,305.50",
                "columns": ["Sales order", "Line", "PS", "Part", "Customer", "Salesperson", "Due", "Qty", "Home amt"],
                "numeric": [7, 8],
                "widths": [1.3, 0.5, 1.2, 2.0, 1.6, 1.4, 0.95, 0.65, 1.05],
                "groups": [
                    {
                        "type": "APS",
                        "line_count": 1,
                        "rows": [[
                            "SO/1002", "2", "APS26-0011", "HUB-4",
                            "Beta Works (BETA)", "Alex Tan (AT)", "2026-09-18", "12", "2,305.50",
                        ]],
                        "totals": ["Total", "", "", "", "", "", "", "12", "2,305.50"],
                    }
                ],
            },
        ],
    }


class SalesReportPdfModelTests(unittest.TestCase):
    def test_prepare_keeps_management_sections(self):
        model = prepare_sales_report_pdf(_sample_payload())
        self.assertEqual(model["filename"], "Sales-Report-2026-09-APS-NPS.pdf")
        self.assertIn("NPS holds most", model["notes"][0])
        self.assertEqual(len(model["year_kpis"]), 4)
        self.assertEqual(len(model["month_kpis"]), 4)
        self.assertEqual(model["year_table"]["rows"][-1]["label"], "Total")
        self.assertEqual(len(model["timing"]["blocks"]), 2)
        self.assertEqual(model["breakdown"]["title"], "Breakdown by PP type")
        self.assertEqual([item["title"] for item in model["groups"]], ["By salesperson", "By customer"])
        self.assertEqual([item["title"] for item in model["sections"]], ["Backlog", "Onhand"])
        self.assertIn("balanced", model["reconciliation"])

    def test_empty_payload_is_rejected(self):
        with self.assertRaises(ValueError):
            prepare_sales_report_pdf({})

    def test_pdf_contains_the_reading_and_line_detail(self):
        pdf, filename = build_sales_report_pdf(_sample_payload(), compress=False)
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertGreater(len(pdf), 2000)
        self.assertEqual(filename, "Sales-Report-2026-09-APS-NPS.pdf")
        self.assertIn(b"NPS holds most of the September open value.", pdf)
        self.assertIn(b"SO/1001", pdf)
        self.assertIn(b"Breakdown by PP type", pdf)
        self.assertIn(b"Page 1 of", pdf)

    def test_posted_basis_year_pack_still_builds(self):
        payload = {
            "year": 2026,
            "segment": "APS",
            "date_basis": "SO posted date",
            "posted_basis": True,
            "focus_label": "2026 full year",
            "year_kpis": [{"label": "YTD shipped", "value": "10.00", "sub": "shipped", "tone": "shipped"}],
            "year_table": {
                "spans": [{"label": "Jan-26", "span": 1, "tone": "past"}],
                "subheads": ["Sales"],
                "open_remaining": False,
                "rows": [{"label": "APS", "values": ["10.00"], "emphasis": ""}],
            },
        }
        model = prepare_sales_report_pdf(payload)
        self.assertIsNone(model["timing"])
        self.assertFalse(model["year_table"]["open_remaining"])
        pdf, filename = build_sales_report_pdf(payload, compress=False)
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertEqual(filename, "Sales-Report-2026-APS.pdf")
        self.assertIn(b"sales-order posted date", pdf)


class SalesReportPdfRouteTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(sales_report_bp)
        app.testing = True
        self.client = app.test_client()

    def test_export_returns_pdf(self):
        res = self.client.post("/api/sales-report/export-pdf", json=_sample_payload())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.mimetype, "application/pdf")
        self.assertTrue(res.data.startswith(b"%PDF"))
        self.assertIn("Sales-Report-2026-09-APS-NPS.pdf", res.headers.get("Content-Disposition", ""))

    def test_export_rejects_a_bad_body(self):
        res = self.client.post(
            "/api/sales-report/export-pdf",
            data="[]",
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)
