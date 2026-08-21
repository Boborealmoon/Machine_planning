"""Tests for the slim WO qty tracer (shop hours, SQL, change-only snapshots, skips)."""
from __future__ import annotations

from datetime import date, datetime, timezone
from unittest import TestCase
from unittest.mock import MagicMock, patch

from planning.erp_actuals import _filter_changed_snapshot_batch
from planning.erp_wo_qty_tracer import (
    erp_qty_tracer_enabled,
    erp_qty_tracer_thread_enabled,
    in_shop_hours,
    run_erp_wo_qty_tracer,
)
from sync import (
    PP_VOUCHER_PS_ID_PREFIXES,
    _build_mfg_wo_qty_tracer_sql,
    _build_mfg_wo_status_sql,
)


class ShopHoursTests(TestCase):
    def test_weekday_inside_window(self):
        # Friday 21 Aug 2026 00:00 UTC = 08:00 SGT
        when = datetime(2026, 8, 21, 0, 0, tzinfo=timezone.utc)
        self.assertTrue(in_shop_hours(when))
        # 12:30 UTC = 20:30 SGT (inclusive)
        self.assertTrue(in_shop_hours(datetime(2026, 8, 21, 12, 30, tzinfo=timezone.utc)))

    def test_weekday_outside_window(self):
        self.assertFalse(in_shop_hours(datetime(2026, 8, 20, 23, 59, tzinfo=timezone.utc)))
        self.assertFalse(in_shop_hours(datetime(2026, 8, 21, 12, 31, tzinfo=timezone.utc)))

    def test_weekend_skipped(self):
        # Saturday 22 Aug 2026 01:00 UTC = 09:00 SGT
        self.assertFalse(in_shop_hours(datetime(2026, 8, 22, 1, 0, tzinfo=timezone.utc)))
        # Sunday
        self.assertFalse(in_shop_hours(datetime(2026, 8, 23, 1, 0, tzinfo=timezone.utc)))

    def test_env_window_override(self):
        when = datetime(2026, 8, 21, 0, 0, tzinfo=timezone.utc)
        with patch.dict("os.environ", {"ERP_QTY_TRACER_START": "09:00", "ERP_QTY_TRACER_END": "18:00"}):
            self.assertFalse(in_shop_hours(when))


class TracerSqlTests(TestCase):
    def test_ir_only_sql_is_slim_and_has_no_union(self):
        sql, params = _build_mfg_wo_qty_tracer_sql([])
        lowered = sql.lower()
        self.assertIn("from mfg_mps_vch t2", lowered)
        self.assertIn("join mfg_wo_vch t3", lowered)
        self.assertIn("execution_status in ('i', 'r')", lowered)
        self.assertIn("distinct on (source_mps_no, pp_partial_no, stage_no, stage_desc)", lowered)
        self.assertIn("wo_qty_required desc", lowered)
        self.assertNotIn("union all", lowered)
        self.assertNotIn("mfg_pp_vch", lowered)
        self.assertNotIn("mfg_pp_partial", lowered)
        self.assertNotIn("truncate", lowered)
        self.assertEqual(params, PP_VOUCHER_PS_ID_PREFIXES)

    def test_watch_list_adds_union_any(self):
        sql, params = _build_mfg_wo_qty_tracer_sql(["NPS26-0150", "APS1"])
        lowered = sql.lower()
        self.assertIn("union all", lowered)
        self.assertIn("t2.source_pp_no = any(%s)", lowered)
        self.assertIn("execution_status in ('i', 'r')", lowered)
        self.assertEqual(params[-1], ["NPS26-0150", "APS1"])
        self.assertEqual(params[: len(PP_VOUCHER_PS_ID_PREFIXES)], PP_VOUCHER_PS_ID_PREFIXES)
        self.assertEqual(sql.count("%s"), len(params))

    def test_full_wo_status_sql_is_not_reused(self):
        full_sql, _ = _build_mfg_wo_status_sql(True)
        tracer_sql, _ = _build_mfg_wo_qty_tracer_sql(["NPS26-0150"])
        self.assertIn("mfg_pp_vch", full_sql.lower())
        self.assertNotIn("mfg_pp_vch", tracer_sql.lower())
        self.assertNotIn("plan_start_date", tracer_sql.lower())


class ChangedSnapshotTests(TestCase):
    def test_first_seen_and_increase_kept_flat_dropped(self):
        when = datetime(2026, 8, 21, 4, 0, tzinfo=timezone.utc)
        day = date(2026, 8, 21)
        batch = [
            ("NEW-PS", 1, 1, day, when, 10.0, 0.0),
            ("FLAT-PS", 1, 2, day, when, 40.0, 1.0),
            ("UP-PS", 1, 3, day, when, 120.0, 2.0),
        ]
        previous = {
            ("FLAT-PS", 1, 2): {"acc_qty_produced": 40.0, "acc_rej_qty_produced": 1.0},
            ("UP-PS", 1, 3): {"acc_qty_produced": 100.0, "acc_rej_qty_produced": 1.0},
        }
        kept = _filter_changed_snapshot_batch(batch, previous)
        keys = [(item[0], item[2], item[5]) for item in kept]
        self.assertEqual(keys, [("NEW-PS", 1, 10.0), ("UP-PS", 3, 120.0)])


