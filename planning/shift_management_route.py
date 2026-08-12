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
    shift_mgmt_user_authenticated,
)
from .shift_management_report import build_shift_report_pdf
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
    submit_handover,
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


def _page_ctx(**extra):
    user = current_shift_mgmt_user() or {}
    return {
        "app_path": SHIFT_MGMT_PATH,
        "user_display": compact_text(user.get("display_name"))
        or compact_text(user.get("username"))
        or "",
        "user_role": compact_text(user.get("role")) or "operator",
        "default_shift": normalize_shift(
            user.get("default_shift") or meta_constants()["guess_shift"]
        ),
        **extra,
    }


# -- Pages ------------------------------------------------------------------


@shift_mgmt_bp.get(SHIFT_MGMT_PATH)
def shift_mgmt_home():
    return render_template("shift_management_home.html", **_page_ctx(page="home"))


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/ops")
def shift_mgmt_ops():
    return render_template("shift_management_ops.html", **_page_ctx(page="ops"))


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/entry/<int:machine_id>")
def shift_mgmt_entry(machine_id: int):
    return render_template(
        "shift_management_entry.html",
        **_page_ctx(page="entry", machine_id=machine_id),
    )


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/ack/<int:handover_id>")
def shift_mgmt_ack(handover_id: int):
    return render_template(
        "shift_management_ack.html",
        **_page_ctx(page="ack", handover_id=handover_id),
    )


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/dashboard")
def shift_mgmt_dashboard():
    return render_template("shift_management_dashboard.html", **_page_ctx(page="dashboard"))


@shift_mgmt_bp.get(f"{SHIFT_MGMT_PATH}/history")
def shift_mgmt_history():
    return render_template("shift_management_history.html", **_page_ctx(page="history"))


if SHIFT_MGMT_PATH != _DEFAULT_SHIFT_MGMT_PATH:

    @shift_mgmt_bp.get(_DEFAULT_SHIFT_MGMT_PATH)
    def shift_mgmt_home_alias():
        return redirect(SHIFT_MGMT_PATH)


# -- APIs -------------------------------------------------------------------


@shift_mgmt_bp.get("/api/shift-management/meta")
def api_meta():
    if not shift_mgmt_user_authenticated():
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    return jsonify(meta_constants())


@shift_mgmt_bp.get("/api/shift-management/machines")
def api_machines():
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            payload = ops_queue_payload(con, user)
    except Exception as exc:
        logger.exception("ops queue failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify(payload)


@shift_mgmt_bp.post("/api/shift-management/handovers")
def api_create_or_get_handover():
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    if not shift_mgmt_user_authenticated():
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    machine_id = request.args.get("machine_id")
    try:
        mid = int(machine_id) if machine_id else None
    except ValueError:
        mid = None
    work_date = request.args.get("date") or request.args.get("work_date")
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
            )
    except Exception as exc:
        logger.exception("list tickets failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify({"items": items, "meta": meta_constants()})


@shift_mgmt_bp.post("/api/shift-management/tickets")
def api_create_ticket():
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    if not shift_mgmt_user_authenticated():
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    try:
        with planner_db() as con:
            ensure_shift_mgmt_schema(con)
            ticket = get_ticket(con, ticket_id)
    except Exception as exc:
        logger.exception("get ticket failed")
        return jsonify({"error": str(exc)}), 500
    if not ticket:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ticket": ticket})


@shift_mgmt_bp.patch("/api/shift-management/tickets/<int:ticket_id>")
def api_patch_ticket(ticket_id: int):
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
    data = request.get_json(silent=True) or {}
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
    user = _require_user()
    if not user:
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    if not shift_mgmt_user_authenticated():
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
    if not shift_mgmt_user_authenticated():
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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


@shift_mgmt_bp.get("/api/shift-management/report.pdf")
def api_report_pdf():
    if not shift_mgmt_user_authenticated():
        return jsonify({"error": "login required", "login": SHIFT_MGMT_LOGIN_PATH}), 401
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
