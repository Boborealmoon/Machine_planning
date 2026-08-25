"""Tests for BOM materials resolve + route/stage fallback."""
from planning.bom_materials import resolve_bom_materials
from planning.utils import bom_code_match_key
from planning.utils import bom_code_match_key as shared_bom_code_match_key


def test_bom_code_match_key_aliases():
    assert bom_code_match_key("SMP-MAT-01_REV00") == bom_code_match_key("SMP-MAT-01-REV00")
    assert bom_code_match_key("SMP-MAT01-REV00") == bom_code_match_key("SMP-MAT-01_REV00")
    assert bom_code_match_key("SMP-MAT-01-REV00") == shared_bom_code_match_key("SMP-MAT01-REV00")


def test_resolve_route_no_materials_shows_matched_stages():
    def db_query(sql, params=(), fetchall=False):
        sql_l = " ".join(str(sql).lower().split())
        if "from public.inventory_bom_listing" in sql_l:
            return [] if fetchall else None
        if "from public.mt_inventory_bom" in sql_l and "mt_inventory_bom_stage" not in sql_l:
            assert params == ("BB28-KS0626-26 REV 00",)
            return [("SMP-MAT-01-REV00", "Rework Process Flow", "Y")]
        if "from public.mt_inventory_bom_stage" in sql_l:
            assert params == ("BB28-KS0626-26 REV 00",)
            return [
                ("SMP-MAT-01-REV00", 1, "Milling 20"),
                ("SMP-MAT-01-REV00", 2, "Final Inspection"),
                ("SMP-MAT-01-REV00", 3, "Packing"),
            ]
        raise AssertionError(f"unexpected sql: {sql_l}")

    result = resolve_bom_materials(
        db_query,
        "BB28-KS0626-26 REV 00",
        "SMP-MAT-01-REV00",
    )
    assert result["match_mode"] == "route_no_materials"
    assert result["route_matched"] is True
    assert result["matched_bom_code"] == "SMP-MAT-01-REV00"
    assert result["matched_bom_desc"] == "Rework Process Flow"
    assert [s["stage_desc"] for s in result["matched_stages"]] == [
        "Milling 20",
        "Final Inspection",
        "Packing",
    ]
    assert "Matched BOM route" in result["notice"]
    assert "Milling 20" in result["notice"]
    assert result["rows"] == []


def test_resolve_normalized_bom_alias_for_materials():
    listing = {
        "SMP-MAT01-REV00": [
            (
                "PART-1",
                "SMP-MAT01-REV00",
                "BAR-316",
                "Round bar",
                1.0,
                1.0,
                "PC",
            )
        ]
    }

    def db_query(sql, params=(), fetchall=False):
        sql_l = " ".join(str(sql).lower().split())
        if "count(distinct material_inventory_code)" in sql_l:
            return [("SMP-MAT01-REV00", 1)]
        if "from public.inventory_bom_listing" in sql_l:
            bom = params[1] if len(params) > 1 else None
            if bom is None:
                rows = []
                for items in listing.values():
                    rows.extend(items)
                return rows
            return list(listing.get(bom, []))
        raise AssertionError(f"unexpected sql: {sql_l}")

    result = resolve_bom_materials(db_query, "PART-1", "SMP-MAT-01_REV00")
    assert result["match_mode"] == "normalized_bom"
    assert result["resolved_bom_code"] == "SMP-MAT01-REV00"
    assert len(result["rows"]) == 1
    assert result["rows"][0]["material_inventory_code"] == "BAR-316"


def test_parts_with_leaf_bom_materials_uses_listing_filter():
    from planning.bom_materials import parts_with_leaf_bom_materials

    seen = {}

    def db_query(sql, params=(), fetchall=False):
        seen["sql"] = " ".join(str(sql).lower().split())
        seen["params"] = params
        seen["fetchall"] = fetchall
        return [("BB27-KS0040-54 REV 00",), ("",)]

    found = parts_with_leaf_bom_materials(
        db_query,
        ["BB27-KS0040-54 REV 00", "AA-1", "BB27-KS0040-54 REV 00"],
    )
    assert found == {"BB27-KS0040-54 REV 00"}
    assert seen["fetchall"] is True
    assert seen["params"] == (["BB27-KS0040-54 REV 00", "AA-1"],)
    assert "inventory_bom_listing" in seen["sql"]
    assert "not exists" in seen["sql"]


def test_parts_with_leaf_bom_materials_empty_sources():
    from planning.bom_materials import parts_with_leaf_bom_materials

    def db_query(*args, **kwargs):
        raise AssertionError("should not query ERP for empty sources")

    assert parts_with_leaf_bom_materials(db_query, ["", None]) == set()
