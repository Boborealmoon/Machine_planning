"""Guards so Process Sheets board SQL does not scan the full ERP WO table."""

from __future__ import annotations

import os
from unittest.mock import patch

from app import _filter_pp_vouchers_by_search, app
from planning.process_sheets import (
    _cheap_row_shipped_complete,
    _flow_steps_sql,
    _ps_select_search_clause,
    _ps_select_sql,
    slice_board_source_groups,
    split_process_sheet_search_terms,
)


def _norm(sql: str) -> str:
    return " ".join(sql.split()).lower()


def test_flow_steps_sql_does_not_materialize_full_erp_stage_cte():
    sql = _norm(_flow_steps_sql(merge_wo=False))
    assert "planner_process_sheet" in sql
    assert "planner_ps_id = any(%s)" in sql
    assert "erp_stage_outputs as (" not in sql
    assert "pp_vouchers_cache" not in sql
    assert "mfg_wo_status" not in sql


def test_flow_steps_sql_merge_wo_still_keys_to_current_ps():
    sql = _norm(_flow_steps_sql(merge_wo=True))
    assert "mfg_wo_status" in sql
    assert "erp_stage_outputs as (" not in sql
    assert "c.ps_id = ps.source_ps_id" in sql
    assert "c.stage_no = pfs.source_stage_no" in sql


def test_ps_select_default_skips_live_wo_join():
    sql = _norm(_ps_select_sql(merge_wo=False))
    assert "planner_keys as (" in sql
    assert "join planner_keys k" in sql
    assert "mfg_wo_status" not in sql


def test_process_sheets_page_hides_sync_erp_button():
    client = app.test_client()
    with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
        response = client.get("/process-sheets")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'id="nav-erp-sync-btn"' not in html


def test_split_process_sheet_search_terms_splits_commas_and_spaces():
    assert split_process_sheet_search_terms("APS26-0151, NPS25-0277 APS26-0152") == [
        "aps26-0151",
        "nps25-0277",
        "aps26-0152",
    ]


def test_ps_select_search_clause_uses_any_for_bulk_ps_numbers():
    terms = [f"APS26-{idx:04d}" for idx in range(151, 241)]
    sql, params = _ps_select_search_clause(", ".join(terms))
    normalized = _norm(sql)
    assert " = any(%s)" in normalized
    assert f"%{terms[0]}%" not in " ".join(str(p) for p in params)
    assert params[0] == [term.upper() for term in terms]


def test_ps_select_search_clause_keeps_explicit_partial():
    sql, params = _ps_select_search_clause("NPS25-0279-3")
    normalized = _norm(sql)
    assert "pp_partial_no, 1)) in" in normalized
    assert "NPS25-0279" in params
    assert 3 in params


def test_filter_pp_vouchers_by_search_matches_bulk_ps_ids_without_haystack():
    rows = [
        {"ps_id": "APS26-0151", "source_ps_id": "APS26-0151", "pp_partial_no": 1, "ops": [{"operation_name": "Turning"}]},
        {"ps_id": "NPS25-0277", "source_ps_id": "NPS25-0277", "pp_partial_no": 1, "ops": [{"operation_name": "Milling"}]},
        {"ps_id": "APS26-0999", "source_ps_id": "APS26-0999", "pp_partial_no": 1, "ops": [{"operation_name": "Turning"}]},
    ]
    matched = _filter_pp_vouchers_by_search(rows, "APS26-0151 NPS25-0277")
    ids = {row["source_ps_id"] for row in matched}
    assert ids == {"APS26-0151", "NPS25-0277"}


def test_filter_pp_vouchers_by_search_matches_sr_tagged_ids():
    rows = [
        {
            "ps_id": "N26-[SR]22",
            "source_ps_id": "N26-[SR]22",
            "pp_partial_no": 1,
            "part_no": "BB14-KS0188-05 REV 04",
            "ops": [],
        }
    ]
    assert [row["ps_id"] for row in _filter_pp_vouchers_by_search(rows, "n26-[SR]22")] == [
        "N26-[SR]22"
    ]
    assert [row["ps_id"] for row in _filter_pp_vouchers_by_search(rows, "n26-22")] == [
        "N26-[SR]22"
    ]


