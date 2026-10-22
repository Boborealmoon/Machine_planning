"""Delivery commitment: split qty, over-allocation, and closed lines."""
from __future__ import annotations

import unittest
from pathlib import Path

from planning.delivery_commitment_service import (
    AllocationError,
    _sql_statements,
    _assign_source,
    apply_okay_flags,
    join_delivery_lines,
    month_totals,
    plan_whole_month_assign,
    prepare_adds,
    propose_set,
)


def _line(**overrides):
    row = {
        "row_id": "SO/1|NPS1|1|10",
        "sales_order_no": "SO/1",
        "process_sheet_no": "NPS1",
        "pp_voucher_no": "NPS1",
        "pp_partial_no": 1,
        "ps_type": "NPS",
        "part_no": "P-1",
        "part_desc": "Widget",
        "source_line_item_no": "10",
        "unit_selling_price": 20,
        "exch_rate": 1.5,
        "remaining_qty": 10,
        "status": "Machining",
        "due_date": "2026-12-01",
        "coway_edd": "2026-11-02",
        "week": "Week 45",
        "material_need_date": "2026-07-20",
        "material_in_date": "2026-08-01",
        "proposed_cnc": "CNC 20, CNC 22",
    }
    row.update(overrides)
    return row


def _slice(month, qty, commitment_id, **extra):
    row = {
        "commitment_id": commitment_id,
        "row_id": "SO/1|NPS1|1|10",
        "plan_month": month,
        "qty": qty,
        "sales_order_no": "SO/1",
        "process_sheet_no": "NPS1",
        "part_no": "P-1",
        "part_desc": "Widget",
        "ps_type": "NPS",
        "unit_cost": 20,
        "exch_rate": 1.5,
        "status": "Machining",
    }
    row.update(extra)
    return row


