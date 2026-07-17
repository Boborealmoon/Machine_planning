"""Job ratio report — data accuracy unit tests."""
from __future__ import annotations

import unittest
from unittest.mock import patch

from flask import Flask

from planning.job_ratio import (
    MONTH_LENS_PO_DUE,
    MONTH_LENS_POSTED,
    aggregate_customer_rows,
    aggregate_month_bucket,
    aggregate_ranked_parts,
    attach_pp_metadata,
    build_job_rows_from_pp_vouchers,
    build_portion_summary,
    classify_volume_bucket,
    compare_lens_months,
    dedupe_pp_vouchers_by_ps,
    enrich_booked_row,
    filter_detail_rows,
    filter_rows_by_pp_types,
    month_anchor_date,
    row_has_positive_qty,
    sort_detail_rows,
)
from planning.sales_report_alloc import so_line_key
from planning.job_ratio_route import job_ratio_bp


def _line(
    so: str,
    line: str = "1",
    *,
    qty: float = 5,
    amount: float = 1000,
    month: int = 3,
    year: int = 2026,
    customer_code: str = "C1",
    customer_name: str = "Customer One",
    process_sheet_no: str | None = None,
) -> dict:
    due = f"{year}-{month:02d}-20"
    return {
        "sales_order_no": so,
        "line_item_no": line,
        "qty": qty,
        "line_amount": amount,
        "due_date": due,
        "pp_due_date": due,
        "so_due_date": due,
        "first_posted_datetime": f"{year}-{month:02d}-05",
        "customer_code": customer_code,
        "customer_name": customer_name,
        "process_sheet_no": process_sheet_no,
    }


class JobRatioBucketTests(unittest.TestCase):
    def test_2026_bucket_edges(self):
        self.assertEqual(classify_volume_bucket(1, 2026), "proto")
        self.assertEqual(classify_volume_bucket(10, 2026), "proto")
        self.assertEqual(classify_volume_bucket(11, 2026), "micro")
        self.assertEqual(classify_volume_bucket(30, 2026), "micro")
        self.assertEqual(classify_volume_bucket(31, 2026), "low")
        self.assertIsNone(classify_volume_bucket(0, 2026))

    def test_2025_micro_upper_bound_differs(self):
        self.assertEqual(classify_volume_bucket(50, 2025), "micro")
        self.assertEqual(classify_volume_bucket(51, 2025), "low")
        self.assertEqual(classify_volume_bucket(30, 2026), "micro")
        self.assertEqual(classify_volume_bucket(31, 2026), "low")


class JobRatioPpFilterTests(unittest.TestCase):
    def test_includes_line_when_any_pp_job_matches(self):
        booked = [_line("SO/1")]
        pp_jobs = [
            {
                "sales_order_no": "SO/1",
                "line_item_no": "1",
                "pp_voucher_no": "PP1",
                "process_sheet_no": "NPS-100",
            },
            {
                "sales_order_no": "SO/1",
                "line_item_no": "1",
                "pp_voucher_no": "PP2",
                "process_sheet_no": "APS-200",
            },
        ]
        attach_pp_metadata(booked, pp_jobs, pp_types={"APS"})
        enriched = [enrich_booked_row(booked[0], 2026)]
        filtered = filter_rows_by_pp_types(enriched, {"APS"})
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["pp_types_on_line"], ["APS", "NPS"])
        self.assertEqual(filtered[0]["process_sheet_no"], "APS-200")

    def test_excludes_untyped_lines_by_default(self):
        booked = [_line("SO/2")]
        attach_pp_metadata(booked, [], pp_types={"APS", "NPS"})
        enriched = [enrich_booked_row(booked[0], 2026)]
        filtered = filter_rows_by_pp_types(enriched, {"APS", "NPS"})
        self.assertEqual(filtered, [])

    def test_aps_only_excludes_nps_only_line(self):
        booked = [_line("SO/3")]
        pp_jobs = [
            {
                "sales_order_no": "SO/3",
                "line_item_no": "1",
                "pp_voucher_no": "PP1",
                "process_sheet_no": "NPS-100",
            },
        ]
        attach_pp_metadata(booked, pp_jobs, pp_types={"APS"})
        enriched = [enrich_booked_row(booked[0], 2026)]
        filtered = filter_rows_by_pp_types(enriched, {"APS"})
        self.assertEqual(filtered, [])