def test_search_term_variants_pad_unpad_serials():
    from app import _search_term_variants

    variants = _search_term_variants("0385")
    assert "0385" in variants
    assert "385" not in variants
    rows = [
        {"ps_id": "NPS26-0385", "source_ps_id": "NPS26-0385", "pp_partial_no": 1, "ops": []},
        {"ps_id": "NPS26-385", "source_ps_id": "NPS26-385", "pp_partial_no": 1, "ops": []},
        {"ps_id": "MPS26-3850", "source_ps_id": "MPS26-3850", "pp_partial_no": 1, "ops": []},
        {"ps_id": "NPS26-0999", "source_ps_id": "NPS26-0999", "pp_partial_no": 1, "ops": []},
    ]
    assert {row["ps_id"] for row in _filter_pp_vouchers_by_search(rows, "0385")} == {
        "NPS26-0385",
        "NPS26-385",
    }
    assert {row["ps_id"] for row in _filter_pp_vouchers_by_search(rows, "385")} == {
        "NPS26-0385",
        "NPS26-385",
    }
    assert {row["ps_id"] for row in _filter_pp_vouchers_by_search(rows, "NPS26-0385")} == {
        "NPS26-0385",
    }
    assert _filter_pp_vouchers_by_search(rows, "NPS26-0385")[0]["ps_id"] != "MPS26-3850"


def test_inline_live_repair_ids_prefer_sr_hosts_and_donors():
    from app import _pp_vouchers_inline_live_repair_ids

    merged = [
        {
            "ps_id": "MPS26-2821",
            "source_ps_id": "MPS26-2821",
            "assembly_line_items": [
                {"ps_id": "MPS26-2821-1", "op_cards": []},
            ],
        },
        {
            "ps_id": "N26-[SR]22",
            "source_ps_id": "N26-[SR]22",
            "assembly_line_items_related_from": "NPS26-0321",
            "assembly_line_items": [
                {
                    "ps_id": "N26-[SR]22-12",
                    "donor_ps_id": "NPS26-0321-12",
                    "op_cards": [],
                }
            ],
        },
        {
            "ps_id": "APS26-0001",
            "source_ps_id": "APS26-0001",
            "inventory_code": "X",
            "selected_bom_id": 0,
            "ops": [],
        },
    ]
    ids = _pp_vouchers_inline_live_repair_ids(merged)
    assert ids[0] == "N26-[SR]22"
    assert ids[1] == "NPS26-0321-12"
    assert "MPS26-2821-1" in ids


def test_cached_catalog_search_filters_and_repairs_hit_family():
    from app import _pp_vouchers_cached_response_rows

    parent = {"ps_id": "NPS26-0361", "source_ps_id": "NPS26-0361", "pp_partial_no": 1, "ops": []}
    child = {"ps_id": "NPS26-0361-1", "source_ps_id": "NPS26-0361-1", "pp_partial_no": 1, "ops": []}
    other = {"ps_id": "NPS26-0999", "source_ps_id": "NPS26-0999", "pp_partial_no": 1, "ops": []}
    attached_ids = []

    def fake_attach(rows):
        attached_ids.extend(row["ps_id"] for row in rows)
        return rows

    with (
        patch(
            "app._merge_fresh_temp_ps_catalog_entries",
            side_effect=lambda data, include_completed=False: list(data),
        ) as merge,
        patch("planning.assembly_classify.attach_catalog_assembly_line_items", side_effect=fake_attach),
        patch("app._repair_scoped_catalog_ops") as repair,
    ):
        rows = _pp_vouchers_cached_response_rows([parent, child, other], False, "0361")

    assert {row["ps_id"] for row in rows} == {"NPS26-0361", "NPS26-0361-1"}
    assert set(attached_ids) == {"NPS26-0361", "NPS26-0361-1"}
    merge.assert_not_called()
    repair.assert_called_once()
    repaired = repair.call_args.args[0]
    assert {row["ps_id"] for row in repaired} == {"NPS26-0361", "NPS26-0361-1"}


