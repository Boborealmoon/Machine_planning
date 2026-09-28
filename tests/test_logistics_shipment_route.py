"""Supply Chain View inbound and outbound shipment tabs."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.logistics_shipment_route import (
    bucket_where,
    buckets_for,
    header_table,
    invalidate_logistics_shipment_cache,
    rows_sql,
)


class LogisticsShipmentRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        invalidate_logistics_shipment_cache()

    def tearDown(self):
        invalidate_logistics_shipment_cache()

    def test_buckets_match_erp_tabs(self):
        self.assertEqual(buckets_for("in"), ("outstanding", "grn", "history", "cancelled"))
        self.assertEqual(buckets_for("out"), ("outstanding", "history", "cancelled"))
        self.assertIn("shipment_stage = 'G'", bucket_where("in", "grn"))
        self.assertIn("<> 'G'", bucket_where("in", "outstanding"))
        self.assertIn("= 'X'", bucket_where("in", "cancelled"))
        self.assertIn("<> 'X'", bucket_where("out", "history"))
        self.assertEqual(header_table("in", "history"), "public.lg_in_shm_hst_hdr")
        self.assertEqual(header_table("out", "outstanding"), "public.lg_out_shm_ost_hdr")
        self.assertIn("LIMIT 500", rows_sql("in", "history"))
        self.assertNotIn("LIMIT", rows_sql("in", "outstanding"))
        self.assertIn("h.do_no", rows_sql("out", "outstanding"))
        self.assertIn("h.grn_no", rows_sql("in", "grn"))

    def test_invalid_bucket_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/material-tracking/shipments?direction=out&bucket=grn")
        self.assertEqual(response.status_code, 400)
        self.assertIn("invalid bucket", response.get_json()["error"])

    def test_outstanding_inbound_returns_rows(self):
        def fake_query(sql, params=(), timeout_ms=None):
            if "FILTER" in sql and "lg_in_shm_ost_hdr" in sql:
                return [{"open_n": 158, "closed_n": 41}]
            if "FILTER" in sql and "lg_in_shm_hst_hdr" in sql:
                return [{"open_n": 4100, "closed_n": 58}]
            return [{
                "shipment_voucher_no": "LG04021PSH",
                "source_voucher_no": "P26/1327",
                "party_name": "A.T.E. DESIGN ENGINEERING & TRADING",
                "priority": "Normal",
                "mode": "Road",
            }]

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch("planning.logistics_shipment_route.live_query", side_effect=fake_query):
                response = self.client.get(
                    "/api/material-tracking/shipments?direction=in&bucket=outstanding"
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["bucket"], "outstanding")
        self.assertEqual(payload["counts"]["outstanding"], 158)
        self.assertEqual(payload["counts"]["grn"], 41)
        self.assertEqual(payload["counts"]["history"], 4100)
        self.assertEqual(payload["rows"][0]["shipment_voucher_no"], "LG04021PSH")
        self.assertIn("lg_in_shm_ost_hdr", payload["source"])
        self.assertFalse(payload["truncated"])

    def test_logistics_page_groups_sections(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/sales-orders/logistics")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-sol-section="jobs"', html)
        self.assertIn('data-sol-section="purchasing"', html)
        self.assertIn('data-sol-section="logistics-in"', html)
        self.assertIn('data-sol-section="logistics-out"', html)
        self.assertIn('data-sol-view="logistics-in"', html)
        self.assertIn('data-sol-ship-bucket="grn"', html)
        self.assertIn('data-sol-ship-bucket="cancelled"', html)
        self.assertIn('data-sol-view="qc-checklist"', html)
        self.assertIn('data-sol-qc-bucket="ready_qc"', html)
        self.assertIn('data-sol-qc-bucket="awaiting_grn"', html)
        self.assertIn(">Logistics In<", html)
        self.assertIn(">Logistics Out<", html)


if __name__ == "__main__":
    unittest.main()
