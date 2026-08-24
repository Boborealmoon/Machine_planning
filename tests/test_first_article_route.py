"""Tests for First Article Tracker (Archive)."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.first_article_service import (
    flag_process_sheets,
    flatten_sales_order_jobs,
    job_from_sales_order_pp,
    list_flag_candidates,
    lookup_sales_order_job,
    search_flag_candidates,
    search_jobs,
    _live_job_map,
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

    def test_list_flag_candidates_filters_by_ps_type(self):
        jobs = flatten_sales_order_jobs(
            [{
                "sales_order_no": "SO-1",
                "pp_vouchers": [
                    _pp(),
                    _pp(process_sheet_no="NPS26-0374", pp_voucher_no="PP-N1", inventory_code="88D012"),
                    _pp(process_sheet_no="PPS26-9", pp_voucher_no="PP-P1", inventory_code="PP-PART"),
                ],
            }]
        )

        class FakeCon:
            def execute(self, *args, **kwargs):
                return self

            def fetchall(self):
                return []

            def fetchone(self):
                return None

        with patch("planning.first_article_service._sales_order_jobs", return_value=jobs):
            with patch("planning.first_article_service.planner_db") as planner_db:
                planner_db.return_value.__enter__.return_value = FakeCon()
                payload = list_flag_candidates(ps_type_filter="NPS")

        self.assertEqual(payload["matched"], 1)
        self.assertEqual(payload["rows"][0]["process_sheet_no"], "NPS26-0374")
        self.assertEqual(payload["rows"][0]["ps_type"], "NPS")
        types = {item["ps_type"]: item["count"] for item in payload["types"]}
        self.assertEqual(types.get("NPS"), 1)
        self.assertEqual(types.get("APS"), 1)
        self.assertEqual(types.get("PPS"), 1)

    def test_flag_process_sheets_rejects_empty(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            flag_process_sheets([])
        with self.assertRaisesRegex(ValueError, "at least one"):
            flag_process_sheets([{"process_sheet_no": "  "}])

    def test_live_job_map_uses_stale_cache_without_erp_rebuild(self):
        payload = {
            "active": [
                {
                    "sales_order_no": "SO-1",
                    "customer_name": "Coway",
                    "pp_vouchers": [_pp()],
                }
            ]
        }
        with patch("planning.erp_route_cache.get", return_value=payload):
            with patch("planning.sales_orders_route._fetch_sales_orders") as fetch:
                mapping = _live_job_map()
                fetch.assert_not_called()
        self.assertIn("APS-1001", mapping)
        self.assertEqual(mapping["APS-1001"]["part_no"], "8816-01")
        self.assertEqual(mapping["APS-1001"]["coway_proposed_edd"], "")

    def test_list_live_map_does_not_rebuild_when_cache_empty(self):
        with patch("planning.erp_route_cache.get", return_value=None):
            with patch("planning.sales_orders_route._fetch_sales_orders") as fetch:
                mapping = _live_job_map()
                fetch.assert_not_called()
        self.assertEqual(mapping, {})

    def test_search_uses_lite_rebuild_when_cache_empty(self):
        payload = {
            "active": [
                {
                    "sales_order_no": "SO-1",
                    "customer_name": "Coway",
                    "pp_vouchers": [_pp()],
                }
            ]
        }

        class FakeCon:
            def execute(self, *args, **kwargs):
                return self

            def fetchall(self):
                return []

            def fetchone(self):
                return None

        with patch("planning.erp_route_cache.get", return_value=None):
            with patch(
                "planning.sales_orders_route._fetch_sales_orders",
                return_value=payload,
            ) as fetch:
                with patch("planning.first_article_service.planner_db") as planner_db:
                    planner_db.return_value.__enter__.return_value = FakeCon()
                    hits = search_flag_candidates("APS")
        fetch.assert_called_once_with(refresh=False, active_only=True, lite=True)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["process_sheet_no"], "APS-1001")

    def test_lookup_job_rebuilds_lite_when_cache_empty(self):
        payload = {
            "active": [
                {
                    "sales_order_no": "SO-9",
                    "customer_name": "Coway",
                    "pp_vouchers": [_pp(coway_proposed_edd="2026-08-20")],
                }
            ]
        }
        with patch("planning.erp_route_cache.get", return_value=None):
            with patch(
                "planning.sales_orders_route._fetch_sales_orders",
                return_value=payload,
            ) as fetch:
                job = lookup_sales_order_job("APS-1001")
        fetch.assert_called_once_with(refresh=False, active_only=True, lite=True)
        self.assertEqual(job["coway_proposed_edd"], "2026-08-20")


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

    def test_candidates_lists_active_jobs(self):
        payload = {
            "rows": [{
                "process_sheet_no": "NPS26-0374",
                "ps_type": "NPS",
                "already_flagged": False,
            }],
            "types": [{"ps_type": "NPS", "count": 1}],
            "total": 1,
            "matched": 1,
            "truncated": False,
        }
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.list_flag_candidates",
                return_value=payload,
            ) as list_fn:
                response = self.client.get("/api/first-article/candidates?ps_type=NPS")

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["matched"], 1)
        self.assertEqual(body["rows"][0]["process_sheet_no"], "NPS26-0374")
        list_fn.assert_called_once()
        self.assertEqual(list_fn.call_args.kwargs.get("ps_type_filter"), "NPS")

    def test_bulk_flag_requires_items(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post("/api/first-article/bulk", json={})

        self.assertEqual(response.status_code, 400)
        self.assertIn("items", response.get_json()["error"])

    def test_bulk_flag_posts_selected_sheets(self):
        result = {
            "created": [
                {"first_article_id": 1, "process_sheet_no": "NPS26-0374"},
                {"first_article_id": 2, "process_sheet_no": "NPS26-0375"},
            ],
            "already_flagged": [],
            "created_count": 2,
            "already_flagged_count": 0,
            "count": 2,
        }
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.flag_process_sheets",
                return_value=result,
            ) as flag_fn:
                response = self.client.post(
                    "/api/first-article/bulk",
                    json={
                        "items": [
                            {"process_sheet_no": "NPS26-0374"},
                            {"process_sheet_no": "NPS26-0375"},
                        ]
                    },
                )

        self.assertEqual(response.status_code, 201)
        body = response.get_json()
        self.assertEqual(body["created_count"], 2)
        flag_fn.assert_called_once()
        items = flag_fn.call_args.args[0]
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["process_sheet_no"], "NPS26-0374")
