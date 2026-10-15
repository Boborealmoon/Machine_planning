"""CMM technician queue rules and routes."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.cmm_queue_service import (
    CMM_HISTORY_SQL,
    CMM_METRICS_SQL,
    CMM_QUEUE_SQL,
    PROGRAMME_QUEUE_SQL,
    CmmError,
    completion_block_reason,
    only_completed_jobs,
    only_open_jobs,
    order_open_cmm_jobs,
    parse_programme_count,
    plan_programme_change,
    sheets_missing_from_cmm,
    subtask_complete_error,
)


class CmmRuleTests(unittest.TestCase):
    def test_programme_plan_appends_and_drops_only_open_rows(self):
        existing = [
            {"subtask_id": 1, "programme_number": 1, "completed_at": "2026-10-13 09:00:00"},
            {"subtask_id": 2, "programme_number": 2, "completed_at": None},
            {"subtask_id": 3, "programme_number": 3, "completed_at": None},
        ]
        plan = plan_programme_change(existing, 2)
        self.assertEqual(plan["add_numbers"], [])
        self.assertEqual(plan["delete_ids"], [3])

        grown = plan_programme_change(existing, 4)
        self.assertEqual(grown["add_numbers"], [4])
        self.assertEqual(grown["delete_ids"], [])

    def test_programme_plan_refuses_to_remove_a_completed_row(self):
        existing = [
            {"subtask_id": 1, "programme_number": 1, "completed_at": "2026-10-13 09:00:00"},
            {"subtask_id": 2, "programme_number": 2, "completed_at": "2026-10-13 09:05:00"},
        ]
        with self.assertRaises(CmmError) as caught:
            plan_programme_change(existing, 1)
        self.assertEqual(caught.exception.status, 409)

    def test_programme_count_rejects_blanks_and_caps_at_50(self):
        self.assertEqual(parse_programme_count(3), 3)
        self.assertEqual(parse_programme_count("3"), 3)
        with self.assertRaises(CmmError):
            parse_programme_count("3.5")
        with self.assertRaises(CmmError):
            parse_programme_count(51)
        with self.assertRaises(CmmError):
            parse_programme_count(True)

    def test_completion_requires_programmes_unless_override(self):
        self.assertIn("at least one", completion_block_reason([], override=False))
        open_rows = [{"completed_at": "2026-10-13 09:00:00"}, {"completed_at": None}]
        self.assertIn("still open", completion_block_reason(open_rows, override=False))
        self.assertIsNone(completion_block_reason(open_rows, override=True))
        self.assertIsNone(completion_block_reason([{"completed_at": "2026-10-13 09:00:00"}], override=False))

    def test_subtask_tick_locks_after_completion(self):
        self.assertEqual(
            subtask_complete_error(job_status="IN_PROGRESS", completed_at=None, requested=False),
            "Completed programmes stay locked.",
        )
        self.assertEqual(
            subtask_complete_error(job_status="IN_PROGRESS", completed_at="2026-10-13 09:00:00", requested=True),
            "This programme is already complete.",
        )
        self.assertIsNone(
            subtask_complete_error(job_status="IN_PROGRESS", completed_at=None, requested=True)
        )
        self.assertIn(
            "already complete",
            subtask_complete_error(job_status="COMPLETED", completed_at=None, requested=True),
        )

    def test_history_query_is_completed_only_and_separate_from_new_parts(self):
        self.assertIn("j.status = 'COMPLETED'", CMM_HISTORY_SQL)
        self.assertNotIn("planner_first_article_new_part", CMM_HISTORY_SQL)
        self.assertNotIn("PENDING", CMM_HISTORY_SQL)
        self.assertIn("j.status IN ('PENDING', 'IN_PROGRESS')", CMM_QUEUE_SQL)
        self.assertNotIn("planner_first_article_new_part", CMM_QUEUE_SQL)
        self.assertIn("planner_first_article_new_part", PROGRAMME_QUEUE_SQL)
        self.assertIn("queue_order IS NOT NULL", PROGRAMME_QUEUE_SQL)
        self.assertIn("status = 'COMPLETED'", CMM_METRICS_SQL)
        self.assertEqual(
            only_completed_jobs([
                {"status": "COMPLETED"},
                {"status": "IN_PROGRESS"},
                {"status": "PENDING"},
            ]),
            [{"status": "COMPLETED"}],
        )
        self.assertEqual(
            [job["status"] for job in only_open_jobs([
                {"status": "COMPLETED"},
                {"status": "IN_PROGRESS"},
                {"status": "PENDING"},
            ])],
            ["IN_PROGRESS", "PENDING"],
        )

    def test_programme_queue_opens_missing_sheets_in_queue_order(self):
        sheets = [
            {"process_sheet_no": "NPS26-0344", "queue_order": 1},
            {"process_sheet_no": "nps26-9038", "queue_order": 2},
            {"process_sheet_no": "NPS26-8158", "queue_order": 3},
        ]
        open_jobs = [
            {"cmm_job_id": 9, "process_sheet_no": "NPS26-0344", "status": "IN_PROGRESS"},
            {"cmm_job_id": 4, "process_sheet_no": "NPS-EXTRA", "status": "PENDING"},
        ]
        missing = sheets_missing_from_cmm(sheets, open_jobs, {"NPS26-8158"})
        self.assertEqual([sheet["process_sheet_no"] for sheet in missing], ["nps26-9038"])
        ordered = order_open_cmm_jobs(sheets, open_jobs + [
            {"cmm_job_id": 10, "process_sheet_no": "NPS26-9038", "status": "PENDING"},
        ])
        self.assertEqual(
            [job["process_sheet_no"] for job in ordered],
            ["NPS26-0344", "NPS26-9038"],
        )
        self.assertEqual(ordered[0]["queue_order"], 1)
        self.assertEqual(ordered[1]["queue_order"], 2)
        self.assertEqual(order_open_cmm_jobs([], open_jobs), [])


class CmmRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_queue_page_is_its_own_view(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/cmm-queue")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("cmm-view", html)
        self.assertIn("CMM Queue", html)
        self.assertIn('href="/cmm-queue"', html)
        self.assertIn("id=\"fa-panel-cmm\"", html)
        self.assertNotIn("id=\"fa-cmm-add-btn\"", html)
        self.assertNotIn(">CMM</button>", html)
        self.assertIn("Nothing in the programme queue.", html)
        self.assertIn("id=\"fa-cmm-metrics\"", html)
        self.assertIn("id=\"fa-tab-cmm-history\"", html)

    def test_queue_page_skips_planner_passcode(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "secret-pass", "ADMIN_PASSCODE": "secret-pass"}):
            response = self.client.get("/cmm-queue")
        self.assertEqual(response.status_code, 200)
        self.assertIn("CMM Queue", response.get_data(as_text=True))
        self.assertNotIn("Access required", response.get_data(as_text=True))
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, "static", "css", "first_article.css"), encoding="utf-8") as handle:
            css = handle.read()
        with open(os.path.join(root, "static", "js", "first_article.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn("body.cmm-view .navbar", css)
        self.assertNotIn("data-fa-cmm-send", script)
        self.assertNotIn("cmmSendButton", script)

    def test_create_requires_process_sheet(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post("/api/first-article/cmm/jobs", json={})
        self.assertEqual(response.status_code, 400)
        self.assertIn("process_sheet_no", response.get_json()["error"])

    def test_untick_is_rejected_before_the_database(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.patch(
                "/api/first-article/cmm/jobs/4/subtasks/9",
                json={"completed": False},
            )
        self.assertEqual(response.status_code, 409)
        self.assertIn("locked", response.get_json()["error"])

    def test_programme_count_is_validated(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.put(
                "/api/first-article/cmm/jobs/4/programmes",
                json={"count": "many"},
            )
        self.assertEqual(response.status_code, 400)

    def test_history_route_returns_only_the_completed_payload(self):
        jobs = [{
            "cmm_job_id": 8,
            "status": "COMPLETED",
            "process_sheet_no": "NPS-1",
            "overall_completed_at": "2026-10-13 15:04:00",
            "subtasks": [{"programme_number": 1, "completed_at": "2026-10-13 15:00:00"}],
        }]
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch("planning.first_article_route.list_cmm_history", return_value=jobs) as listed:
                response = self.client.get("/api/first-article/cmm/history")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["jobs"][0]["status"], "COMPLETED")
        listed.assert_called_once_with()

    def test_complete_forwards_override(self):
        job = {"cmm_job_id": 4, "status": "COMPLETED"}
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch("planning.first_article_route.complete_cmm_job", return_value=job) as complete:
                response = self.client.post(
                    "/api/first-article/cmm/jobs/4/complete",
                    json={"override": True},
                )
        self.assertEqual(response.status_code, 200)
        complete.assert_called_once_with(4, override=True, actor="")
        self.assertEqual(response.get_json()["job"]["status"], "COMPLETED")
