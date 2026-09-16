"""Tests for Material Tracking PR enquiry / Purchase Order API mapping."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.material_tracking_pr_po_route import (
    invalidate_material_tracking_pr_po_cache,
    resolve_view,
)


class MaterialTrackingPrPoRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        invalidate_material_tracking_pr_po_cache()

    def tearDown(self):
        invalidate_material_tracking_pr_po_cache()

    def test_resolve_view_mapping(self):
        self.assertEqual(resolve_view("pr", "ost"), "pr_req_new + pr_req_hst (no PO)")
        self.assertEqual(resolve_view("pr", "hst"), "pr_req_hst (with PO)")
        self.assertEqual(resolve_view("po", "ost"), "po_order_ost (open)")
        self.assertEqual(resolve_view("po", "new"), "po_order_new")
        self.assertEqual(resolve_view("po", "hst"), "po_order_ost (completed/cancelled)")
        self.assertIsNone(resolve_view("pr", "new"))
        self.assertIsNone(resolve_view("po", "lg"))
        self.assertIsNone(resolve_view("xx", "ost"))

    def test_invalid_scope_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/material-tracking/pr-po?scope=bad&bucket=ost")

        self.assertEqual(response.status_code, 400)
        self.assertIn("unknown scope", response.get_json()["error"])

    def test_invalid_bucket_for_pr_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/material-tracking/pr-po?scope=pr&bucket=new")

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertIn("invalid bucket", payload["error"])
        self.assertIn("pr", payload["error"])

    def test_valid_request_returns_rows_and_counts(self):
        sample_rows = [
            {
                "no": 1,
                "purchase_requisition_no": "PR/1",
                "status": "PO Outstanding",
                "item_code": "X",
                "qty": 2,
            }
        ]
        sample_counts = {
            "pr": {"ost": 10, "hst": 20},
            "po": {"ost": 5, "new": 1, "hst": 3},
        }

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.material_tracking_pr_po_route._fetch_rows",
                return_value=sample_rows,
            ) as fetch_rows:
                with patch(
                    "planning.material_tracking_pr_po_route._fetch_counts",
                    return_value=sample_counts,
                ) as fetch_counts:
                    response = self.client.get(
                        "/api/material-tracking/pr-po?scope=po&bucket=ost"
                    )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["scope"], "po")
        self.assertEqual(payload["bucket"], "ost")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["rows"], sample_rows)
        self.assertEqual(payload["counts"], sample_counts)
        self.assertIn("po_order_ost (open)", payload["source"])
        fetch_rows.assert_called_once()
        fetch_counts.assert_called_once_with("po", "ost", 1, refresh=False)

    def test_counts_use_row_length_without_scanning_other_views(self):
        from planning.material_tracking_pr_po_route import _fetch_counts

        invalidate_material_tracking_pr_po_cache()
        with patch("planning.material_tracking_pr_po_route.live_query") as live:
            counts = _fetch_counts("pr", "ost", 105)

        live.assert_not_called()
        self.assertEqual(counts["pr"]["ost"], 105)
        self.assertEqual(counts["po"], {})

    def test_sql_selects_remarks_from_order_tables(self):
        from planning.material_tracking_pr_po_route import _sql_for

        po_ost = _sql_for("po", "ost")
        pr_ost = _sql_for("pr", "ost")
        self.assertIn("po_order_ost_hdr", po_ost)
        self.assertIn("h.remarks", po_ost)
        self.assertIn("pr_req_hst_hdr", pr_ost)
        self.assertIn("h.remarks", pr_ost)
        self.assertIn("pr_req_new_hdr", pr_ost)

    def test_logistics_page_includes_new_tabs(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/sales-orders/logistics")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-sol-view="pr-enquiry"', html)
        self.assertIn('data-sol-view="purchase-order"', html)
        self.assertIn('data-sol-bucket="ost"', html)
        self.assertIn('data-sol-bucket="hst"', html)
        self.assertIn('data-sol-bucket="new"', html)
        self.assertIn('id="sol-prpo-toolbar"', html)
        self.assertIn('sol-tab-box', html)
        self.assertIn('id="sol-sbu-dropdown"', html)
        self.assertIn('id="sol-supplier-dropdown"', html)
        self.assertIn('id="sol-item-search"', html)
        self.assertIn("Search item, description, remarks...", html)
        self.assertIn('id="sol-loading-label"', html)
        self.assertIn("Supply Chain View", html)
        self.assertIn("Need date", html)
        self.assertIn('data-sol-view="sr"', html)
        self.assertIn('id="sol-sr-count"', html)
        self.assertIn('id="sol-notif"', html)
        self.assertIn('id="sol-notif-btn"', html)
        self.assertIn('New S/O &amp; process sheets', html)


if __name__ == "__main__":
    unittest.main()
