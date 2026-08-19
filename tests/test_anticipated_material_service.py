"""Anticipated material arrivals from S/O Material in / Sub-Con dates."""
from __future__ import annotations

from datetime import date
from unittest import TestCase
from unittest.mock import patch

from planning.anticipated_material_service import (
    anticipated_material_payload,
    build_item,
    iso_week_fields,
    parse_material_subcon_date,
    week_range_label,
)


class TestParseMaterialSubconDate(TestCase):
    def test_iso_date(self):
        assert parse_material_subcon_date("2026-08-28") == date(2026, 8, 28)

    def test_dmy_date(self):
        assert parse_material_subcon_date("28/08/2026") == date(2026, 8, 28)

    def test_arrived_is_not_a_date(self):
        assert parse_material_subcon_date("Arrived") is None
        assert parse_material_subcon_date("ARRIVED") is None

    def test_empty_and_legacy_text(self):
        assert parse_material_subcon_date("") is None
        assert parse_material_subcon_date(None) is None
        assert parse_material_subcon_date("Chuan Heng for programming") is None


class TestIsoWeekFields(TestCase):
    def test_groups_by_iso_week_matching_so_management(self):
        # Friday 28 Aug 2026 is ISO week 35
        fields = iso_week_fields(date(2026, 8, 28), today=date(2026, 8, 19))
        assert fields["iso_week"] == 35
        assert fields["iso_year"] == 2026
        assert fields["week_key"] == "2026-W35"
        assert fields["week_day_label"] == "Week 35 - Friday"
        assert fields["week_range_start"] == "2026-08-24"
        assert fields["week_range_end"] == "2026-08-30"
        assert fields["week_range_label"] == "24-30 Aug 2026"
        assert fields["overdue"] is False
        assert fields["this_week"] is False

    def test_this_week_and_overdue(self):
        today = date(2026, 8, 19)
        this_week = iso_week_fields(date(2026, 8, 21), today=today)
        overdue = iso_week_fields(date(2026, 8, 10), today=today)
        assert this_week["this_week"] is True
        assert this_week["overdue"] is False
        assert overdue["overdue"] is True
        assert overdue["this_week"] is False

    def test_week_range_crosses_month(self):
        fields = iso_week_fields(date(2026, 9, 1), today=date(2026, 8, 19))
        assert fields["week_range_label"] == "31 Aug-6 Sep 2026"


class TestBuildItemAndPayload(TestCase):
    def test_so_item_includes_week_and_job_fields(self):
        item = build_item(
            source="so",
            arrival=date(2026, 8, 28),
            today=date(2026, 8, 19),
            row_id="so:PP/1",
            process_sheet_no="NPS26-0338",
            sales_order_no="SO/2602501",
            part_no="8816-01",
            description="Valve body",
            qty=12,
            due_date=date(2026, 9, 4),
            customer_name="Acme",
            notes="Need by Friday",
        )
        assert item["ps_type"] == "NPS"
        assert item["arrival_date"] == "2026-08-28"
        assert item["week_key"] == "2026-W35"
        assert item["due_date"] == "2026-09-04"
        assert item["sales_order_no"] == "SO/2602501"

    def test_payload_counts(self):
        items = [
            build_item(source="so", arrival=date(2026, 8, 10), today=date(2026, 8, 19), row_id="a"),
            build_item(source="so", arrival=date(2026, 8, 21), today=date(2026, 8, 19), row_id="b"),
            build_item(source="request", arrival=date(2026, 8, 28), today=date(2026, 8, 19), row_id="c"),
        ]
        payload = anticipated_material_payload(items)
        assert payload["ok"] is True
        assert payload["count"] == 3
        assert payload["overdue_count"] == 1
        assert payload["this_week_count"] == 1

    def test_week_range_label_same_month(self):
        assert week_range_label(date(2026, 8, 24), date(2026, 8, 30)) == "24-30 Aug 2026"


class TestAnticipatedMaterialRoute(TestCase):
    def test_api_returns_items(self):
        from app import app

        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/1",
                process_sheet_no="NPS26-0338",
                sales_order_no="SO/2602501",
            )
        ]
        with patch.dict("os.environ", {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
            with patch("planning.finishing_queue_route.planner_db") as db:
                db.return_value.__enter__.return_value = object()
                db.return_value.__exit__.return_value = False
                with patch(
                    "planning.finishing_queue_route.fetch_anticipated_material",
                    return_value=items,
                ):
                    client = app.test_client()
                    response = client.get("/api/finishing-queue/anticipated-material")

        assert response.status_code == 200
        payload = response.get_json()
        assert payload["ok"] is True
        assert payload["count"] == 1
        assert payload["items"][0]["week_day_label"] == "Week 35 - Friday"
