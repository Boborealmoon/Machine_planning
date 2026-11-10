"""PPS site planner lane helpers."""
from __future__ import annotations

import unittest

from planning.machines import (
    PPS_SITE_ONLY_MACHINE_CODES,
    PPS_SITE_PLANNER_MACHINE_CODES,
    is_pps_site_only_machine,
)


class PpsSiteMachinesTests(unittest.TestCase):
    def test_codes_include_cnc20_and_wire_cut(self):
        codes = {value.upper() for value in PPS_SITE_PLANNER_MACHINE_CODES}
        self.assertIn("CNC 20", codes)
        self.assertIn("WIRE CUT", codes)

    def test_wire_cut_is_site_only(self):
        self.assertTrue(is_pps_site_only_machine({"machine_no": "Wire cut"}))
        self.assertFalse(is_pps_site_only_machine({"machine_no": "CNC 20"}))
        only = {value.upper() for value in PPS_SITE_ONLY_MACHINE_CODES}
        self.assertEqual(only, {"WIRE CUT"})


if __name__ == "__main__":
    unittest.main()
