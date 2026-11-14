"""Derived RFQ status and the shared-workflow guards."""
from __future__ import annotations

from app import app
from planning.rfq_status import line_status, rfq_status
from planning.rfq_workflow import (
    RfqWorkflowError,
    derive_rfq_identity,
    require_team,
    tat_unlocked,
)


def _line(**kwargs):
    base = {
        "sn": 1,
        "qty": 4,
        "material": "Alloy",
        "rev": 1,
        "quote_ref_sn": None,
        "quote": None,
        "tat": {"days": None, "confirmed_rev": 1},
    }
    base.update(kwargs)
    return base


def test_draft_when_qty_or_material_is_missing():
    assert line_status([], _line(qty=None))["label"] == "Draft"
    assert line_status([], _line(material=""))["waiting_on"] == "Operations"


def test_supply_chain_states_before_a_quote():
    assert line_status([], _line())["label"] == "To be quoted"
    sent = _line(quote={"state": "rfq_sent", "confirmed_rev": 1, "lead_time_weeks": None})
    assert line_status([], sent)["label"] == "Awaiting supplier"


def test_quoted_line_moves_to_planning_then_sales():
    quoted = {"state": "quoted", "confirmed_rev": 1, "lead_time_weeks": 12}
    pending = _line(quote=quoted)
    assert line_status([], pending)["label"] == "TAT pending"
    stale = _line(
        rev=2,
        quote={"state": "quoted", "confirmed_rev": 2, "lead_time_weeks": 12},
        tat={"days": 10, "confirmed_rev": 1},
    )
    assert line_status([], stale)["label"] == "Ops changed – TAT reconfirm"
    ready = _line(quote=quoted, tat={"days": 10, "confirmed_rev": 1})
    assert line_status([], ready)["label"] == "Ready for Sales"


def test_ops_change_asks_supply_chain_to_reconfirm():
    quoted = {"state": "quoted", "confirmed_rev": 1, "lead_time_weeks": 8}
    stale = _line(rev=2, quote=quoted)
    status = line_status([], stale)
    assert status["label"] == "Ops changed – SC reconfirm"
    assert status["tone"] == "red"
    assert status["stale"] is True


def test_repeat_line_inherits_the_parent_quote_and_keeps_its_own_tat():
    parent = _line(sn=1, quote={"state": "quoted", "confirmed_rev": 1, "lead_time_weeks": 12})
    child = _line(sn=2, qty=40, quote_ref_sn=1, tat={"days": None, "confirmed_rev": 1})
    assert line_status([parent, child], child)["label"] == "TAT pending"
    child["rev"] = 3
    assert line_status([parent, child], child)["waiting_on"] == "Supply Chain"


def test_library_status_picks_the_earliest_open_team():
    draft = _line(sn=1, qty=None)
    quoted = _line(
        sn=2,
        quote={"state": "quoted", "confirmed_rev": 1, "lead_time_weeks": 4},
        tat={"days": None, "confirmed_rev": 1},
    )
    status = rfq_status([draft, quoted])
    assert status["waiting_on"] == "Operations"
    assert status["tone"] == "neutral"
    assert rfq_status([])["category"] == "ops"
    ready = _line(
        quote={"state": "quoted", "confirmed_rev": 1, "lead_time_weeks": 4},
        tat={"days": 6, "confirmed_rev": 1},
    )
    assert rfq_status([ready])["label"] == "Ready for Sales"


def test_identity_uses_the_file_and_folder_already_onboarded():
    number, customer, _title = derive_rfq_identity(
        "20261021_Dalia Life X & Manganese Tender",
        "OPS Sheet (RFQ_20261021).xlsx",
        14,
    )
    assert number == "RFQ20261021"
    assert customer == "Dalia Life X & Manganese Tender"
    number, customer, _title = derive_rfq_identity(
        "RFQ00010 Coway - Urgent for Brazil services",
        "OPS Sheet (BB18-KS0091-10).xlsx",
        18,
    )
    assert number == "RFQ00010"
    assert customer.startswith("RFQ00010 Coway")
    number, _customer, _title = derive_rfq_identity(
        "0023-75565",
        "OPS Sheet Rev 2 (0023-75565 rev03).xlsx",
        2,
    )
    assert number == "RFQ-0023-75565"
    number, customer, _title = derive_rfq_identity(
        "10053686-001",
        "OPS Sheet Rev 2 - AL SCV 10053686-001.xlsx",
        4,
    )
    assert number == "RFQ-10053686-001"
    assert customer == "10053686-001"
    number, customer, _title = derive_rfq_identity(
        "Dalia Life X & Manganese Tender",
        "OPS Sheet Rev 2 (TENDERING RFQ FOR - Dalia Life X & Manganese Tender).xlsx",
        8,
    )
    assert number.startswith("RFQ-Dalia-Life")
    assert customer == "Dalia Life X & Manganese Tender"


def test_tat_stays_locked_until_a_lead_time_is_quoted():
    assert tat_unlocked(None) is False
    assert tat_unlocked({"state": "rfq_sent", "lead_time_weeks": 4}) is False
    assert tat_unlocked({"state": "quoted", "lead_time_weeks": None}) is False
    assert tat_unlocked({"state": "quoted", "lead_time_weeks": 12}) is True


def test_sales_and_the_wrong_team_are_rejected_before_a_write():
    try:
        require_team("sales", ("ops",))
    except RfqWorkflowError as exc:
        assert exc.status == 403
    else:
        raise AssertionError("sales was allowed to write")
    try:
        require_team("planning", ("supply_chain",))
    except RfqWorkflowError as exc:
        assert "Planning" in exc.message
    else:
        raise AssertionError("planning was allowed to edit a quote")


def test_sales_route_refuses_an_ops_edit(monkeypatch):
    monkeypatch.setenv("PLANNER_PASSCODE", "")
    client = app.test_client()
    with client.session_transaction() as session:
        session["rfq_team"] = "sales"
    response = client.patch(
        "/api/rfq-workflow/lines/1/ops",
        json={"fields": {"rfq_qty_text": "4"}},
    )
    assert response.status_code == 403
    assert "Sales" in response.get_json()["error"]
