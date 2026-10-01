"""Role capability matrix for Day/Night HOTO."""

from planning.shift_management_roles import (
    capabilities,
    has_cap,
    home_path,
    nav_items,
    normalize_role,
)
from planning.shift_management_service import (
    OPEN_TICKET_STATUSES,
    TICKET_STATUSES,
    group_ops_machines,
    stamp_ticket_submitter,
    user_may_view_ticket,
)


def test_admin_gets_dashboard_home_not_ops():
    caps = capabilities("admin")
    assert caps["home"] == "dashboard"
    assert caps["can_view_dashboard"] is True
    assert caps["can_ops_actions"] is False
    assert caps["can_report"] is True
    assert home_path("admin", "/Shift-management") == "/Shift-management/dashboard"
    labels = [item["label"] for item in nav_items("admin", "/Shift-management")]
    assert labels == ["Dashboard", "Queue", "HOTO", "Backlog", "History"]
    assert caps["can_view_hoto_backlog"] is True


def test_supervisor_reviews_queue_tickets_history():
    caps = capabilities("supervisor")
    assert caps["home"] == "ops"
    assert caps["can_view_ops"] is True
    assert caps["can_review_ticket"] is True
    assert caps["can_resolve_ticket"] is True
    assert caps["can_create_ticket"] is True
    assert caps["can_report"] is True
    assert caps["can_view_history"] is True
    labels = [item["label"] for item in nav_items("supervisor", "/Shift-management")]
    assert labels == ["Queue", "Tickets", "HOTO", "History"]


def test_operator_is_jobs_and_create_ticket_only():
    caps = capabilities("operator")
    assert caps["home"] == "jobs"
    assert caps["can_view_dashboard"] is False
    assert caps["can_view_history"] is False
    assert caps["can_view_ops"] is False
    assert caps["can_handover"] is False
    assert caps["can_resolve_ticket"] is False
    assert caps["can_create_ticket"] is True
    assert caps["can_view_jobs"] is True
    assert has_cap({"role": "operator"}, "can_report") is False
    labels = [item["label"] for item in nav_items("operator", "/Shift-management")]
    assert labels == ["Jobs", "Tickets"]


def test_quality_matches_operator_visibility_with_quality_default():
    caps = capabilities("quality")
    assert caps["home"] == "jobs"
    assert caps["can_create_ticket"] is True
    assert caps["can_view_jobs"] is True
    assert caps["can_resolve_ticket"] is False
    assert caps["can_review_ticket"] is False
    assert caps["can_handover"] is False
    assert caps["fleet_view"] is True
    assert caps["default_ticket_category"] == "Quality"
    assert capabilities("operator")["fleet_view"] is False


def test_unknown_role_falls_back_to_operator():
    assert normalize_role("nope") == "operator"
    assert capabilities("nope")["role"] == "operator"


def test_group_ops_machines_still_groups_jobs():
    machines = [
        {"machine_id": 2, "machine_no": "CNC 20", "machine_category": "Turning"},
        {"machine_id": 1, "machine_no": "CNC 10", "machine_category": "Milling"},
    ]
    blocks = [
        {
            "machine_id": 1,
            "machine_no": "CNC 10",
            "process_sheet_no": "PS-100",
            "queue_position": 1,
        },
        {
            "machine_id": 1,
            "machine_no": "CNC 10",
            "process_sheet_no": "PS-101",
            "queue_position": 2,
        },
    ]
    grouped = group_ops_machines(
        machines,
        blocks,
        handovers_by_machine={1: {"status": "draft", "priority": "Normal"}},
        ticket_counts={(1, "PS-100"): 2},
        machine_ticket_counts={1: 2, 2: 0},
    )
    assert [row["machine_no"] for row in grouped] == ["CNC 10", "CNC 20"]
    busy, idle = grouped
    assert busy["queue_count"] == 2
    assert idle["jobs"] == []


def test_ticket_keeps_submitter_identity_and_status_codes():
    item = stamp_ticket_submitter(
        {
            "submitter_name": "",
            "submitter_username": "",
            "submitter_role": "",
            "created_by_name": "Operator One",
            "created_by_username": "op1",
            "created_by_role": "operator",
        }
    )
    assert item["submitter_name"] == "Operator One"
    assert item["submitter_username"] == "op1"
    assert item["submitter_role"] == "operator"
    assert item["created_by_name"] == "Operator One"
    assert TICKET_STATUSES == ("open", "in_progress", "on_hold", "resolved", "closed")
    assert OPEN_TICKET_STATUSES == ("open", "in_progress", "on_hold")


def test_operator_sees_only_own_ticket():
    own = {"created_by": 4}
    other = {"created_by": 9}
    operator = {"user_id": 4, "role": "operator"}
    supervisor = {"user_id": 1, "role": "supervisor"}
    assert user_may_view_ticket(operator, own) is True
    assert user_may_view_ticket(operator, other) is False
    assert user_may_view_ticket(supervisor, other) is True
    assert capabilities("operator")["can_resolve_ticket"] is False
