"""Anticipated material arrivals from S/O Material in / Sub-Con dates."""
from __future__ import annotations

from datetime import date
from unittest import TestCase
from unittest.mock import patch

from planning.anticipated_material_service import (
    anticipated_material_payload,
    apply_anticipated_material_fields,
    build_item,
    iso_week_fields,
    material_subcon_is_arrived,
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
        assert material_subcon_is_arrived("ARRIVED") is True
        assert material_subcon_is_arrived("Arrived") is True

    def test_arrived_keeps_stored_date(self):
        assert material_subcon_is_arrived("ARRIVED|2026-09-25") is True
        assert parse_material_subcon_date("ARRIVED|2026-09-25") == date(2026, 9, 25)
        assert parse_material_subcon_date("arrived|25/09/2026") == date(2026, 9, 25)

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
        assert item["material"] == ""
        assert item["material_description"] == "Valve body"

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


class TestApplyAnticipatedMaterialFields(TestCase):
    def test_uses_bom_leaf_material_and_description(self):
        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/1",
                process_sheet_no="NPS26-0338",
                part_no="8816-01",
                description="Valve body",
                bom_code="BOM-A",
            )
        ]
        code_map = {
            ("8816-01", "BOM-A"): [
                {"material_inventory_code": "SS316-BAR", "description": "316 SS bar 50mm"},
            ]
        }
        apply_anticipated_material_fields(items, code_map)
        assert items[0]["material"] == "SS316-BAR"
        assert items[0]["material_description"] == "316 SS bar 50mm"
        assert items[0]["material_codes"] == ["SS316-BAR"]

    def test_request_without_bom_uses_part_as_material(self):
        items = [
            build_item(
                source="request",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="req:9",
                part_no="AL6061-PLATE",
                description="Aluminium plate",
            )
        ]
        apply_anticipated_material_fields(items, {})
        assert items[0]["material"] == "AL6061-PLATE"
        assert items[0]["material_description"] == "Aluminium plate"

    def test_joins_multiple_materials(self):
        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/2",
                process_sheet_no="APS26-0001",
                part_no="ASM-01",
                description="Assembly",
                bom_code="BOM-B",
            )
        ]
        code_map = {
            ("ASM-01", "BOM-B"): [
                {"material_inventory_code": "MAT-A", "description": "Steel"},
                {"material_inventory_code": "MAT-B", "description": "Insert"},
            ]
        }
        apply_anticipated_material_fields(items, code_map)
        assert items[0]["material"] == "MAT-A, MAT-B"
        assert items[0]["material_description"] == "Steel · Insert"

    def test_normalizes_bom_code_aliases(self):
        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/3",
                process_sheet_no="NPS26-0357",
                part_no="BB27-KS0040-16 REV OO",
                description="Flushing adaptor",
                bom_code="SMP-MAT-01_REV00",
            )
        ]
        by_part = {
            "BB27-KS0040-16 REV OO": [
                {
                    "material_inventory_code": "SUS316L*6_D25.4",
                    "description": "EN-10088 bar",
                    "bom_code": "SMP-MAT-01-REV00",
                }
            ]
        }
        apply_anticipated_material_fields(items, {}, by_part=by_part)
        assert items[0]["material"] == "SUS316L*6_D25.4"
        assert items[0]["material_description"] == "EN-10088 bar"

    def test_prefers_process_sheet_material_requirement(self):
        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/4",
                process_sheet_no="NPS26-0386",
                part_no="BB18-KS1594-29 REV 00",
                description="Manifold block",
            )
        ]
        by_ps = {
            "NPS26-0386": [
                {"material_inventory_code": "AISI 4140", "description": "4140 bar 180mm"},
            ]
        }
        apply_anticipated_material_fields(items, {}, by_ps=by_ps)
        assert items[0]["material"] == "AISI 4140"
        assert items[0]["material_description"] == "4140 bar 180mm"

    def test_mtl_part_order_is_the_incoming_material(self):
        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/5",
                process_sheet_no="NPS26-0386",
                part_no="BB18-KS1594-29 REV 00",
                description="Manifold block 9 way",
                notes="S_DUPLEX 60*6_47.0_240.0_65.0",
            )
        ]
        apply_anticipated_material_fields(items, {})
        assert items[0]["material"] == "S_DUPLEX 60*6_47.0_240.0_65.0"
        assert items[0]["material_description"] == "Manifold block 9 way"

    def test_ignores_assembly_status_notes(self):
        items = [
            build_item(
                source="so",
                arrival=date(2026, 8, 28),
                today=date(2026, 8, 19),
                row_id="so:PP/6",
                process_sheet_no="NPS26-0321",
                part_no="BB14-KS0188-05 REV 04",
                description="RIMS lockdown",
                notes="Assembly Part:\nTooling Status - Null",
            )
        ]
        apply_anticipated_material_fields(items, {})
        assert items[0]["material"] == ""
        assert items[0]["material_description"] == "RIMS lockdown"


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
