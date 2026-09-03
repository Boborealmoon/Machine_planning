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
