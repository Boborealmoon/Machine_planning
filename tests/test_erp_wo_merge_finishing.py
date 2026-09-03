from unittest import TestCase

from planning.erp_wo_merge import (
    finishing_final_inspection_sql_match,
    finishing_stage_bucket,
    finishing_stage_sql_match,
    is_final_inspection_stage_desc,
    is_finishing_stage_desc,
    is_machining_stage_desc,
    merge_machining_steps_into_flow_steps,
    op_no_from_stage,
)


class FinishingStageMatchTests(TestCase):
    def test_final_insp_abbreviation_is_final_inspection(self):
        self.assertTrue(is_final_inspection_stage_desc("Final Insp"))
        self.assertTrue(is_finishing_stage_desc("Final Insp"))
        self.assertEqual(finishing_stage_bucket("Final Insp"), "final_inspection")

    def test_final_inspection_canonical_and_variants(self):
        for desc in (
            "Final Inspection",
            "Final Inspection/COC",
            "Final Inspection & Engraving",
            "Final Ispection",
        ):
            with self.subTest(desc=desc):
                self.assertTrue(is_finishing_stage_desc(desc))
                self.assertEqual(finishing_stage_bucket(desc), "final_inspection")

    def test_other_inspection_stages_are_not_finishing(self):
        for desc in (
            "Inspection",
            "In-Process Inspection",
            "Receiving Inspection",
            "QC Inspection",
        ):
            with self.subTest(desc=desc):
                self.assertFalse(is_final_inspection_stage_desc(desc))
                self.assertFalse(is_finishing_stage_desc(desc))
                self.assertEqual(finishing_stage_bucket(desc), "other")

    def test_finishing_sql_matches_final_insp_abbreviation(self):
        sql = finishing_stage_sql_match("stage_desc")
        helper = finishing_final_inspection_sql_match("stage_desc")
        self.assertIn("Final Insp%%", sql)
        self.assertIn("Final Ispection%%", sql)
        self.assertIn("Final Insp%%", helper)


class MachiningWoMergeTests(TestCase):
    def test_milling_and_turning_are_machining(self):
        self.assertTrue(is_machining_stage_desc("Milling 40"))
        self.assertTrue(is_machining_stage_desc("Turning 20"))
        self.assertTrue(is_machining_stage_desc("Turnmill"))
        self.assertFalse(is_machining_stage_desc("Facing 30"))
        self.assertFalse(is_machining_stage_desc("Subcon 40"))
        self.assertFalse(is_machining_stage_desc("Deburring"))

    def test_op_no_from_stage_prefers_label_number(self):
        self.assertEqual(op_no_from_stage("Milling 40", 4), "40")
        self.assertEqual(op_no_from_stage("Turning 20", 2), "20")
        self.assertEqual(op_no_from_stage("Deburring", 5), "5")

    def test_merge_adds_wo_milling_missing_from_planner_bom(self):
        steps = [
            {
                "op_seq_id": 629,
                "seq_no": 1,
                "op_no": "20",
                "op_type": "Turning",
                "source_stage_no": 2,
            }
        ]
        wo_stages = [
            {"stage_no": 1, "stage_desc": "Issue/ Verification"},
            {"stage_no": 2, "stage_desc": "Turning 20"},
            {"stage_no": 3, "stage_desc": "Turning 30"},
            {"stage_no": 4, "stage_desc": "Milling 40"},
            {"stage_no": 5, "stage_desc": "Deburring"},
        ]
        merged = merge_machining_steps_into_flow_steps(steps, wo_stages)
        op_nos = [step["op_no"] for step in merged]
        self.assertEqual(op_nos, ["20", "30", "40"])
        self.assertEqual(merged[0]["op_seq_id"], 629)
        milling = next(step for step in merged if step["op_no"] == "40")
        self.assertEqual(milling["op_type"], "Milling")
        self.assertEqual(milling["source_stage_no"], 4)
        self.assertEqual(milling["machine_category"], "MILLING")
        self.assertTrue(merged[-1]["is_last_op"])
        self.assertFalse(merged[0]["is_last_op"])

    def test_overlay_wo_qty_fills_stages_missing_from_cache(self):
        from planning.erp_wo_merge import overlay_wo_stages_on_erp_qty_maps

        by_op = {"20": 15.0}
        by_stage = {2: 15.0}
        status_by_op = {"20": "C"}
        status_by_stage = {2: "C"}
        overlay_wo_stages_on_erp_qty_maps(
            by_op,
            by_stage,
            status_by_op,
            status_by_stage,
            [
                {"stage_no": 2, "stage_desc": "Turning 20", "execution_status": "C", "total_acc_qty_produced": 15},
                {"stage_no": 3, "stage_desc": "Turning 30", "execution_status": "C", "total_acc_qty_produced": 15},
                {"stage_no": 4, "stage_desc": "Milling 40", "execution_status": "R", "total_acc_qty_produced": 0},
            ],
        )
        self.assertEqual(by_op["30"], 15.0)
        self.assertEqual(status_by_op["30"], "C")
        self.assertEqual(by_op["40"], 0.0)
        self.assertEqual(status_by_op["40"], "R")
        self.assertEqual(by_stage[4], 0.0)

