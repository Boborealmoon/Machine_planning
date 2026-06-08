"""Daily planner email settings page and API."""

from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from .planner_email_service import (
    get_email_settings,
    list_send_log,
    parse_recipient_emails,
    send_planner_email,
    smtp_configured,
    update_email_settings,
)

planner_email_bp = Blueprint("planner_email", __name__)


@planner_email_bp.get("/planner-email")
def planner_email_page():
    return render_template("planner_email.html", active="planner_email")


@planner_email_bp.get("/api/planner-email/settings")
def api_planner_email_settings_get():
    return jsonify(get_email_settings())


@planner_email_bp.put("/api/planner-email/settings")
@planner_email_bp.post("/api/planner-email/settings")
def api_planner_email_settings_save():
    payload = request.get_json(silent=True) or {}
    try:
        settings = update_email_settings(payload)
        return jsonify(settings)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@planner_email_bp.get("/api/planner-email/log")
def api_planner_email_log():
    limit = request.args.get("limit", 20)
    return jsonify({"items": list_send_log(limit=limit)})


@planner_email_bp.post("/api/planner-email/send-now")
def api_planner_email_send_now():
    try:
        result = send_planner_email(force=True)
        return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@planner_email_bp.post("/api/planner-email/send-test")
def api_planner_email_send_test():
    payload = request.get_json(silent=True) or {}
    test_to = parse_recipient_emails(payload.get("test_recipient") or payload.get("recipient"))
    if not test_to:
        return jsonify({"error": "Enter a test recipient email address"}), 400
    if not smtp_configured():
        return jsonify({"error": "SMTP is not configured. Set SMTP_HOST and SMTP_FROM in .env"}), 400
    try:
        result = send_planner_email(test_recipients=test_to)
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
