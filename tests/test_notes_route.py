"""Tests for standalone planner notes validation and access control."""
from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

from app import app
from planning.notes_route import _canonical_tag_id


class NotesRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_admin_page_uses_standalone_shell(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/admin")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('class="standalone-page notes-body"', html)
        self.assertNotIn('class="navbar"', html)
        self.assertIn("Screen directory", html)
        self.assertIn('id="note-cancel"', html)

    def test_legacy_notes_path_redirects_to_admin(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/notes")

        self.assertEqual(response.status_code, 308)
        self.assertTrue(response.headers["Location"].endswith("/admin"))

    def test_empty_note_is_rejected_before_database_access(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post("/api/notes", json={"body": "  "})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "Note text is required.")

    def test_update_rejects_empty_body_before_database_access(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.put("/api/notes/12", json={"body": "   "})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "Note text is required.")

    def test_notes_api_requires_planner_session_when_gate_enabled(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "locked", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/notes")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Planner access locked.")

    def test_update_and_delete_require_planner_session_when_gate_enabled(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "locked", "ADMIN_PASSCODE": ""}):
            update = self.client.put("/api/notes/1", json={"body": "Keep going"})
            delete = self.client.delete("/api/notes/1")

        self.assertEqual(update.status_code, 401)
        self.assertEqual(delete.status_code, 401)

    def test_admin_page_redirects_to_admin_gate_when_enabled(self):
        with patch.dict(os.environ, {"ADMIN_PASSCODE": "admin-secret", "PLANNER_PASSCODE": ""}):
            response = self.client.get("/admin")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin-gate", response.headers["Location"])

    def test_notes_api_requires_admin_token_when_admin_gate_enabled(self):
        with patch.dict(os.environ, {"ADMIN_PASSCODE": "admin-secret", "PLANNER_PASSCODE": ""}):
            response = self.client.get("/api/notes")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Admin access locked.")

    def test_admin_gate_unlocks_with_passcode(self):
        with patch.dict(os.environ, {"ADMIN_PASSCODE": "admin-secret", "PLANNER_PASSCODE": ""}):
            response = self.client.post(
                "/admin-gate",
                data={"passcode": "admin-secret", "next": "/admin"},
                follow_redirects=False,
            )

        self.assertEqual(response.status_code, 302)
        location = response.headers["Location"]
        self.assertTrue(location.startswith("/admin?at="))

    def test_delete_missing_note_returns_404(self):
        fake_cur = MagicMock()
        fake_cur.fetchone.return_value = None
        fake_con = MagicMock()
        fake_con.execute.return_value = fake_cur
        fake_con.__enter__ = MagicMock(return_value=fake_con)
        fake_con.__exit__ = MagicMock(return_value=False)

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}), patch(
            "planning.notes_route.planner_db", return_value=fake_con
        ), patch("planning.notes_route._ensure_notes_tables"):
            response = self.client.delete("/api/notes/999")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "Note not found.")

    def test_process_sheet_tag_is_canonicalized(self):
        self.assertEqual(
            _canonical_tag_id({"ps_id": "nps26-0294", "pp_partial_no": 3}),
            "NPS26-0294::3",
        )
        self.assertEqual(_canonical_tag_id("aps25-0314"), "APS25-0314")


if __name__ == "__main__":
    unittest.main()
