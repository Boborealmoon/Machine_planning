"""Deburring scan timestamps persisted as the QC wait clock."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from planning.finishing_queue_service import _serialize_deburr_push, is_deburr_qty_jump


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

    def test_missing_row_is_blank(self):
        row = _serialize_deburr_push(None)
        assert row["deburr_pushed_at"] == ""