class JobRatioPpVoucherBuildTests(unittest.TestCase):
    def test_build_row_from_pp_voucher_uses_voucher_due_and_qty(self):
        so = {
            "sales_order_no": "SO/100",
            "line_item_no": "1",
            "qty": 99,
            "unit_selling_price": 10.0,
            "customer_code": "C1",
            "customer_name": "Customer",
            "due_date": "2026-06-01",
            "line_amount": 80.0,
        }
        vouchers = [
            {
                "ps_id": "NPS26-0001",
                "source_voucher_no": "SO/100",
                "source_line_item_no": "1",
                "due_date": "2026-02-10",
                "pp_qty": 8,
                "part_no": "PART-1",
                "description": "Widget",
            }
        ]
        built = build_job_rows_from_pp_vouchers(
            vouchers,
            {so_line_key("SO/100", "1"): {**so, "due_date": "2026-02-10"}},
        )
        self.assertEqual(len(built), 1)
        row = enrich_booked_row(built[0], 2026)
        self.assertEqual(row["pp_type"], "NPS")
        self.assertEqual(row["qty"], 8)
        self.assertEqual(row["line_amount"], 80.0)
        self.assertEqual(row["report_month"], 2)

    def test_pp_voucher_value_split_on_shared_so_line(self):
        so = {
            "sales_order_no": "SO/300",
            "line_item_no": "1",
            "qty": 100,
            "line_amount": 10000.0,
            "due_date": "2026-01-10",
        }
        vouchers = [
            {
                "ps_id": "NPS-1",
                "source_voucher_no": "SO/300",
                "source_line_item_no": "1",
                "due_date": "2026-01-10",
                "pp_qty": 25,
            },
            {
                "ps_id": "NPS-2",
                "source_voucher_no": "SO/300",
                "source_line_item_no": "1",
                "due_date": "2026-01-10",
                "pp_qty": 75,
            },
        ]
        built = build_job_rows_from_pp_vouchers(
            vouchers,
            {so_line_key("SO/300", "1"): so},
        )
        self.assertEqual(len(built), 2)
        self.assertAlmostEqual(sum(r["line_amount"] for r in built), 10000.0)
        self.assertAlmostEqual(built[0]["line_amount"], 2500.0)
        self.assertAlmostEqual(built[1]["line_amount"], 7500.0)

    def test_pp_qty_capped_to_so_line_qty(self):
        so = {
            "sales_order_no": "SO/400",
            "line_item_no": "1",
            "qty": 50,
            "line_amount": 5000.0,
            "due_date": "2026-01-10",
        }
        vouchers = [
            {
                "ps_id": "NPS-BIG",
                "source_voucher_no": "SO/400",
                "source_line_item_no": "1",
                "due_date": "2026-01-10",
                "pp_qty": 1000,
            },
        ]
        built = build_job_rows_from_pp_vouchers(
            vouchers,
            {so_line_key("SO/400", "1"): so},
        )
        self.assertEqual(len(built), 1)
        self.assertEqual(built[0]["qty"], 50)
        self.assertEqual(built[0]["line_amount"], 5000.0)
        self.assertEqual(enrich_booked_row(built[0], 2026)["volume_bucket"], "low")

    def test_pp_qty_used_not_ps_total_qty(self):
        so = {
            "sales_order_no": "SO/500",
            "line_item_no": "1",
            "qty": 99,
            "line_amount": 990.0,
            "due_date": "2026-04-01",
        }
        vouchers = [
            {
                "ps_id": "NPS-10",
                "source_voucher_no": "SO/500",
                "source_line_item_no": "1",
                "due_date": "2026-04-01",
                "pp_qty": 8,
                "total_qty": 40,
            },
        ]
        built = build_job_rows_from_pp_vouchers(
            vouchers,
            {so_line_key("SO/500", "1"): so},
        )
        self.assertEqual(built[0]["qty"], 8)
        self.assertEqual(enrich_booked_row(built[0], 2026)["volume_bucket"], "proto")

    def test_zero_pp_qty_job_excluded(self):
        so = {
            "sales_order_no": "SO/600",
            "line_item_no": "1",
            "qty": 99,
            "line_amount": 990.0,
            "due_date": "2026-05-01",
        }
        vouchers = [
            {
                "ps_id": "NPS-ZERO",
                "source_voucher_no": "SO/600",
                "source_line_item_no": "1",
                "due_date": "2026-05-01",
                "pp_qty": 0,
            },
            {
                "ps_id": "NPS-OK",
                "source_voucher_no": "SO/600",
                "source_line_item_no": "1",
                "due_date": "2026-05-01",
                "pp_qty": 12,
            },
        ]
        built = build_job_rows_from_pp_vouchers(
            vouchers,
            {so_line_key("SO/600", "1"): so},
        )
        self.assertEqual(len(built), 1)
        self.assertEqual(built[0]["process_sheet_no"], "NPS-OK")
        self.assertEqual(built[0]["qty"], 12)

    def test_portion_summary_skips_zero_qty_rows(self):
        rows = [
            enrich_booked_row({**_line("SO/A", qty=0, amount=0, month=1), "process_sheet_no": "NPS-0"}, 2026),
            enrich_booked_row({**_line("SO/B", qty=5, amount=100, month=1), "process_sheet_no": "NPS-1"}, 2026),
        ]
        self.assertFalse(row_has_positive_qty(rows[0]))
        summary = build_portion_summary(rows, 2026, {"NPS"}, lens=MONTH_LENS_PO_DUE)
        self.assertEqual(summary["line_count"], 1)
        self.assertEqual(summary["matrix"]["months"][0]["total"]["count"], 1)


