"""Unit tests for ERP accepted-qty jump detection and machine grouping."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from unittest import TestCase
from unittest.mock import MagicMock

from planning.erp_scanned_output_service import (
    UNASSIGNED_MACHINE,
    _SNAPSHOT_LOOKBACK_DAYS,
    _fetch_snapshot_jump_rows,
    compute_qty_jumps,
    group_jumps_by_machine,
    jumps_from_snapshot_series,
    machine_sort_key,
    wo_stage_key,
)


class ErpScannedOutputServiceTests(TestCase):
    def test_wo_stage_key_normalizes_partial(self):
        self.assertEqual(wo_stage_key("NPS26-0150", None, "3"), ("NPS26-0150", 1, 3))

    def test_compute_qty_jumps_captures_increase_and_date(self):
        scanned_at = datetime(2026, 8, 12, 2, 15, tzinfo=timezone.utc)
        jumps = compute_qty_jumps(
            [
                {
                    "source_mps_no": "NPS26-0150",
                    "pp_partial_no": 1,
                    "stage_no": 3,
                    "stage_desc": "Turning",
                    "total_acc_qty_produced": 120,
                    "total_rej_qty_produced": 2,
                }
            ],
            {
                ("NPS26-0150", 1, 3): {
                    "acc_qty_produced": 100,
                    "acc_rej_qty_produced": 1,
                }
            },
            scanned_at=scanned_at,
            scanned_date=date(2026, 8, 12),
        )
        self.assertEqual(len(jumps), 1)
        jump = jumps[0]
        self.assertEqual(jump["qty_jump"], 20)
        self.assertEqual(jump["prev_acc_qty"], 100)
        self.assertEqual(jump["new_acc_qty"], 120)
        self.assertEqual(jump["scanned_date"], date(2026, 8, 12))
        self.assertEqual(jump["stage_desc"], "Turning")

    def test_compute_qty_jumps_skips_first_observation_and_flat_qty(self):
        scanned_at = datetime(2026, 8, 12, tzinfo=timezone.utc)
        first = compute_qty_jumps(
            [{"source_mps_no": "APS1", "pp_partial_no": 1, "stage_no": 1, "total_acc_qty_produced": 40}],
            {},
            scanned_at=scanned_at,
            scanned_date=date(2026, 8, 12),
        )
        self.assertEqual(first, [])
        flat = compute_qty_jumps(
            [{"source_mps_no": "APS1", "pp_partial_no": 1, "stage_no": 1, "total_acc_qty_produced": 40}],
            {("APS1", 1, 1): {"acc_qty_produced": 40, "acc_rej_qty_produced": 0}},
            scanned_at=scanned_at,
            scanned_date=date(2026, 8, 12),
        )
        self.assertEqual(flat, [])

    def test_jumps_from_snapshot_series_uses_daily_deltas(self):
        jumps = jumps_from_snapshot_series(
            [
                {
                    "source_mps_no": "APS1",
                    "pp_partial_no": 1,
                    "stage_no": 2,
                    "snapshot_date": "2026-08-10",
                    "snapshot_at": "2026-08-10 18:00:00",
                    "acc_qty_produced": 10,
                    "acc_rej_qty_produced": 0,
                },
                {
                    "source_mps_no": "APS1",
                    "pp_partial_no": 1,
                    "stage_no": 2,
                    "snapshot_date": "2026-08-11",
                    "snapshot_at": "2026-08-11 18:00:00",
                    "acc_qty_produced": 10,
                    "acc_rej_qty_produced": 0,
                },
                {
                    "source_mps_no": "APS1",
                    "pp_partial_no": 1,
                    "stage_no": 2,
                    "snapshot_date": "2026-08-12",
                    "snapshot_at": "2026-08-12 09:00:00",
                    "acc_qty_produced": 25,
                    "acc_rej_qty_produced": 1,
                },
            ]
        )
        self.assertEqual(len(jumps), 1)
        self.assertEqual(jumps[0]["qty_jump"], 15)
        self.assertEqual(jumps[0]["scanned_date"], "2026-08-12")
        self.assertEqual(jumps[0]["prev_acc_qty"], 10)
        self.assertEqual(jumps[0]["new_acc_qty"], 25)

    def test_group_jumps_by_machine_sorts_cnc_and_unassigned_last(self):
        machines = group_jumps_by_machine(
            [
                {"machine_no": "CNC 30", "qty_jump": 5, "rej_jump": 0, "scanned_at": "2026-08-12 10:00:00", "source_mps_no": "B", "stage_no": 1},
                {"machine_no": "", "qty_jump": 2, "rej_jump": 0, "scanned_at": "2026-08-12 11:00:00", "source_mps_no": "C", "stage_no": 1},
                {"machine_no": "CNC 10", "qty_jump": 8, "rej_jump": 1, "scanned_at": "2026-08-12 09:00:00", "source_mps_no": "A", "stage_no": 2},
                {"machine_no": "CNC 10", "qty_jump": 4, "rej_jump": 0, "scanned_at": "2026-08-12 12:00:00", "source_mps_no": "A", "stage_no": 2},
            ]
        )
        self.assertEqual([item["machine_no"] for item in machines], ["CNC 10", "CNC 30", UNASSIGNED_MACHINE])
        cnc10 = machines[0]
        self.assertEqual(cnc10["jump_count"], 2)
        self.assertEqual(cnc10["qty_jump"], 12)
        self.assertEqual(cnc10["jumps"][0]["scanned_at"], "2026-08-12 12:00:00")

    def test_machine_sort_key_orders_cnc_numbers(self):
        names = ["CNC 30", "CNC 10", UNASSIGNED_MACHINE, "CNC 2"]
        ordered = sorted(names, key=machine_sort_key)
        self.assertEqual(ordered, ["CNC 2", "CNC 10", "CNC 30", UNASSIGNED_MACHINE])

    def test_snapshot_jump_query_scopes_to_date_window(self):
        cur = MagicMock()
        cur.fetchall.return_value = []
        con = MagicMock()
        con.execute.return_value = cur
        start = date(2026, 8, 4)
        end = date(2026, 8, 17)
        rows = _fetch_snapshot_jump_rows(con, start, end, limit=2000)
        self.assertEqual(rows, [])
        sql, params = con.execute.call_args.args
        self.assertIn("WITH scoped AS", sql)
        self.assertIn("FROM planner_erp_wo_qty_snapshot", sql)
        self.assertIn("WHERE snapshot_date >= %s", sql)
        self.assertLess(sql.index("WHERE snapshot_date >= %s"), sql.index("LAG(acc_qty_produced)"))
        self.assertEqual(
            params,
            (start - timedelta(days=_SNAPSHOT_LOOKBACK_DAYS), end, start, end, 2000),
        )
