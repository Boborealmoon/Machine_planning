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
    list_new_part_rows,
    lookup_sales_order_job,
    search_flag_candidates,
    search_jobs,
    _job_from_pp_cache_row,
    _live_job_map,
    _merge_live_job,
    _parse_machine_codes,
    _serialize_tracker_row,
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
        self.assertEqual(job["posted_date"], "")
        self.assertFalse(job["is_new_part"])
        self.assertEqual(job["ps_type"], "APS")
        self.assertEqual(job["bom_code"], "")
        self.assertFalse(job["has_bom"])
        self.assertEqual(job["so_scope"], "active")
        self.assertEqual(job["erp_stage_mode"], "unassigned")

    def test_job_copies_posted_date_material_and_new_flag(self):
        pp = _pp(
            is_new_part=True,
            order_date="2026-08-12",
            material_subcon="ARRIVED",
            bom_code="BOM-1",
        )
        job = job_from_sales_order_pp(
            {
                "sales_order_no": "SO-9",
                "customer_name": "Coway",
                "first_posted_datetime": "2026-08-11 09:30:00",
            },
            pp,
        )
        self.assertTrue(job["is_new_part"])
        self.assertEqual(job["posted_date"], "2026-08-11")
        self.assertTrue(job["material_arrived"])
        self.assertEqual(job["material_display"], "Arrived")
        self.assertEqual(job["bom_code"], "BOM-1")
        self.assertFalse(job["has_bom"])

    def test_placeholder_bom_is_copied_without_implying_materials(self):
        job = job_from_sales_order_pp({"sales_order_no": "SO-9"}, _pp(bom_code="PLACEHOLDER"))
        self.assertEqual(job["bom_code"], "PLACEHOLDER")
        self.assertFalse(job["has_bom"])

    def test_job_prefers_header_coway_edd(self):
        pp = _pp(
            coway_proposed_edd="2026-07-15",
            partials=[{"coway_proposed_edd": "2026-08-01"}],
        )
        job = job_from_sales_order_pp({"sales_order_no": "SO-9"}, pp)
        self.assertEqual(job["coway_proposed_edd"], "2026-07-15")

    def test_job_copies_erp_stage_and_complete_scope(self):
        pp = _pp(
            current_stage_desc="Rough turning",
            current_stage_status="I",
            erp_stage_mode="open",
            shipped_completed=True,
        )
        job = job_from_sales_order_pp({"sales_order_no": "SO-9"}, pp, so_scope="complete")
        self.assertEqual(job["current_stage_desc"], "Rough turning")
        self.assertEqual(job["current_stage_status"], "I")
        self.assertEqual(job["erp_stage_mode"], "open")
        self.assertEqual(job["so_scope"], "complete")
        self.assertTrue(job["shipped_completed"])

    def test_parse_machine_codes_dedupes(self):
        self.assertEqual(_parse_machine_codes("CNC 10, cnc 10, CNC 20"), ["CNC 10", "CNC 20"])
        self.assertEqual(_parse_machine_codes(["CNC 38", "CNC 38", ""]), ["CNC 38"])

    def test_serialize_prefers_saved_machines_over_live_queue(self):
        row = {
            "first_article_id": 1,
            "process_sheet_no": "APS-1",
            "pp_voucher_no": "",
            "pic_ids": [],
            "machine_codes": ["CNC 38"],
            "tooling_mode": "tick",
            "tooling_tick": False,
            "tooling_text": "",
            "fixture_mode": "tick",
            "fixture_tick": False,
            "fixture_text": "",
            "gauges_mode": "tick",
            "gauges_tick": False,
            "gauges_text": "",
            "remarks": "",
        }
        live = {
            "queued_machines": ["CNC 01"],
            "machine_cnc": "CNC 01",
            "part_no": "8816-01",
            "so_scope": "active",
        }
        saved = _serialize_tracker_row(row, live=live, pics_by_id={})
        self.assertEqual(saved["machine_codes"], ["CNC 38"])
        self.assertEqual(saved["machine_cnc"], "CNC 38")
        unset = _serialize_tracker_row({**row, "machine_codes": None}, live=live, pics_by_id={})
        self.assertEqual(unset["machine_codes"], ["CNC 01"])
        self.assertEqual(unset["current_stage_desc"], "")

    def test_pp_cache_row_fills_part_fields(self):
        job = _job_from_pp_cache_row({
            "process_sheet_no": "NPS26-0324",
            "part_no": "BBD012702A",
            "part_description": "Housing",
            "total_qty": 20,
            "po_due_date": "2026-09-01",
            "status": "History",
        })
        self.assertEqual(job["process_sheet_no"], "NPS26-0324")
        self.assertEqual(job["part_no"], "BBD012702A")
        self.assertEqual(job["part_description"], "Housing")
        self.assertEqual(job["total_qty"], 20)
        self.assertEqual(job["so_scope"], "complete")
        self.assertTrue(job["from_erp_cache"])

    def test_merge_live_job_fills_blank_part_fields(self):
        primary = job_from_sales_order_pp({"sales_order_no": "SO-1"}, _pp(inventory_code="", description=""))
        extra = _job_from_pp_cache_row({
            "process_sheet_no": "APS-1001",
            "part_no": "8816-01",
            "part_description": "Valve body",
            "total_qty": 12,
        })
        merged = _merge_live_job(primary, extra)
        self.assertEqual(merged["part_no"], "8816-01")
        self.assertEqual(merged["part_description"], "Valve body")
        self.assertEqual(merged["sales_order_no"], "SO-1")

    def test_flatten_complete_jobs_keep_historical_scope(self):
        jobs = flatten_sales_order_jobs(
            [{"sales_order_no": "SO-H", "pp_vouchers": [_pp(process_sheet_no="AP526-0151", pp_voucher_no="PP-H")]}],
            so_scope="complete",
        )
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["so_scope"], "complete")
        self.assertTrue(jobs[0]["shipped_completed"])
        self.assertEqual(jobs[0]["erp_stage_mode"], "completed")

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

    def test_list_flag_candidates_can_filter_historical(self):
        jobs = flatten_sales_order_jobs(
            [{"sales_order_no": "SO-1", "pp_vouchers": [_pp()]}],
            so_scope="active",
        ) + flatten_sales_order_jobs(
            [{"sales_order_no": "SO-H", "pp_vouchers": [_pp(process_sheet_no="AP526-0151", pp_voucher_no="PP-H")]}],
            so_scope="complete",
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
                payload = list_flag_candidates(scope_filter="complete")

        self.assertEqual(payload["matched"], 1)
        self.assertEqual(payload["rows"][0]["process_sheet_no"], "AP526-0151")
        self.assertEqual(payload["scope"], "complete")

    def test_search_includes_complete_sales_orders(self):
        payload = {
            "active": [],
            "complete": [{
                "sales_order_no": "SO-H",
                "customer_name": "Coway",
                "pp_vouchers": [_pp(process_sheet_no="AP526-0151", pp_voucher_no="PP-H")],
            }],
        }

        class FakeCon:
            def execute(self, *args, **kwargs):
                return self

            def fetchall(self):
                return []

            def fetchone(self):
                return None

        with patch("planning.first_article_service._sales_order_payload", return_value=payload):
            with patch("planning.first_article_service.planner_db") as planner_db:
                planner_db.return_value.__enter__.return_value = FakeCon()
                with patch("planning.first_article_service._search_jobs_from_pp_cache", return_value=[]):
                    hits = search_flag_candidates("AP526")

        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["process_sheet_no"], "AP526-0151")
        self.assertEqual(hits[0]["so_scope"], "complete")

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

    def test_list_new_part_rows_filters_to_new_parts(self):
        payload = {
            "active": [
                {
                    "sales_order_no": "SO-1",
                    "first_posted_datetime": "2026-08-12",
                    "pp_vouchers": [
                        _pp(is_new_part=True, material_subcon="2026-09-01", bom_code="SMP-MAT-01"),
                        _pp(
                            process_sheet_no="NPS-22",
                            pp_voucher_no="PP-22",
                            inventory_code="AA-1",
                            is_new_part=False,
                        ),
                    ],
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

        with patch("planning.first_article_service._sales_order_payload", return_value=payload):
            with patch("planning.first_article_service.planner_db") as planner_db:
                with patch(
                    "planning.first_article_service._lookup_parts_with_bom_materials",
                    return_value={"8816-01"},
                ):
                    planner_db.return_value.__enter__.return_value = FakeCon()
                    rows = list_new_part_rows(allow_rebuild=False)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["process_sheet_no"], "APS-1001")
        self.assertTrue(rows[0]["is_new_part"])
        self.assertEqual(rows[0]["ps_type"], "APS")
        self.assertEqual(rows[0]["posted_date"], "2026-08-12")
        self.assertEqual(rows[0]["material_date"], "2026-09-01")
        self.assertFalse(rows[0]["bom_updated"])
        self.assertEqual(rows[0]["bom_code"], "SMP-MAT-01")
        self.assertTrue(rows[0]["has_bom"])
        self.assertEqual(rows[0]["program_pic_ids"], [])
        self.assertEqual(rows[0]["program_pics"], [])

    def test_list_new_part_rows_has_bom_follows_erp_materials_not_pp_route(self):
        payload = {
            "active": [
                {
                    "sales_order_no": "SO-1",
                    "pp_vouchers": [
                        _pp(is_new_part=True, bom_code=""),
                        _pp(
                            process_sheet_no="NPS-22",
                            pp_voucher_no="PP-22",
                            inventory_code="AA-1",
                            is_new_part=True,
                            bom_code="FLOW-1",
                        ),
                    ],
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

        with patch("planning.first_article_service._sales_order_payload", return_value=payload):
            with patch("planning.first_article_service.planner_db") as planner_db:
                with patch(
                    "planning.first_article_service._lookup_parts_with_bom_materials",
                    return_value={"8816-01"},
                ) as lookup:
                    planner_db.return_value.__enter__.return_value = FakeCon()
                    rows = list_new_part_rows(allow_rebuild=False)

        by_part = {row["part_no"]: row for row in rows}
        self.assertEqual(set(by_part), {"8816-01", "AA-1"})
        self.assertEqual(by_part["8816-01"]["bom_code"], "")
        self.assertTrue(by_part["8816-01"]["has_bom"])
        self.assertEqual(by_part["AA-1"]["bom_code"], "FLOW-1")
        self.assertFalse(by_part["AA-1"]["has_bom"])
        lookup.assert_called_once()


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

    def test_new_parts_list_returns_rows(self):
        rows = [{
            "process_sheet_no": "NPS26-0374",
            "part_no": "BBD012702A REV 02",
            "is_new_part": True,
            "posted_date": "2026-08-12",
            "bom_updated": False,
        }]
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.list_new_part_rows",
                return_value=rows,
            ) as list_fn:
                response = self.client.get("/api/first-article/new-parts")

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["rows"][0]["process_sheet_no"], "NPS26-0374")
        list_fn.assert_called_once()

    def test_new_parts_patch_requires_process_sheet(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.patch("/api/first-article/new-parts", json={"bom_updated": True})

        self.assertEqual(response.status_code, 400)
        self.assertIn("process_sheet_no", response.get_json()["error"])

    def test_new_parts_patch_saves_fields(self):
        saved = {
            "process_sheet_no": "NPS26-0374",
            "bom_updated": True,
            "remarks": "Waiting CAM",
            "program_finish_at": "2026-09-01T16:00",
        }
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.update_new_part_row",
                return_value=saved,
            ) as update_fn:
                response = self.client.patch(
                    "/api/first-article/new-parts",
                    json={
                        "process_sheet_no": "NPS26-0374",
                        "bom_updated": True,
                        "remarks": "Waiting CAM",
                        "program_finish_at": "2026-09-01T16:00",
                        "program_pic_ids": [4],
                    },
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["row"]["bom_updated"], True)
        update_fn.assert_called_once()
        payload = update_fn.call_args.args[0]
        self.assertEqual(payload["process_sheet_no"], "NPS26-0374")
        self.assertTrue(payload["bom_updated"])
        self.assertEqual(payload["program_finish_at"], "2026-09-01T16:00")
        self.assertEqual(payload["program_pic_ids"], [4])

    def test_patch_accepts_machine_codes(self):
        saved = {
            "first_article_id": 3,
            "process_sheet_no": "APS-1001",
            "machine_codes": ["CNC 10", "CNC 20"],
        }
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.first_article_route.update_tracker_row",
                return_value=saved,
            ) as update_fn:
                response = self.client.patch(
                    "/api/first-article/3",
                    json={"machine_codes": ["CNC 10", "CNC 20"]},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["row"]["machine_codes"], ["CNC 10", "CNC 20"])
        update_fn.assert_called_once()
        self.assertEqual(update_fn.call_args.args[1]["machine_codes"], ["CNC 10", "CNC 20"])

    def test_page_lives_under_ops(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/ops/first-article")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("NPI/FA Management", html)
        self.assertIn("NPI Tracker", html)
        self.assertIn("ERP stage", html)
        self.assertIn("id=\"fa-flag-one\"", html)
        self.assertIn("fa-bulk-scopes", html)
        self.assertNotIn("First Article Tracker", html)
        self.assertNotIn("Flagged jobs", html)

    def test_archive_url_redirects_to_ops(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/archive/first-article", follow_redirects=False)

        self.assertIn(response.status_code, (301, 302, 303, 307, 308))
        self.assertEqual(response.headers.get("Location"), "/ops/first-article")
