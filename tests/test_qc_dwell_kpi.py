"""QC dwell KPI: days from Pushed to QC until the job leaves Final Inspection."""
from __future__ import annotations

import os
import unittest
from datetime import datetime
from unittest.mock import patch

from planning.qc_dwell_kpi import (
    QC_STATE_BEFORE,
    QC_STATE_IN,
    QC_STATE_LEFT,
    QC_STATE_UNSTAMPED,
    build_qc_dwell_report,
    classify_qc_stay,
    include_qc_dwell_row,
    qc_dwell_sql,
    qc_elapsed,
)
from planning.utils import PLANNER_TZ


def _at(year, month, day, hour=8, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=PLANNER_TZ)


def _raw(**overrides):
    row = {
        "ps_id": "MP26-3195",
        "pp_partial_no": 1,
        "pushed_at": _at(2026, 10, 1),
        "qty_jump": 10,
        "part_no": "11T24E930-07",
        "part_desc": "Housing",
        "sales_order_no": "SO100",
        "customer_name": "Acme",
        "customer_code": "A1",
        "qty": 50,
        "due_date": "2026-10-20",
        "current_stage_desc": "Final Inspection",
        "current_stage_status": "R",
        "left_at": None,
        "left_stage_desc": "",
        "inspector_name": "QA team",
    }
    row.update(overrides)
    return row


class QcDwellMathTests(unittest.TestCase):
    def test_elapsed_label_matches_qaqc_day_hour_clock(self):
        elapsed = qc_elapsed(_at(2026, 10, 1, 8), _at(2026, 10, 4, 12))
        self.assertEqual(elapsed["elapsed_label"], "3d 4h")
        self.assertEqual(elapsed["days_at_qc"], 3.17)

    def test_same_moment_is_zero_minutes(self):
        stamp = _at(2026, 10, 1, 8, 15)
        elapsed = qc_elapsed(stamp, stamp)
        self.assertEqual(elapsed["days_at_qc"], 0)
        self.assertEqual(elapsed["elapsed_label"], "0m")

    def test_job_still_in_final_inspection_counts_through_now(self):
        stay = classify_qc_stay(
            current_stage_desc="Final Insp",
            pushed_at=_at(2026, 10, 1, 8),
            left_at=_at(2026, 10, 2, 8),
            now=_at(2026, 10, 6, 8),
        )
        self.assertEqual(stay["qc_state"], QC_STATE_IN)
        self.assertIsNone(stay["left_at"])
        self.assertEqual(stay["days_at_qc"], 5)

    def test_pack_scan_ends_the_stay_after_the_job_leaves_qc(self):
        stay = classify_qc_stay(
            current_stage_desc="Packing",
            pushed_at=_at(2026, 9, 25, 15, 46),
            left_at=_at(2026, 9, 28, 15, 46),
            now=_at(2026, 10, 6, 8),
        )
        self.assertEqual(stay["qc_state"], QC_STATE_LEFT)
        self.assertEqual(stay["days_at_qc"], 3)

    def test_left_without_a_pack_scan_has_no_day_count(self):
        stay = classify_qc_stay(
            current_stage_desc="Packing",
            pushed_at=_at(2026, 9, 1),
            left_at=None,
            now=_at(2026, 10, 6),
        )
        self.assertEqual(stay["qc_state"], QC_STATE_UNSTAMPED)
        self.assertIsNone(stay["days_at_qc"])

    def test_deburring_is_not_counted_as_time_at_qc(self):
        stay = classify_qc_stay(
            current_stage_desc="Deburring",
            pushed_at=_at(2026, 10, 1),
            left_at=None,
            now=_at(2026, 10, 6),
        )
        self.assertEqual(stay["qc_state"], QC_STATE_BEFORE)
        self.assertIsNone(stay["days_at_qc"])

    def test_open_jobs_stay_visible_outside_the_pushed_window(self):
        pushed = _at(2025, 12, 1)
        self.assertFalse(
            include_qc_dwell_row(
                pushed,
                QC_STATE_LEFT,
                from_date=_at(2026, 1, 1).date(),
                to_date=_at(2026, 10, 6).date(),
                include_open=True,
            )
        )
        self.assertTrue(
            include_qc_dwell_row(
                pushed,
                QC_STATE_IN,
                from_date=_at(2026, 1, 1).date(),
                to_date=_at(2026, 10, 6).date(),
                include_open=True,
            )
        )


