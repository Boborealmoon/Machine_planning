from planning.inventory_where_used import assemble_where_used, material_match_type


def test_material_match_type_exact_and_suffix():
    assert material_match_type("WHITE ACETAL-NATURAL_D320_220", "WHITE ACETAL-NATURAL_D320_220") == "exact"
    assert material_match_type("WHITE ACETAL-NATURAL_D320_220", "WHITE ACETAL-NATURAL") == "inventory_suffix"
    assert material_match_type("WHITE ACETAL-NATURAL", "WHITE ACETAL-NATURAL_D320_220") == "bom_suffix"
    assert material_match_type("ALUMINIUM", "STEEL") == ""


def test_assemble_groups_open_and_excludes_unrelated_bom():
    payload = assemble_where_used(
        code="WHITE ACETAL-NATURAL_D320_220",
        bom_rows=[
            {
                "source_inventory_code": "WIDGET-A",
                "bom_code": "ROUTE-A",
                "material_inventory_code": "WHITE ACETAL-NATURAL",
                "description": "acetal",
                "qty_parent": 0.12,
                "qty_fg": 0.12,
                "uom_code": "KG",
            },
            {
                "source_inventory_code": "WIDGET-A",
                "bom_code": "ROUTE-B",
                "material_inventory_code": "STEEL-BAR",
                "qty_parent": 1,
                "qty_fg": 1,
                "uom_code": "EA",
            },
        ],
        open_rows=[
            {
                "ps_id": "APS26-1001",
                "pp_partial_no": 1,
                "part_no": "WIDGET-A",
                "part_desc": "Widget A",
                "bom_code": "ROUTE-A",
                "qty": 50,
                "due_date": "2026-09-12",
            },
            {
                "ps_id": "APS26-1002",
                "pp_partial_no": 1,
                "part_no": "WIDGET-A",
                "bom_code": "ROUTE-B",
                "qty": 20,
                "due_date": "2026-09-18",
            },
            {
                "ps_id": "APS26-1003",
                "pp_partial_no": 1,
                "part_no": "WIDGET-A",
                "bom_code": "",
                "qty": 10,
                "due_date": "2026-09-20",
            },
        ],
        historical_rows=[
            {
                "ps_id": "APS24-0099",
                "part_no": "WIDGET-A",
                "qty": 40,
                "sales_order_date": "2024-03-12",
            }
        ],
        part_descs={"WIDGET-A": "Widget housing"},
    )

    assert payload["counts"]["parent_parts"] == 1
    parent = payload["parents"][0]
    assert parent["source_inventory_code"] == "WIDGET-A"
    assert parent["part_desc"] == "Widget housing"
    assert [bom["bom_code"] for bom in parent["boms"]] == ["ROUTE-A"]
    assert parent["boms"][0]["match_type"] == "inventory_suffix"
    open_ids = [ps["ps_id"] for ps in parent["open_process_sheets"]]
    assert open_ids == ["APS26-1001", "APS26-1003"]
    assert parent["open_process_sheets"][0]["qty_needed"] == 6.0
    assert parent["open_process_sheets"][1]["bom_unconfirmed"] is True
    assert [ps["ps_id"] for ps in parent["historical_process_sheets"]] == ["APS24-0099"]
    assert payload["counts"]["open_ps"] == 2


def test_assemble_lists_process_sheets_that_make_the_part():
    payload = assemble_where_used(
        code="FG-PART",
        bom_rows=[],
        open_rows=[
            {
                "ps_id": "NPS26-0008",
                "pp_partial_no": 1,
                "part_no": "FG-PART",
                "qty": 12,
                "due_date": "2026-10-01",
                "bom_code": "STD",
            }
        ],
        historical_rows=[
            {"ps_id": "NPS23-0100", "part_no": "FG-PART", "qty": 8, "sales_order_date": "2023-01-04"}
        ],
    )
    assert payload["counts"]["parent_parts"] == 0
    assert payload["as_finished_part"]["open_process_sheets"][0]["ps_id"] == "NPS26-0008"
    assert payload["as_finished_part"]["open_process_sheets"][0]["via"] == "finished_part"
    assert payload["as_finished_part"]["historical_process_sheets"][0]["ps_id"] == "NPS23-0100"


def test_assemble_requirement_row_creates_parent_when_bom_listing_missing():
    payload = assemble_where_used(
        code="MAT-1",
        bom_rows=[],
        requirement_rows=[
            {
                "ps_id": "APS26-2222",
                "pp_partial_no": 1,
                "part_no": "PARENT-9",
                "source_inventory_code": "PARENT-9",
                "qty": 4,
                "planner_status": "PLANNED",
            }
        ],
    )
    assert payload["counts"]["parent_parts"] == 1
    parent = payload["parents"][0]
    assert parent["source_inventory_code"] == "PARENT-9"
    assert parent["open_process_sheets"][0]["via"] == "requirement"


def test_assemble_skips_open_rows_already_shown_in_history_dedupe():
    payload = assemble_where_used(
        code="MAT-1",
        bom_rows=[
            {
                "source_inventory_code": "PARENT-1",
                "bom_code": "A",
                "material_inventory_code": "MAT-1",
                "qty_parent": 1,
                "qty_fg": 1,
            }
        ],
        open_rows=[
            {"ps_id": "APS26-0001", "pp_partial_no": 1, "part_no": "PARENT-1", "bom_code": "A", "qty": 3}
        ],
        historical_rows=[
            {"ps_id": "APS26-0001", "part_no": "PARENT-1", "qty": 3, "sales_order_date": "2026-01-01"}
        ],
    )
    parent = payload["parents"][0]
    assert [ps["ps_id"] for ps in parent["open_process_sheets"]] == ["APS26-0001"]
    assert parent["historical_process_sheets"] == []
