"""Navbar SO notifications distinguish brand-new vs updated sales orders."""
from __future__ import annotations

import unittest
from datetime import date, datetime

from planning.new_orders_route import (
    _build_notif_orders,
    _so_event_kind,
    _so_in_posted_window,
)


WEEK_FROM = date(2026, 8, 24)
WEEK_TO = date(2026, 8, 29)


class NewOrdersNotificationTests(unittest.TestCase):
    def test_so_event_kind_new_when_first_equals_latest(self):
        self.assertEqual(
            _so_event_kind(
                "2026-08-25 09:00:00",
                "2026-08-25 09:00:00",
                week_from=WEEK_FROM,
            ),
            "new",
        )

    def test_so_event_kind_updated_when_reposted_later(self):
        self.assertEqual(
            _so_event_kind(
                "2026-08-25 09:00:00",
                "2026-08-25 11:30:00",
                week_from=WEEK_FROM,
            ),
            "updated",
        )

    def test_so_event_kind_updated_when_first_posted_before_this_week(self):
        self.assertEqual(
            _so_event_kind(
                "2026-08-10 09:00:00",
                "2026-08-25 10:00:00",
                week_from=WEEK_FROM,
            ),
            "updated",
        )

    def test_so_event_kind_updated_when_so_was_created_before_this_week(self):
        self.assertEqual(
            _so_event_kind(
                "2026-08-25 09:56:50",
                "2026-08-25 09:56:50",
                week_from=WEEK_FROM,
                created_at="2026-03-06 14:58:31",
            ),
            "updated",
        )

    def test_so_event_kind_new_when_created_and_posted_this_week(self):
        self.assertEqual(
            _so_event_kind(
                "2026-08-25 11:07:44",
                "2026-08-25 11:07:44",
                week_from=WEEK_FROM,
                created_at="2026-08-25 11:04:24",
            ),
            "new",
        )

    def test_so_event_kind_ignores_string_format_noise(self):
        self.assertEqual(
            _so_event_kind(
                "2026-08-25 09:00:00",
                "2026-08-25T09:00:00",
                week_from=WEEK_FROM,
            ),
            "new",
        )

    def test_so_in_posted_window_new_orders_page_keeps_first_post_only(self):
        self.assertTrue(
            _so_in_posted_window(
                date(2026, 8, 25),
                date(2026, 8, 25),
                WEEK_FROM,
                WEEK_TO,
                include_reposts=False,
            )
        )
        self.assertFalse(
            _so_in_posted_window(
                date(2026, 8, 10),
                date(2026, 8, 25),
                WEEK_FROM,
                WEEK_TO,
                include_reposts=False,
            )
        )

    def test_so_in_posted_window_notifications_include_this_week_reposts(self):
        self.assertTrue(
            _so_in_posted_window(
                date(2026, 8, 10),
                date(2026, 8, 25),
                WEEK_FROM,
                WEEK_TO,
                include_reposts=True,
            )
        )

    def test_build_notif_orders_tags_new_and_updated(self):
        orders = _build_notif_orders(
            [
                {
                    "source_voucher_no": "SO/2600001",
                    "customer_code": "CA30",
                    "first_posted_datetime": datetime(2026, 8, 25, 9, 0, 0),
                    "latest_posted_datetime": datetime(2026, 8, 25, 9, 0, 0),
                    "process_sheet_no": "NPS26-0001",
                    "inventory_code": "P-1",
                    "part_desc": "Handle",
                },
                {
                    "source_voucher_no": "SO/2600002",
                    "customer_code": "CE12",
                    "first_posted_datetime": datetime(2026, 8, 10, 9, 0, 0),
                    "latest_posted_datetime": datetime(2026, 8, 25, 11, 0, 0),
                    "process_sheet_no": "NPS26-0002",
                    "inventory_code": "P-2",
                    "part_desc": "Bracket",
                },
                {
                    "source_voucher_no": "SO/2600737",
                    "customer_code": "CA30",
                    "created_datetime": datetime(2026, 3, 6, 14, 58, 31),
                    "first_posted_datetime": datetime(2026, 8, 25, 9, 56, 50),
                    "latest_posted_datetime": datetime(2026, 8, 25, 9, 56, 50),
                    "process_sheet_no": "NPS26-0079",
                    "inventory_code": "BB18-KS1240-02",
                    "part_desc": "HANDLE",
                },
            ],
            week_from=WEEK_FROM,
        )
        by_so = {row["so"]: row for row in orders}
        self.assertEqual(by_so["SO/2600001"]["kind"], "new")
        self.assertEqual(by_so["SO/2600001"]["postedAt"], "2026-08-25 09:00:00")
        self.assertEqual(by_so["SO/2600002"]["kind"], "updated")
        self.assertEqual(by_so["SO/2600002"]["postedAt"], "2026-08-25 11:00:00")
        self.assertEqual(by_so["SO/2600737"]["kind"], "updated")
        self.assertEqual(orders[0]["so"], "SO/2600002")


if __name__ == "__main__":
    unittest.main()