class JobRatioAggregationTests(unittest.TestCase):
    def _enriched_lines(self):
        lines = [
            _line("SO/A", qty=5, amount=100, month=1),
            _line("SO/B", qty=20, amount=200, month=1),
            _line("SO/C", qty=40, amount=400, month=2),
        ]
        pp_jobs = [
            {
                "sales_order_no": row["sales_order_no"],
                "line_item_no": row["line_item_no"],
                "pp_voucher_no": f"PP-{row['sales_order_no']}",
                "process_sheet_no": "APS-1",
            }
            for row in lines
        ]
        attach_pp_metadata(lines, pp_jobs)
        return [enrich_booked_row(row, 2026) for row in lines]

    def test_matrix_ytd_matches_sum_of_months(self):
        rows = self._enriched_lines()
        matrix = aggregate_month_bucket(rows, 2026)
        month_total = sum(m["total"]["count"] for m in matrix["months"])
        self.assertEqual(month_total, matrix["ytd"]["total"]["count"])
        self.assertEqual(month_total, 3)

    def test_customer_monthly_sums_match_ytd(self):
        rows = self._enriched_lines()
        customers = aggregate_customer_rows(rows, 2026)
        self.assertEqual(len(customers), 1)
        cust = customers[0]
        month_jobs = sum(m["total"]["count"] for m in cust["months"])
        self.assertEqual(month_jobs, cust["total_count"])

    def test_detail_matches_matrix_classified_only(self):
        rows = self._enriched_lines()
        matrix = aggregate_month_bucket(rows, 2026)
        jan_proto = matrix["months"][0]["buckets"]["proto"]["count"]
        detail = filter_detail_rows(rows, year=2026, month=1, bucket="proto")
        self.assertEqual(len(detail), jan_proto)

    def test_report_month_uses_so_po_due_date(self):
        row = _line("SO/X", month=3, year=2026)
        row["so_due_date"] = "2026-03-15"
        row["po_due_date"] = "2026-06-20"
        row["ps_order_date"] = "2026-01-05"
        row["first_posted_datetime"] = "2026-01-05"
        enriched = enrich_booked_row(row, 2026, lens=MONTH_LENS_PO_DUE)
        self.assertEqual(enriched["report_month"], 3)

    def test_report_month_posted_lens_prefers_ps_order_date(self):
        row = _line("SO/X", month=3, year=2026)
        row["process_sheet_no"] = "NPS-1"
        row["so_due_date"] = "2026-06-20"
        row["ps_order_date"] = "2026-02-08"
        row["first_posted_datetime"] = "2026-01-05"
        enriched = enrich_booked_row(row, 2026, lens=MONTH_LENS_POSTED)
        self.assertEqual(enriched["report_month"], 2)

    def test_lens_months_can_differ(self):
        row = _line("SO/X", qty=5, amount=100, month=1, year=2026)
        row["process_sheet_no"] = "NPS-1"
        row["so_due_date"] = "2026-06-15"
        row["ps_order_date"] = "2026-01-10"
        row["first_posted_datetime"] = "2026-01-10"
        attach_pp_metadata([row], [{"sales_order_no": "SO/X", "line_item_no": "1", "process_sheet_no": "NPS-1"}])
        po = enrich_booked_row(row, 2026, lens=MONTH_LENS_PO_DUE)
        post = enrich_booked_row(row, 2026, lens=MONTH_LENS_POSTED)
        self.assertEqual(po["report_month"], 6)
        self.assertEqual(post["report_month"], 1)
        stats = compare_lens_months([row], 2026, pp_types={"NPS"})
        self.assertEqual(stats["different_month"], 1)

    def test_dedupe_pp_partials_keeps_latest(self):
        vouchers = [
            {"ps_id": "NPS-1", "pp_partial_no": 1, "stage_no": 1, "total_qty": 10},
            {"ps_id": "NPS-1", "pp_partial_no": 2, "stage_no": 1, "total_qty": 20},
        ]
        out = dedupe_pp_vouchers_by_ps(vouchers)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["pp_partial_no"], 2)

    def test_portion_summaries_share_value_totals(self):
        base = [_line("SO/A", qty=5, amount=100, month=1)]
        attach_pp_metadata(base, [{"sales_order_no": "SO/A", "line_item_no": "1", "process_sheet_no": "NPS-1"}])
        po = build_portion_summary(base, 2026, {"NPS"}, lens=MONTH_LENS_PO_DUE)
        posted = build_portion_summary(base, 2026, {"NPS"}, lens=MONTH_LENS_POSTED)
        self.assertEqual(po["matrix"]["months"][0]["total"]["value"], 100)
        self.assertEqual(posted["matrix"]["months"][0]["total"]["count"], 1)

    def test_detail_sorted_by_volume_bucket_then_qty(self):
        rows = [
            enrich_booked_row(_line("SO/L", qty=40, amount=400, month=2), 2026),
            enrich_booked_row(_line("SO/P", qty=5, amount=100, month=1), 2026),
            enrich_booked_row(_line("SO/M", qty=20, amount=200, month=1), 2026),
        ]
        detail = filter_detail_rows(rows, year=2026, sort="volume")
        self.assertEqual([r["sales_order_no"] for r in detail], ["SO/P", "SO/M", "SO/L"])
        self.assertEqual(detail[0]["volume_bucket"], "proto")
        self.assertEqual(detail[1]["volume_bucket"], "micro")
        self.assertEqual(detail[2]["volume_bucket"], "low")

    def test_detail_sorted_by_value_within_bucket(self):
        rows = [
            enrich_booked_row(_line("SO/A", qty=5, amount=50, month=1), 2026),
            enrich_booked_row(_line("SO/B", qty=8, amount=800, month=1), 2026),
        ]
        detail = sort_detail_rows(rows, sort="value")
        self.assertEqual(detail[0]["sales_order_no"], "SO/B")
        self.assertEqual(detail[1]["sales_order_no"], "SO/A")


