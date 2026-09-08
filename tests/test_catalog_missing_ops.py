from unittest import TestCase

from planning.catalog import (
    _catalog_entry_needs_child_bom_ops,
    catalog_entry_missing_current_machining_op,
    catalog_ps_ids_needing_live_ops_repair,
)


class CatalogMissingOpsTests(TestCase):
    def test_nps_current_milling_missing_from_turning_only_card(self):
        entry = {
            "ps_id": "NPS26-0361",
            "source_ps_id": "NPS26-0361",
            "selected_bom_id": 258,
            "current_stage_desc": "Milling 40",
            "current_stage_no": 4,
            "ops": [
                {
                    "op_no": "20",
                    "source_op_no": "20",
                    "op_type": "Turning",
                    "operation_name": "Turning 20",
                    "machine_category": "GENERAL",
                }
            ],
        }
        self.assertTrue(catalog_entry_missing_current_machining_op(entry))
        self.assertFalse(_catalog_entry_needs_child_bom_ops(entry))

    def test_nps_not_missing_when_milling_op_present(self):
        entry = {
            "current_stage_desc": "Milling 40",
            "current_stage_no": 4,
            "ops": [
                {"op_no": "40", "op_type": "Milling", "operation_name": "Milling 40"},
            ],
        }
        self.assertFalse(catalog_entry_missing_current_machining_op(entry))

    def test_aps_without_bom_needs_inventory_seed(self):
        entry = {
            "ps_id": "APS26-0260",
            "source_ps_id": "APS26-0260",
            "inventory_code": "D64356EB",
            "selected_bom_id": 0,
            "ops": [],
            "op_cards": [],
        }
        self.assertTrue(_catalog_entry_needs_child_bom_ops(entry))
        self.assertFalse(catalog_entry_missing_current_machining_op(entry))

    def test_live_repair_ids_include_milling_gap_without_missing_bom(self):
        nps = {
            "ps_id": "NPS26-0361",
            "source_ps_id": "NPS26-0361",
            "selected_bom_id": 258,
            "current_stage_desc": "Milling 40",
            "ops": [{"op_no": "20", "op_type": "Turning"}],
        }
        aps = {
            "ps_id": "APS26-0260",
            "source_ps_id": "APS26-0260",
            "inventory_code": "D64356EB",
            "selected_bom_id": 0,
            "ops": [],
        }
        milling_only = catalog_ps_ids_needing_live_ops_repair(
            [nps, aps], include_missing_bom=False
        )
        self.assertEqual(milling_only, ["NPS26-0361"])
        both = catalog_ps_ids_needing_live_ops_repair([nps, aps], include_missing_bom=True)
        self.assertEqual(both, ["NPS26-0361", "APS26-0260"])


class CatalogQueuedMachineKeyTests(TestCase):
    def test_canonical_ps_id_uppercases_standard_sheets(self):
        from planning.catalog import _canonical_catalog_ps_id

        self.assertEqual(_canonical_catalog_ps_id("nps20-0358"), "NPS20-0358")
        self.assertEqual(_canonical_catalog_ps_id("nps20-0358::2"), "NPS20-0358::2")

    def test_lane_source_ids_include_unsuffixed_source(self):
        from planning.catalog import _catalog_lane_source_ps_ids

        ids = _catalog_lane_source_ps_ids(["NPS20-0358::2"])
        self.assertIn("NPS20-0358::2", ids)
        self.assertIn("NPS20-0358", ids)

    def test_queued_machines_lookup_uses_canonical_key(self):
        from planning.catalog import _queued_machines_for_catalog_op
        from planning.utils import trial_catalog_op_key

        keyed = {trial_catalog_op_key("NPS20-0358", "20", 1): ["CNC 21"]}
        self.assertEqual(
            _queued_machines_for_catalog_op(keyed, "nps20-0358", "20", 1),
            ["CNC 21"],
        )
