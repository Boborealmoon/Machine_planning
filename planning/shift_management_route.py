"""Shift Management app - pages and JSON APIs at /Shift-management."""
from __future__ import annotations

import logging
import os
from datetime import date

from flask import Blueprint, jsonify, redirect, render_template, request, send_file

from .helpers import planner_db
from .shift_management_auth import (
    SHIFT_MGMT_LOGIN_PATH,
    current_shift_mgmt_user,
)
from .shift_management_report import build_shift_report_pdf
from .shift_management_roles import capabilities, has_cap, home_path, nav_items
from .finishing_queue_route import FINISHING_QUEUE_PATH
from .shift_management_service import (
    acknowledge_handover,
    add_handover_comment,
    add_ticket_comment,
    create_ticket,
    dashboard_payload,
    dispute_handover,
    ensure_shift_mgmt_schema,
    floor_layout_payload,
    get_handover,
    get_or_create_draft,
    get_ticket,
    history_payload,
    list_machines_for_user,
    list_pending_ack,
    list_tickets,
    meta_constants,
    normalize_shift,
    ops_queue_payload,
    patch_handover,
    patch_ticket,
    pending_ack_count,
    report_payload,
    save_hoto_checklist,
    submit_handover,
    submit_hoto_checklist,
    reopen_hoto_checklist,
    list_hoto_submissions,
    get_hoto_submission,
    HotoSubmitError,
    HOTO_ATTENDANCE_ROWS,
    HOTO_CHECKLIST_ITEMS,
    get_hoto_checklist,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

_DEFAULT_SHIFT_MGMT_PATH = "/Shift-management"


def _shift_mgmt_path() -> str:
    raw = (os.getenv("SHIFT_MGMT_PATH") or _DEFAULT_SHIFT_MGMT_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    return raw.rstrip("/") or _DEFAULT_SHIFT_MGMT_PATH


SHIFT_MGMT_PATH = _shift_mgmt_path()

shift_mgmt_bp = Blueprint("shift_mgmt", __name__)


def _parse_date(raw: str | None) -> date:
    text = compact_text(raw)
    if not text:
        return date.today()
    return date.fromisoformat(text[:10])


def _require_user():
    user = current_shift_mgmt_user()
    if not user:
        return None
    return user


def _require_cap(flag: str):
    user = _require_user()
    if not user:
        return None, jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    if not has_cap(user, flag):
        return None, jsonify({"error": "not allowed"}), 403
    return user, None, None


def _page_ctx(**extra):
    user = current_shift_mgmt_user() or {}
    caps = capabilities(user)
    return {
        "app_path": SHIFT_MGMT_PATH,
        "user_display": compact_text(user.get("display_name"))
        or compact_text(user.get("username"))
        or "",
        "user_role": compact_text(user.get("role")) or "operator",
        "user_caps": caps,
        "nav_items": nav_items(user, SHIFT_MGMT_PATH),
        "default_shift": normalize_shift(
            user.get("default_shift") or meta_constants()["guess_shift"]
        ),
        **extra,
    }


def _page_or_home(flag: str, template: str, **extra):
    user = current_shift_mgmt_user()
    if not user:
        return redirect(SHIFT_MGMT_LOGIN_PATH)
    if not has_cap(user, flag):
        return redirect(home_path(user, SHIFT_MGMT_PATH))
    return render_template(template, **_page_ctx(**extra))


def _page_if_in_nav(page_key: str, flag: str, template: str):
    """Hide pages that are not on this role's tab bar."""
    user = current_shift_mgmt_user()
    if not user:
        return redirect(SHIFT_MGMT_LOGIN_PATH)
    if page_key not in capabilities(user)["nav"]:
        return redirect(home_path(user, SHIFT_MGMT_PATH))
    return _page_or_home(flag, template, page=page_key)


def _hoto_checklist_items():
    items = []
    for item in HOTO_CHECKLIST_ITEMS:
        row = dict(item)
        if row.get("see") == "QAQC view":
            row["see_href"] = FINISHING_QUEUE_PATH
        items.append(row)
    return items


# -- Pages ------------------------------------------------------------------


@shift_mgmt_bp.get(SHIFT_MGMT_PATH)
def shift_mgmt_home():
    user = current_shift_mgmt_user()
    if not user:
        return redirect(SHIFT_MGMT_LOGIN_PATH)
    return redirect(home_path(user, SHIFT_MGMT_PATH))


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/ops")
def shift_mgmt_ops():
    return _page_or_home("can_view_ops", "shift_management_ops.html", page="ops")


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/jobs")
def shift_mgmt_jobs():
    return _page_if_in_nav("jobs", "can_view_jobs", "shift_management_jobs.html")


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/tickets")
def shift_mgmt_tickets():
    return _page_if_in_nav("tickets", "can_view_tickets", "shift_management_tickets.html")


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/machines")
def shift_mgmt_machines():
    return _page_or_home("can_view_machines", "shift_management_home.html", page="home")


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/entry/<int:machine_id>")
def shift_mgmt_entry(machine_id: int):
    return _page_or_home(
        "can_handover",
        "shift_management_entry.html",
        page="entry",
        machine_id=machine_id,
    )


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/ack/<int:handover_id>")
def shift_mgmt_ack(handover_id: int):
    return _page_or_home(
        "can_handover",
        "shift_management_ack.html",
        page="ack",
        handover_id=handover_id,
    )


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/dashboard")
def shift_mgmt_dashboard():
    return _page_or_home("can_view_dashboard", "shift_management_dashboard.html", page="dashboard")


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/history")
def shift_mgmt_history():
    return _page_or_home("can_view_history", "shift_management_history.html", page="history")


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/backlog")
def shift_mgmt_hoto_backlog():
    return _page_if_in_nav(
        "backlog",
        "can_view_hoto_backlog",
        "shift_management_hoto_backlog.html",
    )


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/hoto")
def shift_mgmt_hoto():
    return _page_or_home(
        "can_handover",
        "shift_management_hoto.html",
        page="hoto",
        hoto_items=_hoto_checklist_items(),
        hoto_attendance_rows=range(1, HOTO_ATTENDANCE_ROWS + 1),
    )


if SHIFT_MGMT_PATH != _DEFAULT_SHIFT_MGMT_PATH:

    @shift_mgmt_bp.get(_DEFAULT_SHIFT_MGMT_PATH)
    def shift_mgmt_home_alias():
        return redirect(SHIFT_MGMT_PATH)


# -- APIs -------------------------------------------------------------------


@shift_mgmt_bp.get("/api/shift-management/meta")
def api_meta():
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    payload = meta_constants()
    payload["caps"] = capabilities(user)
    payload["home"] = home_path(user, SHIFT_MGMT_PATH)
    return jsonify(payload)


@shift_mgmt_bp.get("/api/shift-management/machines")
def api_machines():
    user, err, status = _require_cap("can_view_machines")
    if err:
        return err, status
    work_date = _parse_date(request.args.get("date"))
    shift_out = normalize_shift(
        request.args.get("shift") or user.get("default_shift") or meta_constants()["guess_shift"]
    )
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            machines = list_machines_for_user(con, user, work_date, shift_out)
            pending = list_pending_ack(con, work_date)
            count = pending_ack_count(con, work_date)
    except Exception as exc:
        logger.exception("shift mgmt machines failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify(
        {
            "work_date": work_date.isoformat(),
            "shift_out": shift_out,
            "machines": machines,
            "floor_layout": floor_layout_payload(),
            "pending_ack": pending,
            "pending_ack_count": count,
            "meta": meta_constants(),
        }
    )


@shift_mgmt_bp.get("/api/shift-management/ops-queue")
def api_ops_queue():
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    if not (has_cap(user, "can_view_ops") or has_cap(user, "can_view_jobs")):
        return jsonify({"error": "not allowed"}), 403
    work_date = _parse_date(request.args.get("date"))
    shift_out = normalize_shift(
        request.args.get("shift") or user.get("default_shift") or meta_constants()["guess_shift"]
    )
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            payload = ops_queue_payload(con, user, work_date=work_date, shift_out=shift_out)
    except Exception as exc:
        logger.exception("ops queue failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify(payload)


@shift_mgmt_bp.post("/api/shift-management/handovers")
def api_create_or_get_handover():
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    work_date = _parse_date(data.get("work_date") or data.get("date"))
    shift_out = normalize_shift(data.get("shift_out") or data.get("shift") or "Day")
    try:
        machine_id = int(data.get("machine_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "machine_id required"}), 400
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ho = get_or_create_draft(
                con,
                work_date=work_date,
                shift_out=shift_out,
                machine_id=machine_id,
                user=user,
                job_no_pref=compact_text(data.get("job_no") or data.get("process_sheet_no")),
            )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("get_or_create draft failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"handover": ho})


@shift_mgmt_bp.get("/api/shift-management/handovers/<int:handover_id>")
def api_get_handover(handover_id: int):
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ho = get_handover(con, handover_id, enrich=True)
    except Exception as exc:
        logger.exception("get handover failed")
        return jsonify({"error": str(exc)}), 500
    if not ho:
        return jsonify({"error": "not found"}), 404
    return jsonify({"handover": ho, "meta": meta_constants()})


@shift_mgmt_bp.patch("/api/shift-management/handovers/<int:handover_id>")
def api_patch_handover(handover_id: int):
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ho = patch_handover(con, handover_id, data, user)
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("patch handover failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"handover": ho, "saved": True})


@shift_mgmt_bp.post("/api/shift-management/handovers/<int:handover_id>/comments")
def api_add_handover_comment(handover_id: int):
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            comment = add_handover_comment(con, handover_id, user, data.get("body") or "")
            comments = get_handover(con, handover_id, enrich=True)
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("handover comment failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"comment": comment, "comments": (comments or {}).get("comments") or []})


@shift_mgmt_bp.post("/api/shift-management/handovers/<int:handover_id>/submit")
def api_submit_handover(handover_id: int):
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ho = submit_handover(con, handover_id, user)
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("submit handover failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"handover": ho})


@shift_mgmt_bp.post("/api/shift-management/handovers/<int:handover_id>/acknowledge")
def api_ack_handover(handover_id: int):
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ho = acknowledge_handover(con, handover_id, user, shift_in=data.get("shift_in"))
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("ack handover failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"handover": ho})


@shift_mgmt_bp.post("/api/shift-management/handovers/<int:handover_id>/dispute")
def api_dispute_handover(handover_id: int):
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ho = dispute_handover(con, handover_id, user, note=data.get("note") or "")
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("dispute handover failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"handover": ho})


@shift_mgmt_bp.get("/api/shift-management/tickets")
def api_list_tickets():
    user, err, status = _require_cap("can_view_tickets")
    if err:
        return err, status
    machine_id = request.args.get("machine_id")
    try:
        mid = int(machine_id) if machine_id else None
    except ValueError:
        mid = None
    work_date = request.args.get("date") or request.args.get("work_date")
    created_by = None
    if not has_cap(user, "can_review_ticket"):
        created_by = int(user["user_id"])
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            items = list_tickets(
                con,
                machine_id=mid,
                status=compact_text(request.args.get("status")) or None,
                planner_ps_id=compact_text(request.args.get("ps") or request.args.get("planner_ps_id"))
                or None,
                work_date=_parse_date(work_date) if work_date else None,
                shift_out=compact_text(request.args.get("shift")) or None,
                created_by=created_by,
            )
    except Exception as exc:
        logger.exception("list tickets failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"items": items, "meta": meta_constants()})


@shift_mgmt_bp.post("/api/shift-management/tickets")
def api_create_ticket():
    user, err, status = _require_cap("can_create_ticket")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ticket = create_ticket(con, user, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("create ticket failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"ticket": ticket}), 201


@shift_mgmt_bp.get("/api/shift-management/tickets/<int:ticket_id>")
def api_get_ticket(ticket_id: int):
    user, err, status = _require_cap("can_view_tickets")
    if err:
        return err, status
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ticket = get_ticket(con, ticket_id)
    except Exception as exc:
        logger.exception("get ticket failed")
        return jsonify({"error": str(exc)}), 500
    if not ticket:
        return jsonify({"error": "not found"}), 404
    if not has_cap(user, "can_review_ticket") and int(ticket.get("created_by") or 0) != int(
        user["user_id"]
    ):
        return jsonify({"error": "not found"}), 404
    return jsonify({"ticket": ticket})


@shift_mgmt_bp.patch("/api/shift-management/tickets/<int:ticket_id>")
def api_patch_ticket(ticket_id: int):
    user, err, status = _require_cap("can_view_tickets")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    if "status" in data and not has_cap(user, "can_resolve_ticket"):
        return jsonify({"error": "not allowed to resolve tickets"}), 403
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ticket = patch_ticket(con, ticket_id, user, data)
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("patch ticket failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"ticket": ticket})


@shift_mgmt_bp.post("/api/shift-management/tickets/<int:ticket_id>/comments")
def api_add_ticket_comment(ticket_id: int):
    user, err, status = _require_cap("can_view_tickets")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            comment = add_ticket_comment(con, ticket_id, user, data.get("body") or "")
            ticket = get_ticket(con, ticket_id)
    except LookupError:
        return jsonify({"error": "not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("ticket comment failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"comment": comment, "ticket": ticket})


@shift_mgmt_bp.get("/api/shift-management/dashboard")
def api_dashboard():
    user, err, status = _require_cap("can_view_dashboard")
    if err:
        return err, status
    work_date = _parse_date(request.args.get("date"))
    shift = compact_text(request.args.get("shift")) or None
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            payload = dashboard_payload(con, work_date, shift_out=shift)
    except Exception as exc:
        logger.exception("dashboard failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify(payload)


@shift_mgmt_bp.get("/api/shift-management/history")
def api_history():
    user, err, status = _require_cap("can_view_history")
    if err:
        return err, status
    machine_id = request.args.get("machine_id")
    try:
        mid = int(machine_id) if machine_id else None
    except ValueError:
        mid = None
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            items = history_payload(
                con,
                date_from=_parse_date(request.args.get("from")) if request.args.get("from") else None,
                date_to=_parse_date(request.args.get("to")) if request.args.get("to") else None,
                machine_id=mid,
                shift_out=compact_text(request.args.get("shift")) or None,
                status=compact_text(request.args.get("status")) or None,
                priority=compact_text(request.args.get("priority")) or None,
                ncr_status=compact_text(request.args.get("ncr_status")) or None,
            )
    except Exception as exc:
        logger.exception("history failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"items": items})


@shift_mgmt_bp.get("/api/shift-management/hoto")
def api_get_hoto():
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    work_date = _parse_date(request.args.get("date"))
    shift_out = normalize_shift(request.args.get("shift") or meta_constants()["guess_shift"])
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            checklist = get_hoto_checklist(con, work_date, shift_out)
    except Exception as exc:
        logger.exception("hoto checklist load failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"checklist": checklist})


@shift_mgmt_bp.put("/api/shift-management/hoto")
def api_save_hoto():
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    work_date = _parse_date(data.get("work_date") or data.get("date"))
    shift_out = normalize_shift(data.get("shift_out") or data.get("shift") or "Day")
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            checklist = save_hoto_checklist(
                con,
                work_date=work_date,
                shift_out=shift_out,
                data=data,
                user=user,
            )
    except Exception as exc:
        logger.exception("hoto checklist save failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"checklist": checklist, "saved": True})


@shift_mgmt_bp.post("/api/shift-management/hoto/submit")
def api_submit_hoto():
    user, err, status = _require_cap("can_handover")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    work_date = _parse_date(data.get("work_date") or data.get("date"))
    shift_out = normalize_shift(data.get("shift_out") or data.get("shift") or "Day")
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            checklist = submit_hoto_checklist(
                con,
                work_date=work_date,
                shift_out=shift_out,
                data=data,
                user=user,
            )
    except HotoSubmitError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("hoto checklist submit failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"checklist": checklist, "submitted": True})


@shift_mgmt_bp.post("/api/shift-management/hoto/reopen")
def api_reopen_hoto():
    user, err, status = _require_cap("can_view_hoto_backlog")
    if err:
        return err, status
    data = request.get_json(silent=True) or {}
    work_date = _parse_date(data.get("work_date") or data.get("date"))
    shift_out = normalize_shift(data.get("shift_out") or data.get("shift") or "Day")
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            checklist = reopen_hoto_checklist(con, work_date, shift_out)
    except Exception as exc:
        logger.exception("hoto checklist reopen failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"checklist": checklist})


@shift_mgmt_bp.get("/api/shift-management/hoto/backlog")
def api_hoto_backlog():
    user, err, status = _require_cap("can_view_hoto_backlog")
    if err:
        return err, status
    shift = compact_text(request.args.get("shift"))
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            items = list_hoto_submissions(
                con,
                date_from=_parse_date(request.args.get("from")) if request.args.get("from") else None,
                date_to=_parse_date(request.args.get("to")) if request.args.get("to") else None,
                shift_out=shift or None,
            )
    except Exception as exc:
        logger.exception("hoto backlog failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"items": items})


@shift_mgmt_bp.get("/api/shift-management/hoto/submissions/<int:submission_id>")
def api_hoto_submission(submission_id: int):
    user, err, status = _require_cap("can_view_hoto_backlog")
    if err:
        return err, status
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            checklist = get_hoto_submission(con, submission_id)
    except Exception as exc:
        logger.exception("hoto submission load failed")
        return jsonify({"error": str(exc)}), 500
    if not checklist:
        return jsonify({"error": "Handover document not found"}), 404
    return jsonify({"checklist": checklist})


@shift_mgmt_bp.get("/api/shift-management/report.pdf")
def api_report_pdf():
    user, err, status = _require_cap("can_report")
    if err:
        return err, status
    work_date = _parse_date(request.args.get("date"))
    shift_out = normalize_shift(request.args.get("shift") or meta_constants()["guess_shift"])
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            payload = report_payload(con, work_date, shift_out)
        pdf_bytes = build_shift_report_pdf(payload)
    except Exception as exc:
        logger.exception("report pdf failed")
        return jsonify({"error": str(exc)}), 500
    from io import BytesIO

    filename = f"EOS_Report_{work_date.isoformat()}_{shift_out}.pdf"
    return send_file(
        BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=filename,
    )
