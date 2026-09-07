"""Deburring scan timestamps persisted as the QC wait clock."""
from __future__ import annotations

from unittest import TestCase

from planning.finishing_queue_service import is_deburr_qty_jump


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