class JobRatioRankedPartsTests(unittest.TestCase):
    def _part_row(
        self,
        so: str,
        part: str,
        *,
        qty: float,
        amount: float,
        month: int = 1,
        customer_code: str = "C1",
        customer_name: str = "Customer One",
        process_sheet: str | None = None,
    ) -> dict:
        row = _line(
            so,
            qty=qty,
            amount=amount,
            month=month,
            customer_code=customer_code,
            customer_name=customer_name,
            process_sheet_no=process_sheet or f"NPS-{so}",
        )
        row["inventory_code"] = part
        row["description"] = f"Description {part}"
        return enrich_booked_row(row, 2026)

    def test_groups_customer_part_and_counts_distinct_orders_and_sheets(self):
        rows = [
            self._part_row("SO/1", "P1", qty=10, amount=100, process_sheet="NPS-1"),
            self._part_row("SO/1", "P1", qty=5, amount=75, process_sheet="NPS-2"),
            self._part_row("SO/2", "P1", qty=20, amount=300, process_sheet="NPS-3"),
        ]
        ranked = aggregate_ranked_parts(rows, 2026)
        self.assertEqual(len(ranked), 1)
        self.assertEqual(ranked[0]["total_qty"], 35)
        self.assertEqual(ranked[0]["total_value"], 475)
        self.assertEqual(ranked[0]["order_count"], 2)
        self.assertEqual(ranked[0]["process_sheet_count"], 3)
        self.assertEqual(ranked[0]["average_unit_value"], 13.57)

    def test_filters_by_customer_month_and_thresholds(self):
        rows = [
            self._part_row("SO/1", "P1", qty=10, amount=100, month=1),
            self._part_row("SO/2", "P2", qty=25, amount=500, month=2),
            self._part_row(
                "SO/3",
                "P3",
                qty=50,
                amount=900,
                month=2,
                customer_code="C2",
                customer_name="Customer Two",
            ),
        ]
        ranked = aggregate_ranked_parts(
            rows,
            2026,
            month=2,
            customer_code="C1",
            min_qty=20,
            min_value=400,
        )
        self.assertEqual([row["part_no"] for row in ranked], ["P2"])

    def test_geometric_score_rewards_strength_in_both_dimensions(self):
        rows = [
            self._part_row("SO/HV", "HIGH-VOLUME", qty=100, amount=100),
            self._part_row("SO/H$", "HIGH-VALUE", qty=10, amount=1000),
            self._part_row("SO/B", "BALANCED", qty=60, amount=600),
        ]
        ranked = aggregate_ranked_parts(rows, 2026)
        self.assertEqual([row["part_no"] for row in ranked], ["BALANCED", "HIGH-VALUE", "HIGH-VOLUME"])
        self.assertEqual(ranked[0]["score"], 66.7)
        self.assertEqual({row["score"] for row in ranked[1:]}, {57.7})
        self.assertEqual([row["rank"] for row in ranked], [1, 2, 3])

    def test_repeat_demand_score_includes_nonzero_order_frequency(self):
        rows = [
            self._part_row("SO/A", "ONE-OFF", qty=100, amount=1000),
            self._part_row("SO/B1", "BALANCED", qty=25, amount=250),
            self._part_row("SO/B2", "BALANCED", qty=25, amount=250),
            self._part_row("SO/C1", "FREQUENT-LOW", qty=5, amount=50),
            self._part_row("SO/C2", "FREQUENT-LOW", qty=5, amount=50),
            self._part_row("SO/C3", "FREQUENT-LOW", qty=5, amount=50),
        ]
        volume_value = aggregate_ranked_parts(rows, 2026)
        repeat_demand = aggregate_ranked_parts(rows, 2026, score_mode="repeat_demand")
        self.assertEqual(volume_value[0]["part_no"], "ONE-OFF")
        self.assertEqual(repeat_demand[0]["part_no"], "ONE-OFF")
        self.assertEqual(repeat_demand[0]["order_percentile"], 33.3)
        self.assertEqual(repeat_demand[0]["score"], 71.9)
        balanced = next(row for row in repeat_demand if row["part_no"] == "BALANCED")
        self.assertEqual(balanced["score"], 66.7)
        self.assertEqual(balanced["score"], balanced["repeat_demand_score"])

    def test_ties_receive_equal_percentiles_and_deterministic_order(self):
        rows = [
            self._part_row("SO/2", "B", qty=10, amount=100),
            self._part_row("SO/1", "A", qty=10, amount=100),
        ]
        ranked = aggregate_ranked_parts(rows, 2026)
        self.assertEqual([row["part_no"] for row in ranked], ["A", "B"])
        self.assertEqual(ranked[0]["score"], ranked[1]["score"])

    def test_explicit_sort_modes(self):
        rows = [
            self._part_row("SO/1", "P1", qty=100, amount=100),
            self._part_row("SO/2", "P2", qty=10, amount=1000),
        ]
        self.assertEqual(aggregate_ranked_parts(rows, 2026, sort="volume")[0]["part_no"], "P1")
        self.assertEqual(aggregate_ranked_parts(rows, 2026, sort="value")[0]["part_no"], "P2")
        self.assertEqual(aggregate_ranked_parts(rows, 2026, sort="part")[0]["part_no"], "P1")


class JobRatioPartsRouteTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(job_ratio_bp)
        app.testing = True
        self.client = app.test_client()
        self.report = {
            "pp_types": ["NPS"],
            "customers": [{"customer_code": "C1", "customer_name": "Customer One"}],
            "booked_lines": [
                {
                    "report_year": 2026,
                    "report_month": 2,
                    "customer_code": "C1",
                    "customer_name": "Customer One",
                    "inventory_code": "P1",
                    "description": "Part One",
                    "qty": 25,
                    "line_amount": 500,
                    "process_sheet_no": "NPS-1",
                    "sales_order_no": "SO/1",
                }
            ],
        }

    @patch("planning.job_ratio_route._fetch_report")
    def test_parts_endpoint_defaults_to_nps_and_returns_ranking(self, fetch_report):
        fetch_report.return_value = self.report
        response = self.client.get("/api/job-ratio/parts?year=2026")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["rows"][0]["part_no"], "P1")
        self.assertEqual(payload["rows"][0]["rank"], 1)
        self.assertEqual(fetch_report.call_args.args[:2], (2026, {"NPS"}))

    @patch("planning.job_ratio_route._fetch_report")
    def test_parts_endpoint_applies_filters(self, fetch_report):
        fetch_report.return_value = self.report
        response = self.client.get(
            "/api/job-ratio/parts?year=2026&month=2&customer_code=C1"
            "&min_qty=20&min_value=400&sort=value&score_mode=repeat_demand"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["sort"], "value")
        self.assertEqual(payload["score_mode"], "repeat_demand")

    def test_parts_endpoint_rejects_invalid_parameters(self):
        for query in (
            "month=13",
            "min_qty=-1",
            "min_value=nope",
            "sort=unknown",
            "score_mode=unknown",
        ):
            response = self.client.get(f"/api/job-ratio/parts?year=2026&{query}")
            self.assertEqual(response.status_code, 400, query)


if __name__ == "__main__":
    unittest.main()
