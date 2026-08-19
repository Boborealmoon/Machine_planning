"""API routes must return JSON errors, never HTML pages."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app


class ApiJsonErrorHandlerTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_unknown_api_path_returns_json_404(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/this-route-does-not-exist")

        self.assertEqual(response.status_code, 404)
        self.assertTrue(response.is_json)
        payload = response.get_json()
        self.assertEqual(payload.get("ok"), False)
        self.assertIn("/api/this-route-does-not-exist", payload.get("error") or "")
        cache = response.headers.get("Cache-Control") or ""
        self.assertIn("no-store", cache)

    def test_unknown_page_still_returns_html(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/this-page-does-not-exist")

        self.assertEqual(response.status_code, 404)
        self.assertIn("text/html", response.content_type)
        self.assertFalse(response.is_json)

    def test_uncaught_api_exception_returns_json_500(self):
        def _boom():
            raise RuntimeError("synthetic api failure")

        endpoint = "test_api_json_error_boom"
        if endpoint not in self.app.view_functions:
            self.app.add_url_rule("/api/_test/json-error-boom", endpoint, _boom)

        previous = self.app.config.get("PROPAGATE_EXCEPTIONS")
        self.app.config["PROPAGATE_EXCEPTIONS"] = False
        try:
            with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
                response = self.client.get("/api/_test/json-error-boom")
        finally:
            self.app.config["PROPAGATE_EXCEPTIONS"] = previous

        self.assertEqual(response.status_code, 500)
        self.assertTrue(response.is_json)
        payload = response.get_json()
        self.assertEqual(payload.get("ok"), False)
        self.assertIn("synthetic api failure", payload.get("error") or "")
