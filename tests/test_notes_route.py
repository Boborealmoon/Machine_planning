"""Tests for standalone planner notes validation and access control."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.notes_route import _canonical_tag_id


class NotesRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_admin_page_uses_standalone_shell(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
            response = self.client.get("/admin")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('class="standalone-page notes-body"', html)
        self.assertNotIn('class="navbar"', html)
        self.assertIn("Screen directory", html)

    def test_legacy_notes_path_redirects_to_admin(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
            response = self.client.get("/notes")

        self.assertEqual(response.status_code, 308)
        self.assertTrue(response.headers["Location"].endswith("/admin"))

    def test_empty_note_is_rejected_before_database_access(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": ""}):
            response = self.client.post("/api/notes", json={"body": "  "})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "Note text is required.")

    def test_notes_api_requires_planner_session_when_gate_enabled(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "locked"}):
            response = self.client.get("/api/notes")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Planner access locked.")

    def test_process_sheet_tag_is_canonicalized(self):
        self.assertEqual(
            _canonical_tag_id({"ps_id": "nps26-0294", "pp_partial_no": 3}),
            "NPS26-0294::3",
        )
        self.assertEqual(_canonical_tag_id("aps25-0314"), "APS25-0314")


if __name__ == "__main__":
    unittest.main()
