"""New-part labelling and month-end snapshot selection."""
from __future__ import annotations

import unittest
from contextlib import contextmanager
from datetime import date, datetime
from unittest.mock import patch

from planning.otd_new_parts import (
    build_month_snapshot,
    flag_new_process_sheets,
    previous_closed_month,
    saved_late,
    snapshot_previous_month_if_due,
)


def _sheet(ps, part, so, ship, *, status="on_time"):
    return {
        "process_sheet_no": ps,
        "pp_voucher_no": ps,
        "pp_type": "APS",
        "sales_order_no": so,
        "inventory_code": part,
        "description": part,
        "customer_name": "Acme",
        "sales_person_name": "Ada",
        "delivery_date": ship,
        "po_due_date": ship,
        "status": status,
    }


class FlagTests(unittest.TestCase):
    def test_first_sheet_for_a_part_is_new(self):
        rows = flag_new_process_sheets(
            [_sheet("APS26-1", "P1", "SO/1", "2026-09-02")],
            history={"P1": [{"ps_base": "APS26-1", "pp_voucher_no": "APS26-1", "sales_order_no": "SO/1"}]},
        )
        self.assertTrue(rows[0]["is_new_part"])

    def test_repeat_on_another_sales_order_is_not_new(self):
        rows = flag_new_process_sheets(
            [_sheet("APS26-2", "P1", "SO/2", "2026-09-02")],
            history={
                "P1": [
                    {"ps_base": "APS26-1", "pp_voucher_no": "APS26-1", "sales_order_no": "SO/1"},
                    {"ps_base": "APS26-2", "pp_voucher_no": "APS26-2", "sales_order_no": "SO/2"},
                ]
            },
        )
        self.assertFalse(rows[0]["is_new_part"])

    def test_same_sales_order_only_is_new(self):
        rows = flag_new_process_sheets(
            [_sheet("APS26-2", "P1", "SO/1", "2026-09-02")],
            history={
                "P1": [
                    {"ps_base": "APS26-1", "pp_voucher_no": "APS26-1", "sales_order_no": "SO/1"},
                    {"ps_base": "APS26-2", "pp_voucher_no": "APS26-2", "sales_order_no": "SO/1"},
                ]
            },
        )
        self.assertTrue(rows[0]["is_new_part"])

    def test_blank_part_is_not_new(self):
        row = _sheet("APS26-1", "", "SO/1", "2026-09-02")
        flag_new_process_sheets([row], history={})
        self.assertFalse(row["is_new_part"])


class SnapshotSelectionTests(unittest.TestCase):
    def test_previous_month_rolls_the_year(self):
        self.assertEqual(previous_closed_month(date(2026, 1, 4)), (2025, 12))
        self.assertEqual(previous_closed_month(date(2026, 9, 24)), (2026, 8))

    def test_snapshot_counts_new_sheets_delivered_that_month(self):
        rows = [
            {**_sheet("APS26-1", "P1", "SO/1", "2026-08-10"), "is_new_part": True},
            {**_sheet("APS26-2", "P2", "SO/2", "2026-08-12"), "is_new_part": False},
            {**_sheet("APS26-3", "P3", "SO/3", "2026-09-01"), "is_new_part": True},
        ]
        snapshot = build_month_snapshot(rows, year=2026, month=8)
        self.assertEqual(snapshot["delivered_count"], 2)
        self.assertEqual(snapshot["new_part_count"], 1)
        self.assertEqual(snapshot["sheets"][0]["process_sheet_no"], "APS26-1")

    def test_saved_late_when_more_than_three_days_after_month_end(self):
        self.assertFalse(saved_late(2026, 8, datetime(2026, 9, 1, 8, 0)))
        self.assertTrue(saved_late(2026, 8, date(2026, 9, 24)))


class _RecCon:
    def __init__(self, *, exists=False):
        self.exists = exists
        self.last_sql = ""
        self.inserts = []
        self.values = []

    def execute(self, sql, params=None):
        self.last_sql = sql
        if "INSERT INTO public.planner_otd_new_part_month" in sql:
            self.inserts.append(params)
        return self

    def execute_values(self, sql, argslist, template=None, page_size=500):
        self.values = list(argslist)
        return self

    def fetchone(self):
        if self.exists and "SELECT" in self.last_sql:
            return {"year": 2026}
        return None

    def fetchall(self):
        return []


class SnapshotWriteTests(unittest.TestCase):
    def test_skips_a_month_that_is_already_saved(self):
        con = _RecCon(exists=True)

        @contextmanager
        def fake_db():
            yield con

        with patch("planning.otd_new_parts.planner_db", fake_db):
            result = snapshot_previous_month_if_due(today=date(2026, 9, 2), fetch_classified=lambda year: [])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["month"], 8)
        self.assertEqual(con.inserts, [])

    def test_writes_the_closed_month_once(self):
        con = _RecCon(exists=False)
        rows = [{**_sheet("APS26-1", "P1", "SO/1", "2026-08-04"), "is_new_part": True}]

        @contextmanager
        def fake_db():
            yield con

        with patch("planning.otd_new_parts.planner_db", fake_db):
            result = snapshot_previous_month_if_due(
                today=date(2026, 9, 2),
                fetch_classified=lambda year: rows,
            )
        self.assertFalse(result["skipped"])
        self.assertEqual(result["new_part_count"], 1)
        self.assertEqual(con.inserts, [(2026, 8, 1, 1)])
        self.assertEqual(con.values[0][2], "APS26-1")
