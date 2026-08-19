"""Tests for Material Tracking standalone part / inventory requests."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.material_tracking_requests_route import search_inventory


class MaterialTrackingRequestsRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_create_rejects_invalid_qty(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post(
                "/api/material-tracking/requests",
                json={"part_no": "8816-01", "qty": "not-a-number"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("qty must be a number", response.get_json()["error"])
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.post(
                "/api/material-tracking/requests",
                json={"description": "No codes"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("part_no or inventory_code", response.get_json()["error"])

    def test_empty_search_returns_no_rows(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/material-tracking/requests/search")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["rows"], [])

    def test_search_maps_inventory_hits(self):
        hits = [
            {"inventory_code": "RM-100", "description": "Bar stock"},
            {"inventory_code": "rm-100", "description": "dup"},
            {"inventory_code": "FG-200", "description": "Valve body"},
        ]
        with patch(
            "planning.material_tracking_requests_route.live_query",
            return_value=hits,
        ) as live_query:
            rows = search_inventory("100")

        live_query.assert_called_once()
        self.assertEqual(
            rows,
            [
                {"part_no": "RM-100", "inventory_code": "RM-100", "description": "Bar stock"},
                {"part_no": "FG-200", "inventory_code": "FG-200", "description": "Valve body"},
            ],
        )

    def test_create_list_patch_delete(self):
        created = {
            "request_id": 7,
            "part_no": "8816-01",
            "inventory_code": "RM-100",
            "description": "Bar stock",
            "qty": 2,
            "material_subcon": "",
            "remarks": "",
            "material_delay": False,
        }
        patched = {**created, "remarks": "Need by Friday", "material_subcon": "2026-08-21"}

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.material_tracking_requests_route.create_request",
                return_value=created,
            ) as create_request:
                create_res = self.client.post(
                    "/api/material-tracking/requests",
                    json={"part_no": "8816-01", "inventory_code": "RM-100", "qty": 2},
                )
            with patch(
                "planning.material_tracking_requests_route.list_requests",
                return_value=[created],
            ):
                list_res = self.client.get("/api/material-tracking/requests")
            with patch(
                "planning.material_tracking_requests_route.update_request",
                return_value=patched,
            ) as update_request:
                patch_res = self.client.patch(
                    "/api/material-tracking/requests/7",
                    json={"remarks": "Need by Friday", "material_subcon": "2026-08-21"},
                )
            with patch(
                "planning.material_tracking_requests_route.delete_request",
                return_value=True,
            ) as delete_request:
                delete_res = self.client.delete("/api/material-tracking/requests/7")

        self.assertEqual(create_res.status_code, 201)
        self.assertEqual(create_res.get_json()["row"]["request_id"], 7)
        create_request.assert_called_once()
        self.assertEqual(list_res.status_code, 200)
        self.assertEqual(list_res.get_json()["count"], 1)
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.get_json()["row"]["remarks"], "Need by Friday")
        update_request.assert_called_once()
        self.assertEqual(delete_res.status_code, 200)
        delete_request.assert_called_once_with(7)

    def test_patch_without_fields_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.patch("/api/material-tracking/requests/1", json={})

        self.assertEqual(response.status_code, 400)
        self.assertIn("No editable fields", response.get_json()["error"])

    def test_delete_missing_request(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.material_tracking_requests_route.delete_request",
                return_value=False,
            ):
                response = self.client.delete("/api/material-tracking/requests/99")

        self.assertEqual(response.status_code, 404)
