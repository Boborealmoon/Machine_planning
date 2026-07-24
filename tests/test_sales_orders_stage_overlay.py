"""Sales-order stage overlay: closed WO history must not become No WO."""

from planning.sales_orders_route import _stage_overlay_from_row


def test_stage_overlay_unassigned_with_wo_history_becomes_completed():
    """Closed stages with qty/rework shortfall used to fall through to unassigned."""
    out = _stage_overlay_from_row(
        {
            "erp_stage_mode": "unassigned",
            "erp_wo_stage_count": 10,
            "erp_all_wo_complete": False,
            "current_stage_no": None,
            "current_stage_desc": "",
            "current_stage_status": "",
            "erp_last_stage_no": 7,
            "erp_last_stage_desc": "Packing & Engraving",
            "erp_last_stage_status": "C",
        }
    )
    assert out["erp_stage_mode"] == "completed"
    assert out["erp_all_wo_complete"] is True
    assert out["erp_wo_stage_count"] == 10


def test_stage_overlay_true_no_wo_stays_unassigned():
    out = _stage_overlay_from_row(
        {
            "erp_stage_mode": "unassigned",
            "erp_wo_stage_count": 0,
            "erp_all_wo_complete": False,
            "current_stage_no": None,
            "current_stage_desc": "",
            "current_stage_status": "",
        }
    )
    assert out["erp_stage_mode"] == "unassigned"
    assert out["erp_all_wo_complete"] is False


def test_stage_overlay_open_stage_wins():
    out = _stage_overlay_from_row(
        {
            "erp_stage_mode": "completed",
            "erp_wo_stage_count": 4,
            "erp_all_wo_complete": False,
            "current_stage_no": 2,
            "current_stage_desc": "Turning 20",
            "current_stage_status": "I",
        }
    )
    assert out["erp_stage_mode"] == "open"
    assert out["current_stage_desc"] == "Turning 20"
