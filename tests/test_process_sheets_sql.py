"""Guards so Process Sheets board SQL does not scan the full ERP WO table."""

from __future__ import annotations

import os
from unittest.mock import patch

from app import _filter_pp_vouchers_by_search, app
from planning.process_sheets import (
    _flow_steps_sql,
    _ps_select_search_clause,
    _ps_select_sql,
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
