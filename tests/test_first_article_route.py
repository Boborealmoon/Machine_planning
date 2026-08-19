"""Tests for First Article Tracker (Archive)."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.first_article_service import (
    flatten_sales_order_jobs,
    job_from_sales_order_pp,
    search_jobs,
)


def _pp(**overrides):
    row = {
        "process_sheet_no": "APS-1001",
        "pp_voucher_no": "PP-1001",
        "inventory_code": "8816-01",
        "description": "Valve body",
        "pp_qty": 12,
        "due_date": "2026-09-01",
        "queued_machines": ["CNC-01"],
        "coway_proposed_edd": "",
        "partials": [],
    }
    row.update(overrides)
    return row


class FirstArticleServiceTests(unittest.TestCase):
    def test_job_uses_coway_edd_from_partial_when_header_blank(self):
        pp = _pp(
            partials=[
                {"pp_partial_no": 1, "coway_proposed_edd": "2026-08-20"},
                {"pp_partial_no": 2, "coway_proposed_edd": "2026-08-22"},
            ]
        )
        job = job_from_sales_order_pp({"sales_order_no": "SO-9", "customer_name": "Coway"}, pp)
        self.assertEqual(job["coway_proposed_edd"], "2026-08-20")
        self.assertEqual(job["part_no"], "8816-01")
        self.assertEqual(job["total_qty"], 12)
        self.assertEqual(job["po_due_date"], "2026-09-01")
        self.assertEqual(job["machine_cnc"], "CNC-01")

    def test_job_prefers_header_coway_edd(self):
        pp = _pp(
            coway_proposed_edd="2026-07-15",
            partials=[{"coway_proposed_edd": "2026-08-01"}],
        )
        job = job_from_sales_order_pp({"sales_order_no": "SO-9"}, pp)
        self.assertEqual(job["coway_proposed_edd"], "2026-07-15")

    def test_flatten_dedupes_by_process_sheet(self):
        orders = [
            {
                "sales_order_no": "SO-1",
                "pp_vouchers": [_pp(), _pp(pp_voucher_no="PP-1001B")],
            }
        ]
        jobs = flatten_sales_order_jobs(orders)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["process_sheet_no"], "APS-1001")

    def test_search_marks_already_flagged(self):
        jobs = flatten_sales_order_jobs(
            [{"sales_order_no": "SO-1", "pp_vouchers": [_pp(), _pp(process_sheet_no="NPS-22", pp_voucher_no="PP-22", inventory_code="AA-1")]}]
        )
        hits = search_jobs(jobs, "APS", flagged_keys={"APS-1001"})
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["already_flagged"])
        other = search_jobs(jobs, "NPS-22", flagged_keys={"APS-1001"})
        self.assertEqual(len(other), 1)
        self.assertFalse(other[0]["already_flagged"])


class FirstArticleRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_flag_requires_process_sheet(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post("/api/first-article", json={})

        self.assertEqual(response.status_code, 400)
        self.assertIn("process_sheet_no", response.get_json()["error"])

    def test_patch_without_fields_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.patch("/api/first-article/1", json={})

        self.assertEqual(response.status_code, 400)
        self.assertIn("No editable fields", response.get_json()["error"])

    def test_pic_add_requires_name(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post("/api/first-article/pics", json={})

        self.assertEqual(response.status_code, 400)
        self.assertIn("PIC name", response.get_json()["error"])

    def test_flag_list_patch_delete(self):
        created = {
            "first_article_id": 3,
            "process_sheet_no": "APS-1001",
            "part_no": "8816-01",
            "coway_proposed_edd": "2026-08-20",
            "remarks": "",
        }
        patched = {**created, "remarks": "FA in progress", "tooling_mode": "text"}

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.flag_process_sheet",
                return_value=(created, True),
            ) as flag_fn:
                create_res = self.client.post(
                    "/api/first-article",
                    json={"process_sheet_no": "APS-1001"},
                )
            with patch("planning.first_article_route.load_pics", return_value=[]):
                with patch(
                    "planning.first_article_route.list_tracker_rows",
                    return_value=[created],
                ):
                    with patch("planning.first_article_route.planner_db") as planner_db:
                        planner_db.return_value.__enter__.return_value = object()
                        list_res = self.client.get("/api/first-article")
            with patch(
                "planning.first_article_route.update_tracker_row",
                return_value=patched,
            ) as update_fn:
                patch_res = self.client.patch(
                    "/api/first-article/3",
                    json={"remarks": "FA in progress", "tooling_mode": "text"},
                )
            with patch(
                "planning.first_article_route.unflag_process_sheet",
                return_value=True,
            ) as unflag_fn:
                delete_res = self.client.delete("/api/first-article/3")

        self.assertEqual(create_res.status_code, 201)
        self.assertEqual(create_res.get_json()["row"]["process_sheet_no"], "APS-1001")
        flag_fn.assert_called_once()
        self.assertEqual(list_res.status_code, 200)
        self.assertEqual(list_res.get_json()["count"], 1)
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.get_json()["row"]["remarks"], "FA in progress")
        update_fn.assert_called_once()
        self.assertEqual(delete_res.status_code, 200)
        unflag_fn.assert_called_once_with(3)

    def test_invalid_check_mode_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.update_tracker_row",
                side_effect=ValueError("tooling_mode must be tick or text"),
            ):
                response = self.client.patch(
                    "/api/first-article/3",
                    json={"tooling_mode": "maybe"},
                )

        self.assertEqual(response.status_code, 400)
        self.assertIn("tick or text", response.get_json()["error"])
