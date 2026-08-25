"""RFQ checker mapping, cycle-time math, Excel ingest, and routes."""
from __future__ import annotations

import io
import os
import unittest
from unittest.mock import patch

from openpyxl import Workbook

from app import app
from planning.rfq_checker_service import (
    apply_column_map,
    build_mapped_lines,
    calculate_times,
    format_lead_time,
    heuristic_column_map,
    invert_field_map,
    normalize_part_no,
    parse_workbook_bytes,
    parse_yn,
)


def _xlsx_bytes() -> bytes:
    book = Workbook()
    odd = book.active
    odd.title = "RFQ in"
    odd.append(["Item Code", "Qty pcs", "Customer", "Quote No", "CT min", "Notes"])
    odd.append(["BB18-KS0526-28", 104, "OSS", "6000373725", 180, "Thread gauges"])
    odd.append(["NEW-PART-01", 10, "ACME", "6000001", "", ""])
    archive = book.create_sheet("Archive")
    archive.append(
        [
            "Part No.", "RFQ", "Cust.", "Salesperson", "QTY", "Opns", "Assignment",
            "Machines", "Total C/T (mins)", "Machine Hours", "Total Hours", "Days",
            "Lead Time", "Need Tooling?", "Need Fixture?", "Remark",
        ]
    )
    archive.append(
        [
            "BB18-KS0526-28", "6000373725", "OSS", "Daniel", 104, "2TN 1ML", "",
            "22,10,30,29", 180, 312, 312, 31.2, "6-7wks", "N", "N", "Thread gauges",
        ]
    )
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


class RfqCheckerServiceTests(unittest.TestCase):
    def test_hours_and_lead_time_match_archive_sample(self):
        calc = calculate_times(104, 180)
        self.assertEqual(calc["machine_hours"], 312.0)
        self.assertEqual(calc["total_hours"], 312.0)
        self.assertEqual(calc["days"], 31.2)
        self.assertEqual(calc["lead_time"], "6-7wks")
        second = calculate_times(150, 84)
        self.assertEqual(second["total_hours"], 210.0)
        self.assertEqual(second["days"], 21.0)
        self.assertEqual(second["lead_time"], "4-5wks")

    def test_format_lead_time_and_yn(self):
        self.assertEqual(format_lead_time(0), "")
        self.assertEqual(format_lead_time(5), "1wk")
        self.assertEqual(parse_yn("yes"), "Y")
        self.assertEqual(parse_yn("No"), "N")
        self.assertEqual(normalize_part_no("bb18 ks0526_28"), "BB18-KS0526-28")

    def test_heuristic_maps_varying_and_archive_headers(self):
        varying = heuristic_column_map(["Item Code", "Qty pcs", "Customer", "Quote No", "CT min", "Notes"])
        self.assertEqual(varying["Item Code"], "part_no")
        self.assertEqual(varying["Qty pcs"], "qty")
        self.assertEqual(varying["Quote No"], "rfq")
        self.assertEqual(varying["CT min"], "total_ct_mins")
        self.assertEqual(varying["Notes"], "remark")
        archive = heuristic_column_map(["Part No.", "QTY", "Assignment", "Remark", "Total C/T (mins)"])
        self.assertEqual(archive["Part No."], "part_no")
        self.assertEqual(archive["Assignment"], "assignment")
        self.assertEqual(archive["Total C/T (mins)"], "total_ct_mins")

    def test_invert_field_map_accepts_either_direction(self):
        self.assertEqual(invert_field_map({"part_no": "Item Code"}), {"Item Code": "part_no"})
        self.assertEqual(invert_field_map({"Item Code": "part_no"}), {"Item Code": "part_no"})

    def test_apply_map_calculates_and_fills_history(self):
        mapped = apply_column_map(
            {"Item Code": "BB18-KS0526-28", "Qty pcs": "104", "CT min": "180"},
            {"Item Code": "part_no", "Qty pcs": "qty", "CT min": "total_ct_mins"},
        )
        self.assertEqual(mapped["part_no"], "BB18-KS0526-28")
        self.assertEqual(mapped["total_hours"], 312.0)
        lines = build_mapped_lines(
            [
                {"Item Code": "BB18-KS0526-28", "Qty pcs": 104, "CT min": ""},
                {"Item Code": "NEW-PART-01", "Qty pcs": 10, "CT min": ""},
            ],
            {"Item Code": "part_no", "Qty pcs": "qty", "CT min": "total_ct_mins"},
            {
                "BB18-KS0526-28": {
                    "part_no": "BB18-KS0526-28",
                    "opns": "2TN 1ML",
                    "machines": "22,10,30,29",
                    "total_ct_mins": 180,
                }
            },
        )
        self.assertEqual(lines[0]["match_status"], "matched")
        self.assertEqual(lines[0]["opns"], "2TN 1ML")
        self.assertEqual(lines[0]["total_hours"], 312.0)
        self.assertIn("total_ct_mins", lines[0]["filled_from_history"])
        self.assertEqual(lines[1]["match_status"], "new")

    def test_parse_workbook_reads_sheets(self):
        sheets = parse_workbook_bytes(_xlsx_bytes(), "rfq.xlsx")
        names = [sheet["name"] for sheet in sheets]
        self.assertIn("RFQ in", names)
        self.assertIn("Archive", names)
        incoming = next(sheet for sheet in sheets if sheet["name"] == "RFQ in")
        self.assertEqual(incoming["row_count"], 2)
        self.assertEqual(incoming["rows"][0]["Item Code"], "BB18-KS0526-28")


class RfqCheckerRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_pages_render(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
            library = self.client.get("/archive/rfq-checker")
            upload = self.client.get("/archive/rfq-checker/upload")
        self.assertEqual(library.status_code, 200)
        self.assertIn("RFQ Checker", library.get_data(as_text=True))
        self.assertEqual(upload.status_code, 200)
        self.assertIn("Upload RFQ Excel", upload.get_data(as_text=True))

    def test_short_path_redirects(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
            response = self.client.get("/rfq-checker")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["Location"].endswith("/archive/rfq-checker"))

    def test_upload_requires_file(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
            response = self.client.post("/api/rfq-checker/upload")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Excel", response.get_json()["error"])

    def test_meta_reports_llm_status(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "RFQ_LLM_API_KEY": ""}):
            response = self.client.get("/api/rfq-checker/meta")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["ok"])
        self.assertIn("part_no", body["field_labels"])
        self.assertEqual(body["hours_per_day"], 10)


if __name__ == "__main__":
    unittest.main()