class QcDwellReportTests(unittest.TestCase):
    def test_summary_averages_only_known_stays(self):
        now = _at(2026, 10, 6, 8)
        report = build_qc_dwell_report(
            [
                _raw(),
                _raw(
                    ps_id="MP26-1000",
                    current_stage_desc="Packing",
                    current_stage_status="R",
                    pushed_at=_at(2026, 10, 1, 8),
                    left_at=_at(2026, 10, 3, 8),
                    left_stage_desc="Packing",
                ),
                _raw(
                    ps_id="MP26-1001",
                    current_stage_desc="Packing",
                    pushed_at=_at(2026, 10, 2, 8),
                    left_at=_at(2026, 10, 6, 8),
                    left_stage_desc="Engraving & Packing",
                ),
                _raw(
                    ps_id="MP26-1002",
                    current_stage_desc="Engraving & Packing",
                    pushed_at=_at(2026, 9, 1, 8),
                    left_at=None,
                ),
            ],
            now=now,
            from_date=_at(2026, 1, 1).date(),
            to_date=_at(2026, 10, 6).date(),
        )
        summary = report["summary"]
        self.assertEqual(summary["job_count"], 4)
        self.assertEqual(summary["in_qc"], 1)
        self.assertEqual(summary["left_qc"], 2)
        self.assertEqual(summary["left_unstamped"], 1)
        self.assertEqual(summary["avg_days_in_qc"], 5)
        self.assertEqual(summary["avg_days_left"], 3)
        self.assertEqual(summary["median_days_left"], 3)
        self.assertEqual(summary["in_qc_3d"], 1)
        self.assertEqual(summary["in_qc_7d"], 0)
        open_row = next(row for row in report["rows"] if row["ps_id"] == "MP26-3195")
        self.assertEqual(open_row["qc_state_label"], "Still in QC")
        self.assertEqual(open_row["stage_status_label"], "Ready to Start")
        self.assertEqual(open_row["pushed_at"], "2026-10-01 08:00:00")
        self.assertEqual(open_row["left_at"], "")
        closed = next(row for row in report["rows"] if row["ps_id"] == "MP26-1000")
        self.assertEqual(closed["left_stage_desc"], "Packing")
        self.assertEqual(closed["days_at_qc"], 2)

    def test_filters_search_status_and_min_days(self):
        now = _at(2026, 10, 6, 8)
        rows = [
            _raw(customer_name="Acme", inspector_name="Lee"),
            _raw(
                ps_id="MP26-2000",
                customer_name="Other",
                current_stage_desc="Packing",
                pushed_at=_at(2026, 10, 4, 8),
                left_at=_at(2026, 10, 5, 8),
            ),
        ]
        by_name = build_qc_dwell_report(rows, now=now, query="acme")
        self.assertEqual([row["ps_id"] for row in by_name["rows"]], ["MP26-3195"])
        by_state = build_qc_dwell_report(rows, now=now, status="left_qc")
        self.assertEqual([row["ps_id"] for row in by_state["rows"]], ["MP26-2000"])
        by_days = build_qc_dwell_report(rows, now=now, min_days=3)
        self.assertEqual([row["ps_id"] for row in by_days["rows"]], ["MP26-3195"])

    def test_sql_reads_the_push_stamp_and_a_later_pack_scan(self):
        sql = qc_dwell_sql()
        self.assertIn("planner_deburr_qc_push", sql)
        self.assertIn("p.source = 'qty_jump'", sql)
        self.assertIn("planner_erp_qty_jump", sql)
        self.assertIn("Final Insp", sql)


class QcDwellRouteTests(unittest.TestCase):
    def setUp(self):
        from app import app

        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_page_is_linked_from_reports(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "REPORTS_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            page = self.client.get("/kpi")
            admin = self.client.get("/admin")
        self.assertEqual(page.status_code, 200)
        html = page.get_data(as_text=True)
        self.assertIn(">KPI<", html)
        self.assertIn("Arrived at QC", html)
        self.assertIn("QC TAT", html)
        self.assertIn("kpi-board", html)
        self.assertNotIn(">Customer<", html)
        self.assertIn('id="kpi-export"', html)
        self.assertIn('href="/kpi"', html)
        admin_html = admin.get_data(as_text=True)
        self.assertIn(">KPI<", admin_html)
        self.assertIn("/kpi", admin_html)

    def test_api_uses_push_rows(self):
        class _Db:
            def __enter__(self):
                return object()

            def __exit__(self, *args):
                return False

        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "REPORTS_PASSCODE": ""}):
            with patch("planning.qc_dwell_kpi_route.planner_db", return_value=_Db()), patch(
                "planning.qc_dwell_kpi_route.ensure_finishing_queue_tables"
            ), patch(
                "planning.qc_dwell_kpi_route.fetch_qc_dwell_rows",
                return_value=[_raw()],
            ) as fetch:
                response = self.client.get("/api/kpi/qc-dwell?status=in_qc&from=2026-01-01&to=2026-10-06")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["rows"][0]["ps_id"], "MP26-3195")
        self.assertEqual(payload["rows"][0]["qc_state"], "in_qc")
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.kwargs["from_date"].isoformat(), "2026-01-01")

    def test_kpi_page_is_behind_the_reports_gate(self):
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "REPORTS_PASSCODE": "secret"}):
            response = self.client.get("/kpi")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/reports-gate", response.headers["Location"])
        self.assertIn("next=/kpi", response.headers["Location"])
