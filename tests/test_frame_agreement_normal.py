"""Unit tests for Frame Agreement normal-lane helpers and FA key semantics."""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from planning.frame_agreement_service import (
    FA_NORMAL_DAY_MINUTES,
    compute_fg_per_day,
    is_frame_agreement_part,
    load_frame_agreement_part_keys,
    normalize_part_key,
    serialize_normal_part_row,
    serialize_part_row,
)


class FrameAgreementFgDayTests(unittest.TestCase):
    def test_fg_per_day_uses_available_minus_setup_over_cycle(self):
        # (630 - 30) / 60 = 10
        self.assertAlmostEqual(compute_fg_per_day(FA_NORMAL_DAY_MINUTES, 60, 30), 10.0)

    def test_fg_per_day_none_without_cycle(self):
        self.assertIsNone(compute_fg_per_day(FA_NORMAL_DAY_MINUTES, 0, 10))
        self.assertIsNone(compute_fg_per_day(FA_NORMAL_DAY_MINUTES, -1, 0))


class FrameAgreementKeyUnionTests(unittest.TestCase):
    def test_normalize_part_key_collapses_whitespace(self):
        self.assertEqual(normalize_part_key("  abc  01 "), "ABC 01")

    def test_is_frame_agreement_part_requires_key_in_set(self):
        keys = {normalize_part_key("PART-A")}
        self.assertTrue(is_frame_agreement_part("part-a", keys))
        self.assertFalse(is_frame_agreement_part("PART-B", keys))
        self.assertFalse(is_frame_agreement_part("PART-A", set()))

    def test_load_frame_agreement_part_keys_unions_mpp_and_normal(self):
        con = MagicMock()
        with patch(
            "planning.frame_agreement_service.load_frame_agreement_mpp_part_keys",
            return_value={"MPP-1", "BOTH"},
        ), patch(
            "planning.frame_agreement_service.load_frame_agreement_normal_part_keys",
            return_value={"NORMAL-1", "BOTH"},
        ):
            keys = load_frame_agreement_part_keys(con)
        self.assertEqual(keys, {"MPP-1", "NORMAL-1", "BOTH"})


class FrameAgreementDeburringCycleTests(unittest.TestCase):
    def test_serialize_part_row_includes_deburring_cycle(self):
        row = serialize_part_row(
            {
                "part_no": "FA-1",
                "notes": "",
                "mpp_machine_no": "CNC 35",
                "deburring_cycle_min_per_piece": 3.5,
            }
        )
        self.assertEqual(row["deburring_cycle_min_per_piece"], 3.5)

    def test_serialize_normal_part_row_includes_deburring_cycle(self):
        row = serialize_normal_part_row(
            {
                "part_no": "FA-N",
                "notes": "x",
                "deburring_cycle_min_per_piece": 1.0,
            }
        )
        self.assertEqual(row["deburring_cycle_min_per_piece"], 1.0)
        self.assertEqual(row["lane"], "normal")

    def test_serialize_defaults_missing_deburring_to_zero(self):
        mpp = serialize_part_row({"part_no": "Z", "notes": ""})
        normal = serialize_normal_part_row({"part_no": "Z", "notes": ""})
        self.assertEqual(mpp["deburring_cycle_min_per_piece"], 0.0)
        self.assertEqual(normal["deburring_cycle_min_per_piece"], 0.0)


if __name__ == "__main__":
    unittest.main()