class DeliveryCommitmentTests(unittest.TestCase):
    def test_split_across_two_months_and_month_totals_use_slice_qty(self):
        outstanding = [_line()]
        by_id = {outstanding[0]["row_id"]: outstanding[0]}
        september = prepare_adds(
            by_id,
            [],
            "2026-09",
            [{"row_id": outstanding[0]["row_id"], "qty": 4}],
        )
        self.assertEqual(september[0][2], 4.0)

        stored = [_slice("2026-09", 4, 1)]
        november = prepare_adds(
            by_id,
            stored,
            "2026-11",
            [{"row_id": outstanding[0]["row_id"]}],
        )
        self.assertEqual(november[0][2], 6.0)

        joined = join_delivery_lines(
            outstanding,
            stored + [_slice("2026-11", 6, 2)],
        )
        row = joined[0]
        self.assertEqual(row["allocated_qty"], 10.0)
        self.assertEqual(row["left_qty"], 0.0)
        self.assertEqual(row["plan_month_label"], "Sep 2026 (4) · Nov 2026 (6)")
        self.assertFalse(row["over_allocated"])
        self.assertFalse(row["no_longer_open"])
        self.assertEqual(row["amount"], 300.0)
        self.assertEqual(row["material_need_date"], "2026-07-20")
        self.assertEqual(row["material_in_date"], "2026-08-01")
        self.assertEqual(row["proposed_cnc"], "CNC 20, CNC 22")

        september_totals = month_totals(joined, "2026-09")
        self.assertEqual(september_totals["line_count"], 1)
        self.assertEqual(september_totals["qty"], 4.0)
        self.assertEqual(september_totals["amount"], 120.0)

        november_totals = month_totals(joined, "2026-11")
        self.assertEqual(november_totals["qty"], 6.0)
        self.assertEqual(november_totals["amount"], 180.0)
        self.assertEqual(month_totals(joined, "unassigned")["line_count"], 0)

    def test_add_rejects_qty_above_open(self):
        outstanding = [_line()]
        by_id = {outstanding[0]["row_id"]: outstanding[0]}
        stored = [_slice("2026-09", 4, 1)]
        with self.assertRaises(AllocationError):
            prepare_adds(
                by_id,
                stored,
                "2026-11",
                [{"row_id": outstanding[0]["row_id"], "qty": 7}],
            )

    def test_over_allocated_when_open_qty_shrinks(self):
        joined = join_delivery_lines(
            [_line(remaining_qty=5)],
            [_slice("2026-09", 10, 1)],
        )
        row = joined[0]
        self.assertTrue(row["over_allocated"])
        self.assertFalse(row["no_longer_open"])
        self.assertEqual(row["left_qty"], 0.0)
        trimmed = propose_set(
            5,
            [{"plan_month": "2026-09", "qty": 10}],
            "2026-09",
            6,
            line=_line(remaining_qty=5),
        )
        self.assertEqual(trimmed, 6.0)
        with self.assertRaises(AllocationError):
            propose_set(
                5,
                [{"plan_month": "2026-09", "qty": 4}],
                "2026-09",
                6,
                line=_line(remaining_qty=5),
            )

    def test_closed_line_stays_when_missing_from_outstanding(self):
        joined = join_delivery_lines([], [_slice("2026-10", 3, 9)])
        self.assertEqual(len(joined), 1)
        row = joined[0]
        self.assertTrue(row["no_longer_open"])
        self.assertFalse(row["over_allocated"])
        self.assertEqual(row["open_qty"], 0.0)
        self.assertEqual(row["allocated_qty"], 3.0)
        self.assertEqual(row["part_no"], "P-1")
        self.assertEqual(row["amount"], 90.0)
        self.assertEqual(month_totals(joined, "2026-10")["qty"], 3.0)
        self.assertEqual(month_totals(joined, "unassigned")["line_count"], 0)

    def test_assign_puts_the_whole_open_qty_in_one_month(self):
        month, qty, drop = plan_whole_month_assign(
            _line(remaining_qty=10),
            [_slice("2026-09", 4, 1), _slice("2026-11", 6, 2)],
            "2026-10",
        )
        self.assertEqual(month.isoformat(), "2026-10-01")
        self.assertEqual(qty, 10.0)
        self.assertEqual(drop, [1, 2])

        same_month, same_qty, kept = plan_whole_month_assign(
            _line(remaining_qty=10),
            [_slice("2026-10", 4, 7)],
            "2026-10",
        )
        self.assertEqual(same_month.isoformat(), "2026-10-01")
        self.assertEqual(same_qty, 10.0)
        self.assertEqual(kept, [])

    def test_assign_uses_the_qty_already_on_screen(self):
        source = _assign_source(
            {"row_id": "SO/1|NPS1|1|10", "open_qty": 6, "part_no": "P-1"},
            {},
        )
        self.assertEqual(source["remaining_qty"], 6)
        month, qty, drop = plan_whole_month_assign(source, [], "2026-10")
        self.assertEqual(month.isoformat(), "2026-10-01")
        self.assertEqual(qty, 6.0)
        self.assertEqual(drop, [])

    def test_migration_sql_has_table_and_indexes(self):
        sql = Path("migrations/add_delivery_commitment.sql").read_text(encoding="utf-8")
        statements = _sql_statements(sql)
        text = "\n".join(statements).lower()
        self.assertIn("create table", text)
        self.assertIn("planner_delivery_commitment", text)
        self.assertIn("unique (row_id, plan_month)", text)
        self.assertGreaterEqual(len(statements), 3)

    def test_okay_flag_marks_only_saved_rows(self):
        lines = [_line(), _line(row_id="SO/2|NPS2|1|20")]
        apply_okay_flags(lines, {"SO/2|NPS2|1|20", "  "})
        self.assertFalse(lines[0]["okay"])
        self.assertTrue(lines[1]["okay"])

    def test_okay_migration_sql(self):
        sql = Path("migrations/add_delivery_line_okay.sql").read_text(encoding="utf-8")
        text = "\n".join(_sql_statements(sql)).lower()
        self.assertIn("planner_delivery_line_okay", text)
        self.assertIn("primary key", text)
