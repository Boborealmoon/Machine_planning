"""Tests for Material Tracking inbound QC checklist."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.material_tracking_inspection_route import (
    classify_bucket,
    invalidate_material_tracking_inspection_cache,
    split_buckets,
)


class MaterialTrackingInspectionRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        invalidate_material_tracking_inspection_cache()

    def tearDown(self):
        invalidate_material_tracking_inspection_cache()

    def test_classify_bucket_uses_grn(self):
        self.assertEqual(classify_bucket({"grn_no": "LG03852GRN"}), "ready_qc")
        self.assertEqual(classify_bucket({"grn_no": "  "}), "awaiting_grn")
        self.assertEqual(classify_bucket({"grn_no": None, "qty_received": 4}), "awaiting_grn")

    def test_split_buckets(self):
        rows = [
            {"grn_no": "LG1", "shipment_voucher_no": "LG1PSH"},
            {"grn_no": None, "qty_received": 2, "shipment_voucher_no": "LG2PSH"},
            {"grn_no": "", "qty_received": 1, "shipment_voucher_no": "LG3PSH"},
        ]
        buckets = split_buckets(rows)
        self.assertEqual(len(buckets["ready_qc"]), 1)
        self.assertEqual(len(buckets["awaiting_grn"]), 2)

    def test_invalid_bucket_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/material-tracking/qc-checklist?bucket=ost")

        self.assertEqual(response.status_code, 400)
        self.assertIn("invalid bucket", response.get_json()["error"])

    def test_ready_qc_returns_grn_rows(self):
        sample = [
            {
                "shipment_voucher_no": "LG04007PSH",
                "po_no": "P26/1076",
                "grn_no": "LG03852GRN",
                "item_code": "TAPE",
                "qty_received": 12,
            },
            {
                "shipment_voucher_no": "LG03760PSH",
                "po_no": "P26/0860",
                "grn_no": None,
                "qty_received": 8,
            },
        ]
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.material_tracking_inspection_route.live_query",
                return_value=sample,
            ) as live_query:
                response = self.client.get(
                    "/api/material-tracking/qc-checklist?bucket=ready_qc"
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["bucket"], "ready_qc")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["counts"]["ready_qc"], 1)
        self.assertEqual(payload["counts"]["awaiting_grn"], 1)
        self.assertEqual(payload["rows"][0]["grn_no"], "LG03852GRN")
        self.assertIn("lg_in_shm_ost", payload["source"])
        live_query.assert_called_once()

    def test_logistics_page_includes_qc_tab(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/sales-orders/logistics")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-sol-view="qc-checklist"', html)
        self.assertIn('data-sol-qc-bucket="ready_qc"', html)
        self.assertIn('data-sol-qc-bucket="awaiting_grn"', html)


if __name__ == "__main__":
    unittest.main()
