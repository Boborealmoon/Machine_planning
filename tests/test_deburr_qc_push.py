"""Deburring scan timestamps persisted as the QC wait clock."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from planning.finishing_queue_service import (
    _serialize_deburr_push,
    decide_deburr_push_action,
    is_deburr_qty_jump,
)


class TestIsDeburrQtyJump(TestCase):
    def test_deburring_stage(self):
        assert is_deburr_qty_jump({"stage_desc": "Deburring"}) is True
        assert is_deburr_qty_jump({"stage_desc": "deburring"}) is True

    def test_other_finishing_stages_are_ignored(self):
        assert is_deburr_qty_jump({"stage_desc": "Final Inspection"}) is False
        assert is_deburr_qty_jump({"stage_desc": "Packing"}) is False
        assert is_deburr_qty_jump({"stage_desc": "Turning"}) is False
        assert is_deburr_qty_jump({}) is False
        assert is_deburr_qty_jump(None) is False


class TestSerializeDeburrPush(TestCase):
    def test_qty_jump_keeps_timestamp(self):
        row = _serialize_deburr_push(
            {
                "pushed_at": datetime(2026, 9, 3, 6, 10, tzinfo=timezone.utc),
                "source": "qty_jump",
            }
        )
        assert row["deburr_pushed_at"]
        assert row["deburr_push_source"] == "qty_jump"

    def test_guessed_first_seen_is_blank(self):
        row = _serialize_deburr_push(
            {
                "pushed_at": datetime(2026, 9, 7, 2, 31, tzinfo=timezone.utc),
                "source": "first_seen",
            }
        )
        assert row["deburr_pushed_at"] == ""
        assert row["deburr_push_source"] == "first_seen"

    def test_baseline_source_is_blank(self):
        row = _serialize_deburr_push(
            {
                "pushed_at": datetime(2026, 9, 21, 6, 0, tzinfo=timezone.utc),
                "source": "baseline",
            }
        )
        assert row["deburr_pushed_at"] == ""
        assert row["deburr_push_source"] == "baseline"

    def test_missing_row_is_blank(self):
        row = _serialize_deburr_push(None)
        assert row["deburr_pushed_at"] == ""


class TestDecideDeburrPushAction(TestCase):
    def test_increase_vs_latest_baseline_is_jump(self):
        assert (
            decide_deburr_push_action(
                50.0,
                latest_qty=0.0,
                latest_known=True,
            )
            == "jump"
        )

    def test_first_observation_without_baseline_stays_blank(self):
        assert decide_deburr_push_action(4.0) == "baseline"
        assert decide_deburr_push_action(0.0) == "baseline"

    def test_ready_deburr_with_zero_qty_is_not_a_jump(self):
        assert (
            decide_deburr_push_action(
                0.0,
                stored_acc=0.0,
                stored_source="baseline",
            )
            == "none"
        )

    def test_scan_after_zero_baseline_is_jump(self):
        assert (
            decide_deburr_push_action(
                30.0,
                stored_acc=0.0,
                stored_source="baseline",
            )
            == "jump"
        )

    def test_existing_scan_date_is_kept_when_qty_unchanged(self):
        assert (
            decide_deburr_push_action(
                20.0,
                stored_acc=20.0,
                stored_source="qty_jump",
            )
            == "none"
        )

    def test_existing_scan_fills_missing_acc_qty(self):
        assert (
            decide_deburr_push_action(
                20.0,
                stored_acc=None,
                stored_source="qty_jump",
            )
            == "seed_acc"
        )

    def test_further_scan_updates_existing_push(self):
        assert (
            decide_deburr_push_action(
                51.0,
                stored_acc=50.0,
                stored_source="qty_jump",
            )
            == "jump"
        )