class TracerGateTests(TestCase):
    def test_disabled_skips_without_comain(self):
        with patch.dict("os.environ", {"DISABLE_ERP_QTY_TRACER": "1"}):
            self.assertFalse(erp_qty_tracer_enabled())
            with patch("planning.erp_wo_qty_tracer.planner_db") as db:
                result = run_erp_wo_qty_tracer(force=False)
            db.assert_not_called()
            self.assertTrue(result["skipped"])
            self.assertEqual(result["reason"], "disabled")

    def test_thread_flag_default_off(self):
        with patch.dict("os.environ", {"ENABLE_ERP_QTY_TRACER": ""}, clear=False):
            self.assertFalse(erp_qty_tracer_thread_enabled())

    def test_outside_shop_hours_skips(self):
        weekend = datetime(2026, 8, 22, 1, 0, tzinfo=timezone.utc)
        with patch("planning.erp_wo_qty_tracer.planner_db") as db:
            result = run_erp_wo_qty_tracer(force=False, now=weekend)
        db.assert_not_called()
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "outside shop hours")

    def test_skips_when_erp_lock_held(self):
        shop = datetime(2026, 8, 21, 4, 0, tzinfo=timezone.utc)
        con = MagicMock()
        with patch("planning.erp_wo_qty_tracer.planner_db") as db, patch(
            "db.domain_sync_unreachable", return_value=False
        ), patch("sync.erp_sync_advisory_lock_is_held", return_value=True), patch(
            "sync.fetch_mfg_wo_qty_tracer_rows"
        ) as fetch:
            db.return_value.__enter__.return_value = con
            db.return_value.__exit__.return_value = False
            result = run_erp_wo_qty_tracer(force=True, now=shop)
        fetch.assert_not_called()
        self.assertTrue(result["skipped"])
        self.assertIn("ERP sync", result["reason"])

    def test_skips_when_own_lock_held(self):
        shop = datetime(2026, 8, 21, 4, 0, tzinfo=timezone.utc)
        con = MagicMock()
        lock_cur = MagicMock()
        lock_cur.fetchone.return_value = {"ok": False}
        con.execute.return_value = lock_cur
        with patch("planning.erp_wo_qty_tracer.planner_db") as db, patch(
            "db.domain_sync_unreachable", return_value=False
        ), patch("sync.erp_sync_advisory_lock_is_held", return_value=False), patch(
            "sync.fetch_mfg_wo_qty_tracer_rows"
        ) as fetch:
            db.return_value.__enter__.return_value = con
            db.return_value.__exit__.return_value = False
            result = run_erp_wo_qty_tracer(force=True, now=shop)
        fetch.assert_not_called()
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "tracer already running")

    def test_happy_path_posts_jumps_and_changed_snapshots(self):
        shop = datetime(2026, 8, 21, 4, 0, tzinfo=timezone.utc)
        con = MagicMock()
        lock_cur = MagicMock()
        lock_cur.fetchone.return_value = {"ok": True}
        con.execute.return_value = lock_cur
        current = [
            {
                "source_mps_no": "NPS26-0150",
                "pp_partial_no": 1,
                "stage_no": 3,
                "total_acc_qty_produced": 120,
            }
        ]
        with patch("planning.erp_wo_qty_tracer.planner_db") as db, patch(
            "db.domain_sync_unreachable", return_value=False
        ), patch("sync.erp_sync_advisory_lock_is_held", return_value=False), patch(
            "sync.fetch_mfg_wo_qty_tracer_rows", return_value=current
        ) as fetch, patch(
            "planning.erp_wo_qty_tracer._watch_source_mps_nos", return_value=["NPS26-0150"]
        ), patch(
            "planning.erp_actuals.record_erp_wo_qty_snapshots", return_value=1
        ) as snaps:
            def _record(con, rows, **kwargs):
                counts = kwargs.get("counts")
                if isinstance(counts, dict):
                    counts["jumps"] = 1
                    counts["snapshots"] = 1
                return 1

            snaps.side_effect = _record
            db.return_value.__enter__.return_value = con
            db.return_value.__exit__.return_value = False
            result = run_erp_wo_qty_tracer(force=True, now=shop)
        fetch.assert_called_once_with(["NPS26-0150"])
        snaps.assert_called_once()
        _args, kwargs = snaps.call_args
        self.assertTrue(kwargs.get("only_if_changed"))
        self.assertTrue(kwargs.get("capture_jumps"))
        self.assertFalse(result.get("skipped"))
        self.assertEqual(result["jumps"], 1)
        self.assertEqual(result["snapshots"], 1)
        self.assertEqual(result["comain_rows"], 1)
