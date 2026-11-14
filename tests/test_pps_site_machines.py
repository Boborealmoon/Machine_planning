"""PPS site planner lane helpers."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import app
from planning.machines import (
    PPS_SITE_ONLY_MACHINE_CODES,
    PPS_SITE_PLANNER_MACHINE_CODES,
    is_pps_site_only_machine,
)


class PpsSiteMachinesTests(unittest.TestCase):
    def test_codes_include_cnc20_cnc29_and_wire_cut(self):
        codes = {value.upper() for value in PPS_SITE_PLANNER_MACHINE_CODES}
        self.assertIn("CNC 20", codes)
        self.assertIn("CNC 29", codes)
        self.assertIn("WIRE CUT", codes)

    def test_wire_cut_is_site_only(self):
        self.assertTrue(is_pps_site_only_machine({"machine_no": "Wire cut"}))
        self.assertFalse(is_pps_site_only_machine({"machine_no": "CNC 20"}))
        self.assertFalse(is_pps_site_only_machine({"machine_no": "CNC 29"}))
        only = {value.upper() for value in PPS_SITE_ONLY_MACHINE_CODES}
        self.assertEqual(only, {"WIRE CUT"})

    def test_supply_chain_tab_defaults_to_segment_pps(self):
        self.app = app
        self.app.config["TESTING"] = True
        with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            response = self.app.test_client().get("/PPS")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("section=overview&amp;embed=1&amp;segment=PPS", html)
        self.assertIn("section=overview&amp;segment=PPS", html)


if __name__ == "__main__":
    unittest.main()