def test_catalog_search_attach_subset_includes_children():
    from app import _catalog_rows_for_search_attach

    parent = {"ps_id": "NPS26-0361", "source_ps_id": "NPS26-0361"}
    child = {"ps_id": "NPS26-0361-1", "source_ps_id": "NPS26-0361-1"}
    other = {"ps_id": "NPS26-0999", "source_ps_id": "NPS26-0999"}
    subset = _catalog_rows_for_search_attach([parent, child, other], [parent])
    assert {row["ps_id"] for row in subset} == {"NPS26-0361", "NPS26-0361-1"}


def test_catalog_search_attach_subset_includes_related_sr_family():
    from app import _catalog_rows_for_search_attach

    sr = {"ps_id": "N26-[SR]22", "source_ps_id": "N26-[SR]22", "part_no": "KIT-001"}
    nps = {"ps_id": "NPS26-0321", "source_ps_id": "NPS26-0321", "part_no": "KIT-001"}
    nps_child = {"ps_id": "NPS26-0321-10", "source_ps_id": "NPS26-0321-10", "part_no": "CHILD-J"}
    other = {"ps_id": "NPS26-0999", "source_ps_id": "NPS26-0999", "part_no": "OTHER"}
    subset = _catalog_rows_for_search_attach([sr, nps, nps_child, other], [sr])
    assert {row["ps_id"] for row in subset} == {"N26-[SR]22", "NPS26-0321", "NPS26-0321-10"}


def test_cheap_shipped_complete_skips_temp_and_open_so_lines():
    assert _cheap_row_shipped_complete({
        "ps_id": "[Temp]NPS26-1-1",
        "so_det_qty": 10,
        "qty_shipped": 10,
    }) is False
    assert _cheap_row_shipped_complete({
        "ps_id": "NPS26-1::1",
        "so_det_qty": 10,
        "qty_shipped": 10,
    }) is True
    assert _cheap_row_shipped_complete({
        "ps_id": "NPS26-1::1",
        "so_det_qty": 10,
        "qty_shipped": 4,
    }) is False
    assert _cheap_row_shipped_complete({
        "ps_id": "NPS26-1::1",
        "so_det_qty": None,
        "qty_shipped": 4,
    }) is False


def test_slice_board_source_groups_keeps_partials_together():
    rows = [
        {"ps_id": "A::1", "source_ps_id": "A", "pp_partial_no": 1},
        {"ps_id": "B::1", "source_ps_id": "B", "pp_partial_no": 1},
        {"ps_id": "A::2", "source_ps_id": "A", "pp_partial_no": 2},
        {"ps_id": "C::1", "source_ps_id": "C", "pp_partial_no": 1},
    ]
    first, next_offset, has_more = slice_board_source_groups(rows, 0, 1)
    assert [row["ps_id"] for row in first] == ["A::1", "A::2"]
    assert next_offset == 1
    assert has_more is True

    second, next_offset, has_more = slice_board_source_groups(rows, next_offset, 1)
    assert [row["ps_id"] for row in second] == ["B::1"]
    assert next_offset == 3
    assert has_more is True

    third, next_offset, has_more = slice_board_source_groups(rows, next_offset, 1)
    assert [row["ps_id"] for row in third] == ["C::1"]
    assert next_offset == 4
    assert has_more is False

    again, next_offset, has_more = slice_board_source_groups(rows, 2, 10)
    assert [row["ps_id"] for row in again] == ["C::1"]
    assert has_more is False
