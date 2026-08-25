from unittest import TestCase

from planning.erp_wo_merge import (
    finishing_final_inspection_sql_match,
    finishing_stage_bucket,
    finishing_stage_sql_match,
    is_final_inspection_stage_desc,
    is_finishing_stage_desc,
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
