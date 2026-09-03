"""Sales-report visual analytics aggregations (YTD payload, no extra ERP)."""
from __future__ import annotations

import unittest

from planning.sales_report_analytics import (
    composition_from_grid,
    customer_pareto,
    mix_by_pp_type,
    otif_histogram,
    shipment_po_due,
)


def _grid():
    months = [
        {"month": 1, "label": "Jan-26", "mode": "past", "is_current": False},
        {"month": 2, "label": "Feb-26", "mode": "open", "is_current": True},
        {"month": 3, "label": "Mar-26", "mode": "open", "is_current": False},
    ]
    return {
        "year": 2026,
        "months": months,
        "rows": [
            {
                "id": "APS",
                "cells": [
                    {"month": 1, "mode": "past", "backlog_delivered": 100, "delivered": 200, "early_delivered": 50, "sales": 350},
                    {"month": 2, "mode": "open", "backlog": 80, "on_hand": 40},
                    {"month": 3, "mode": "open", "due_this_month": 25},
                ],
            },
            {
                "id": "NPS",
                "cells": [
                    {"month": 1, "mode": "past", "backlog_delivered": 10, "delivered": 20, "early_delivered": 5, "sales": 35},
                    {"month": 2, "mode": "open", "backlog": 8, "on_hand": 4},
                    {"month": 3, "mode": "open", "due_this_month": 2},
                ],
            },
            {
                "id": "MPS",
                "cells": [
                    {"month": 1, "mode": "past", "backlog_delivered": 999, "delivered": 0, "early_delivered": 0, "sales": 999},
                    {"month": 2, "mode": "open", "backlog": 999, "on_hand": 0},
                    {"month": 3, "mode": "open", "due_this_month": 0},
                ],
            },
        ],
    }


class CompositionTests(unittest.TestCase):
    def test_sums_selected_pp_types_only(self):
        bars = composition_from_grid(_grid(), ["APS", "NPS"])
        self.assertEqual(len(bars), 3)
        jan = bars[0]
        self.assertAlmostEqual(jan["series"]["backlog_delivered"], 110)
        self.assertAlmostEqual(jan["series"]["delivered"], 220)
        self.assertAlmostEqual(jan["series"]["early_delivered"], 55)
        self.assertAlmostEqual(jan["total"], 385)
        feb = bars[1]
        self.assertAlmostEqual(feb["series"]["backlog"], 88)
        self.assertAlmostEqual(feb["series"]["on_hand"], 44)
        mar = bars[2]
        self.assertAlmostEqual(mar["series"]["due_this_month"], 27)

    def test_posted_basis_uses_sales_for_past_months(self):
        bars = composition_from_grid(_grid(), ["APS"], posted_basis=True)
        self.assertAlmostEqual(bars[0]["series"]["sales"], 350)
        self.assertNotIn("backlog_delivered", bars[0]["series"])
        self.assertAlmostEqual(bars[1]["series"]["due_this_month"], 40)


class MixAndParetoTests(unittest.TestCase):
    def test_mix_groups_remaining_home(self):
        rows = [
            {"pp_type": "APS", "allocated_remaining_value": 100},
            {"pp_type": "APS", "allocated_remaining_value": 50},
            {"pp_type": "NPS", "remaining_value": 50},
            {"pp_type": "MPS", "allocated_remaining_value": 10},
        ]
        mix = mix_by_pp_type(rows, ["APS", "NPS"])
        by_id = {item["id"]: item for item in mix}
        self.assertAlmostEqual(by_id["APS"]["value"], 150)
        self.assertAlmostEqual(by_id["NPS"]["value"], 50)
        self.assertNotIn("MPS", by_id)
        self.assertAlmostEqual(by_id["APS"]["share"], 0.75)

    def test_pareto_ranks_and_other_bucket(self):
        rows = []
        for idx in range(10):
            rows.append(
                {
                    "pp_type": "NPS",
                    "customer_code": f"C{idx}",
                    "customer_name": f"Cust {idx}",
                    "allocated_remaining_value": 100 - idx,
                }
            )
        payload = customer_pareto(rows, ["NPS"], top_n=3)
        self.assertEqual(payload["customer_count"], 10)
        self.assertEqual(payload["items"][0]["label"], "Cust 0 (C0)")
        self.assertEqual(payload["items"][0]["value"], 100)
        self.assertEqual(payload["items"][-1]["key"], "__other__")
        self.assertEqual(payload["items"][-1]["label"], "Other (7)")
        self.assertAlmostEqual(payload["items"][0]["cumulative"], 100 / payload["total"], places=4)


class OtifTests(unittest.TestCase):
    def test_prefers_original_so_due_over_partial_due(self):
        row = {"shipment_date": "2026-02-24", "due_date": "2026-02-20", "so_due_date": "2026-01-29"}
        self.assertEqual(str(shipment_po_due(row)), "2026-01-29")

    def test_histogram_buckets_and_on_time_rate(self):
        shipments = [
            {"pp_type": "NPS", "shipment_date": "2026-02-10", "so_due_date": "2026-02-10"},  # 0
            {"pp_type": "NPS", "shipment_date": "2026-02-01", "so_due_date": "2026-02-10"},  # -9
            {"pp_type": "NPS", "shipment_date": "2026-03-20", "due_date": "2026-02-01"},  # 47
            {"pp_type": "APS", "shipment_date": "2026-02-10", "so_due_date": "2026-02-01"},  # filtered out
            {"pp_type": "NPS", "shipment_date": "2026-02-10"},  # skipped, no due
        ]
        payload = otif_histogram(shipments, ["NPS"])
        by_id = {item["id"]: item["count"] for item in payload["buckets"]}
        self.assertEqual(by_id["on_time"], 1)
        self.assertEqual(by_id["neg_13_1"], 1)
        self.assertEqual(by_id["ge_31"], 1)
        self.assertEqual(payload["classified"], 3)
        self.assertEqual(payload["skipped"], 1)
        self.assertEqual(payload["on_time"], 2)
        self.assertAlmostEqual(payload["on_time_rate"], 2 / 3, places=4)


if __name__ == "__main__":
    unittest.main()
