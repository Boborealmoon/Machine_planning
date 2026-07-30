"""Tests for SO Line Archive shaping and notifications."""
from __future__ import annotations

import unittest

from planning.so_archive_service import (
    ARCHIVE_COLUMNS,
    bucket_counts,
    build_recent_notifications,
    filter_by_bucket,
    filter_by_buckets,
    group_rows_by_sales_order,
    ps_bucket,
    shape_archive_row,
    shape_archive_rows,
)


class SoArchiveServiceTests(unittest.TestCase):
    def test_ps_bucket_aps_nps_other(self):
        self.assertEqual(ps_bucket("APS12345"), "APS")
        self.assertEqual(ps_bucket("NPS999"), "NPS")
        self.assertEqual(ps_bucket("MPS001"), "OTHER")
        self.assertEqual(ps_bucket("PPS10"), "OTHER")
        self.assertEqual(ps_bucket(""), "OTHER")

    def test_shape_archive_row_column_order_fields(self):
        row = shape_archive_row(
            {
                "source_voucher_no": "SO/100",
                "source_voucher_line_item_no": "1",
                "process_sheet_no": "APS1",
                "inventory_code": "P-1",
                "part_desc": "Widget",
                "po_due_date": "2026-08-01",
                "qty": 5,
                "customer_po_no": "CPO-1",
                "status": "Open",
                "qty_issued": 0,
                "unit_selling_price": 12.5,
                "customer_code": "C01",
                "first_posted_datetime": "2026-07-28 09:00:00",
                "reference_no": "REF-1",
            }
        )
        self.assertEqual(row["main_desc"], "Widget")
        self.assertEqual(row["ps_bucket"], "APS")
        self.assertEqual(row["sales_order_date"], "2026-07-28")
        for col in ARCHIVE_COLUMNS:
            self.assertIn(col, row)

    def test_filter_and_group_and_notifications(self):
        shaped = shape_archive_rows(
            [
                {
                    "source_voucher_no": "SO/200",
                    "source_voucher_line_item_no": "1",
                    "process_sheet_no": "NPS1",
                    "inventory_code": "N-1",
                    "part_desc": "NPS part",
                    "status": "Open",
                    "first_posted_datetime": "2026-07-29 10:00:00",
                    "customer_code": "C2",
                },
                {
                    "source_voucher_no": "SO/100",
                    "source_voucher_line_item_no": "1",
                    "process_sheet_no": "APS1",
                    "inventory_code": "A-1",
                    "part_desc": "APS part",
                    "status": "Open",
                    "first_posted_datetime": "2026-07-30 08:00:00",
                    "customer_code": "C1",
                },
                {
                    "source_voucher_no": "SO/100",
                    "source_voucher_line_item_no": "2",
                    "process_sheet_no": "MPS1",
                    "inventory_code": "M-1",
                    "part_desc": "Other part",
                    "status": "History",
                    "first_posted_datetime": "2026-07-30 08:00:00",
                    "customer_code": "C1",
                },
            ]
        )
        counts = bucket_counts(shaped)
        self.assertEqual(counts["ALL"], 3)
        self.assertEqual(counts["APS"], 1)
        self.assertEqual(counts["NPS"], 1)
        self.assertEqual(counts["OTHER"], 1)

        aps_only = filter_by_bucket(shaped, "APS")
        self.assertEqual(len(aps_only), 1)
        self.assertEqual(aps_only[0]["source_voucher_no"], "SO/100")

        groups = group_rows_by_sales_order(shaped)
        self.assertEqual(groups[0]["source_voucher_no"], "SO/100")
        self.assertEqual(groups[0]["line_count"], 2)
        self.assertEqual(sorted(groups[0]["buckets"]), ["APS", "OTHER"])

        recent_aps = build_recent_notifications(shaped, buckets={"APS"}, limit=10)
        self.assertEqual(len(recent_aps), 1)
        self.assertEqual(recent_aps[0]["source_voucher_no"], "SO/100")
        self.assertEqual(recent_aps[0]["process_sheet_no"], "APS1")
        self.assertEqual(recent_aps[0]["inventory_code"], "A-1")

        recent_default = build_recent_notifications(
            shaped, buckets={"APS", "NPS"}, limit=10
        )
        self.assertEqual(
            [r["source_voucher_no"] for r in recent_default],
            ["SO/100", "SO/200"],
        )

    def test_mps_and_blank_ps_excluded_from_aps_nps(self):
        shaped = shape_archive_rows(
            [
                {
                    "source_voucher_no": "SO/1",
                    "process_sheet_no": "MPS100",
                    "inventory_code": "M-1",
                    "part_desc": "MPS part",
                    "first_posted_datetime": "2026-07-30 09:00:00",
                },
                {
                    "source_voucher_no": "SO/2",
                    "process_sheet_no": "APS100",
                    "inventory_code": "A-1",
                    "part_desc": "APS part",
                    "first_posted_datetime": "2026-07-30 10:00:00",
                },
                {
                    "source_voucher_no": "SO/3",
                    "process_sheet_no": "",
                    "inventory_code": "X-1",
                    "part_desc": "Blank PS",
                    "first_posted_datetime": "2026-07-30 11:00:00",
                },
                {
                    "source_voucher_no": "SO/4",
                    "pp_voucher_no": "NPS200",
                    "inventory_code": "N-1",
                    "part_desc": "NPS via pp_voucher_no",
                    "first_posted_datetime": "2026-07-30 12:00:00",
                },
            ]
        )
        filtered = filter_by_buckets(shaped, {"APS", "NPS"})
        so_nos = [row["source_voucher_no"] for row in filtered]
        self.assertEqual(so_nos, ["SO/2", "SO/4"])
        self.assertEqual(filtered[1]["process_sheet_no"], "NPS200")

        recent = build_recent_notifications(shaped, buckets={"APS", "NPS"}, limit=10)
        self.assertEqual([r["source_voucher_no"] for r in recent], ["SO/4", "SO/2"])
        self.assertTrue(all(r["process_sheet_no"] for r in recent))
        self.assertTrue(all(r["ps_bucket"] in {"APS", "NPS"} for r in recent))


if __name__ == "__main__":
    unittest.main()
