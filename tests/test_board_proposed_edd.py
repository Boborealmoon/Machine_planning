"""Proposed EDD stays separate from PO due on machine-queue op cards."""

from planning.process_sheets import _fold_commitment_date_rows


def test_fold_keeps_po_due_and_proposed_edd_separate():
    due_out, coway_out = _fold_commitment_date_rows(
        ["NPS26-0408", "NPS26-0389"],
        [
            {
                "planner_ps_id": "NPS26-0408",
                "due_date": "2026-11-05",
                "coway_proposed_edd": "2026-10-20",
            },
            {
                "planner_ps_id": "NPS26-0389",
                "due_date": "",
                "coway_proposed_edd": "2026-12-01 00:00:00",
            },
        ],
    )
    assert due_out["NPS26-0408"] == "2026-11-05"
    assert coway_out["NPS26-0408"] == "2026-10-20"
    assert due_out["NPS26-0389"] == "2026-12-01 00:00:00"
    assert coway_out["NPS26-0389"] == "2026-12-01"


def test_attach_board_meta_sets_proposed_edd(monkeypatch):
    from planning import planner_routes as routes

    monkeypatch.setattr(routes, "material_in_overlay_for_planner_ps_ids", lambda _con, _ids: {})
    monkeypatch.setattr(
        routes,
        "commitment_dates_for_planner_ps_ids",
        lambda _con, _ids: (
            {"NPS26-0408": "2026-11-05"},
            {"NPS26-0408": "2026-10-20"},
        ),
    )
    monkeypatch.setattr(routes, "tooling_map_for_operation_ids", lambda _con, _ids: {})
    monkeypatch.setattr(routes, "program_map_for_operation_ids", lambda _con, _ids: {})
    monkeypatch.setattr(routes, "collapse_block_ready_flags_by_source_ps", lambda _blocks: None)

    blocks = [{"planner_ps_id": "NPS26-0408", "job_no": "NPS26-0408", "operation_id": 0}]
    routes._attach_board_meta_to_blocks(object(), blocks)
    assert blocks[0]["due_date"] == "2026-11-05"
    assert blocks[0]["coway_proposed_edd"] == "2026-10-20"
