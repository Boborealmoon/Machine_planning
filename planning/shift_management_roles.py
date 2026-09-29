"""Role capabilities for Day/Night HOTO (admin / supervisor / operator / quality)."""
from __future__ import annotations

from typing import Any

from .utils import compact_text

ROLES = ("operator", "supervisor", "quality", "admin")


def normalize_role(user_or_role: Any) -> str:
    if isinstance(user_or_role, dict):
        text = compact_text(user_or_role.get("role")).lower()
    else:
        text = compact_text(user_or_role).lower()
    return text if text in ROLES else "operator"


def capabilities(role: Any) -> dict[str, Any]:
    """Return UI + API flags for a role. Operator is the locked-down default."""
    r = normalize_role(role)
    if r == "admin":
        return {
            "role": r,
            "home": "dashboard",
            "nav": ("dashboard", "ops", "hoto", "backlog", "history"),
            "can_view_dashboard": True,
            "can_view_ops": True,
            "can_view_machines": True,
            "can_view_history": True,
            "can_view_jobs": True,
            "can_view_tickets": True,
            "can_review_ticket": True,
            "can_create_ticket": True,
            "can_resolve_ticket": True,
            "can_assign_ticket": True,
            "can_handover": True,
            "can_view_hoto_backlog": True,
            "can_report": True,
            "can_ops_actions": False,
            "fleet_view": True,
            "default_ticket_category": "Other",
        }
    if r == "supervisor":
        return {
            "role": r,
            "home": "ops",
            "nav": ("ops", "tickets", "hoto", "history"),
            "can_view_dashboard": False,
            "can_view_ops": True,
            "can_view_machines": False,
            "can_view_history": True,
            "can_view_jobs": True,
            "can_view_tickets": True,
            "can_review_ticket": True,
            "can_create_ticket": True,
            "can_resolve_ticket": True,
            "can_assign_ticket": True,
            "can_handover": True,
            "can_report": True,
            "can_ops_actions": True,
            "fleet_view": True,
            "default_ticket_category": "Other",
        }
    if r == "quality":
        return {
            "role": r,
            "home": "jobs",
            "nav": ("jobs", "tickets"),
            "can_view_dashboard": False,
            "can_view_ops": False,
            "can_view_machines": False,
            "can_view_history": False,
            "can_view_jobs": True,
            "can_view_tickets": True,
            "can_review_ticket": False,
            "can_create_ticket": True,
            "can_resolve_ticket": False,
            "can_assign_ticket": False,
            "can_handover": False,
            "can_report": False,
            "can_ops_actions": False,
            "fleet_view": True,
            "default_ticket_category": "Quality",
        }
    return {
        "role": "operator",
        "home": "jobs",
        "nav": ("jobs", "tickets"),
        "can_view_dashboard": False,
        "can_view_ops": False,
        "can_view_machines": False,
        "can_view_history": False,
        "can_view_jobs": True,
        "can_view_tickets": True,
        "can_review_ticket": False,
        "can_create_ticket": True,
        "can_resolve_ticket": False,
        "can_assign_ticket": False,
        "can_handover": False,
        "can_report": False,
        "can_ops_actions": False,
        "fleet_view": False,
        "default_ticket_category": "Other",
    }


_NAV_META = {
    "dashboard": {"label": "Dashboard", "suffix": "/dashboard"},
    "ops": {"label": "Queue", "suffix": "/ops"},
    "tickets": {"label": "Tickets", "suffix": "/tickets"},
    "jobs": {"label": "Jobs", "suffix": "/jobs"},
    "history": {"label": "History", "suffix": "/history"},
    "hoto": {"label": "HOTO", "suffix": "/hoto"},
    "backlog": {"label": "Backlog", "suffix": "/backlog"},
    "machines": {"label": "Floor", "suffix": "/machines"},
}


def nav_items(role: Any, app_path: str) -> list[dict[str, str]]:
    base = (app_path or "").rstrip("/") or "/Shift-management"
    caps = capabilities(role)
    items = []
    for key in caps["nav"]:
        meta = _NAV_META.get(key)
        if not meta:
            continue
        items.append(
            {
                "page": key,
                "label": meta["label"],
                "href": base + meta["suffix"],
            }
        )
    return items


def home_path(role: Any, app_path: str) -> str:
    base = (app_path or "").rstrip("/") or "/Shift-management"
    home = capabilities(role)["home"]
    meta = _NAV_META.get(home) or _NAV_META["jobs"]
    return base + meta["suffix"]


def has_cap(user_or_role: Any, flag: str) -> bool:
    return bool(capabilities(user_or_role).get(flag))
