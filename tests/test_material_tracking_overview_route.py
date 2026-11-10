"""Tests for the Supply Chain View overview chain."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.material_tracking_overview_route import (
    chain_status,
    invalidate_material_tracking_overview_cache,
    overview_sql,
    parse_sbus,
)


class MaterialTrackingOverviewRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        invalidate_material_tracking_overview_cache()

    def tearDown(self):
        invalidate_material_tracking_overview_cache()

    def test_parse_sbus(self):
        self.assertEqual(parse_sbus(None), (False, ["MFG"]))
        self.assertEqual(parse_sbus(""), (False, ["MFG"]))
        self.assertEqual(parse_sbus("*"), (True, []))
        self.assertEqual(parse_sbus("mfg, eng"), (False, ["MFG", "ENG"]))
        with self.assertRaises(ValueError):
            parse_sbus("MFG ENG")

    def test_chain_status_follows_the_latest_document(self):
        self.assertEqual(chain_status({}), "PR")
        self.assertEqual(chain_status({"purchase_order_no": "PO/1"}), "PO")
        self.assertEqual(
            chain_status({"purchase_order_no": "PO/1", "grn_no": "GRN/1"}),
            "GRN",
        )
        self.assertEqual(
            chain_status({
                "purchase_order_no": "PO/1",
                "grn_no": "GRN/1",
                "qi_voucher_no": "QI1",
            }),
            "QI",
        )

    def test_sql_links_pr_to_po_and_po_to_inbound(self):
        sql = overview_sql()
        self.assertIn("pr_req_new_hdr", sql)
        self.assertIn("pr_req_hst_hdr", sql)
        self.assertIn("po_order_ost_hdr", sql)
        self.assertIn("po_order_new_hdr", sql)
        self.assertIn("h.status IN ('O', 'U', 'C')", sql)
        self.assertIn("po.purchase_requisition_no = pr.purchase_requisition_no", sql)
        self.assertIn("public.lg_in_shm_ost_hdr", sql)
        self.assertIn("public.lg_in_shm_hst_hdr", sql)
        self.assertIn("h.source_voucher_no", sql)
        self.assertIn("ib.purchase_order_no = po.purchase_order_no", sql)
        self.assertIn("<> 'X'", sql)

    def test_invalid_sbu_rejected(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/api/material-tracking/overview?sbu=bad%20code")

        self.assertEqual(response.status_code, 400)
        self.assertIn("invalid sbu", response.get_json()["error"])

    def test_valid_request_returns_rows_and_status(self):
        sample_rows = [
            {
                "purchase_requisition_no": "PR/1",
                "line_item_no": "1",
                "item_code": "ITEM",
                "purchase_order_no": "PO/1",
                "grn_no": "",
                "qi_voucher_no": "",
            }
        ]
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch(
                "planning.material_tracking_overview_route._fetch_rows",
                return_value=[{**sample_rows[0], "status": "PO"}],
            ) as fetch_rows:
                with patch(
                    "planning.material_tracking_overview_route._fetch_sbus",
                    return_value=["ENG", "MFG"],
                ):
                    response = self.client.get("/api/material-tracking/overview?sbu=MFG")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["sbu"], ["MFG"])
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["rows"][0]["status"], "PO")
        self.assertEqual(payload["counts"]["PO"], 1)
        self.assertEqual(payload["sbus"], ["ENG", "MFG"])
        self.assertIn("pr_req_new", payload["source"])
        fetch_rows.assert_called_once_with(False, ["MFG"], refresh=False)

    def test_logistics_page_puts_overview_after_subcon(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.client.get("/sales-orders/logistics")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        subcon = html.find('data-sol-section="subcon"')
        overview = html.find('data-sol-section="overview"')
        purchasing = html.find('data-sol-section="purchasing"')
        self.assertGreaterEqual(subcon, 0)
        self.assertLess(subcon, overview)
        self.assertLess(overview, purchasing)
        self.assertIn("Each PR line, with its PO, GRN, and QI once they exist", html)


if __name__ == "__main__":
    unittest.main()
