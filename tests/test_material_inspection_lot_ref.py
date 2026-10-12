"""Material inspection lot reference is joined from inventory, not the QI header."""
from __future__ import annotations

import unittest

from planning.material_inspection_route import (
    _material_inspection_sql,
    process_sheet_nos_from_remarks,
)


class MaterialInspectionLotRefTests(unittest.TestCase):
    def test_live_sql_resolves_lot_reference_from_inventory(self):
        _staged, live = _material_inspection_sql("with_shipment")
        self.assertIn("lot.lot_reference_no", live)
        self.assertIn("public.ic_inventory_ost_lot", live)
        self.assertIn("public.qc_quality_inspection_lot", live)
        self.assertIn("public.lg_in_shm_hst_det_lot", live)
        self.assertIn("h.inspection_voucher_no ~ '^QI[0-9]+$'", live)

    def test_process_sheet_numbers_are_pulled_from_po_line_notes(self):
        self.assertEqual(process_sheet_nos_from_remarks("[NPS26-0464]"), "NPS26-0464")
        self.assertEqual(
            process_sheet_nos_from_remarks("HEAT 297776\n[NPS26-0463,0469]"),
            "NPS26-0463, NPS26-0469",
        )
        self.assertEqual(
            process_sheet_nos_from_remarks("[NPS26-0321-8]"),
            "NPS26-0321-8",
        )
        self.assertEqual(
            process_sheet_nos_from_remarks("Ø480mm x 76.2mm\nNPS26-0429 fixture"),
            "NPS26-0429",
        )
        self.assertEqual(process_sheet_nos_from_remarks("[EC11,EC21,EC27]"), "")
        self.assertEqual(process_sheet_nos_from_remarks(""), "")

    def test_no_shipment_variant_still_joins_lot_reference(self):
        _staged, live = _material_inspection_sql("no_shipment")
        self.assertIn("lot.lot_reference_no", live)
        self.assertIn("h.source_voucher_no IS NULL", live)
