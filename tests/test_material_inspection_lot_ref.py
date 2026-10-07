"""Material inspection lot reference is joined from inventory, not the QI header."""
from __future__ import annotations

import unittest

from planning.material_inspection_route import _material_inspection_sql


class MaterialInspectionLotRefTests(unittest.TestCase):
    def test_live_sql_resolves_lot_reference_from_inventory(self):
        _staged, live = _material_inspection_sql("with_shipment")
        self.assertIn("lot.lot_reference_no", live)
        self.assertIn("public.ic_inventory_ost_lot", live)
        self.assertIn("public.qc_quality_inspection_lot", live)
        self.assertIn("public.lg_in_shm_hst_det_lot", live)
        self.assertIn("h.inspection_voucher_no ~ '^QI[0-9]+$'", live)

    def test_no_shipment_variant_still_joins_lot_reference(self):
        _staged, live = _material_inspection_sql("no_shipment")
        self.assertIn("lot.lot_reference_no", live)
        self.assertIn("h.source_voucher_no IS NULL", live)
