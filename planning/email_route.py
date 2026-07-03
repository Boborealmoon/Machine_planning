"""Email settings UI and API."""
from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from .email_config import (
    invalidate_email_config_cache,
    load_email_config,
    load_email_config_with_overrides,
    public_config_dict,
)
from .email_settings_store import save_email_settings_row
from .emailer import send_test_email
from .new_so_email import notify_new_sales_orders

email_bp = Blueprint("email", __name__)

def _planner_authenticated() -> bool:
    from app import _planner_authenticated as is_authenticated

    return is_authenticated()


def _authorized() -> bool:
    if _planner_authenticated():
        return True
    cfg = load_email_config()
    if not cfg.api_secret:
        return True
    provided = (
        request.headers.get("X-Email-Secret")
        or request.headers.get("X-ERP-Cache-Secret")
        or request.args.get("secret")
        or (request.get_json(silent=True) or {}).get("secret")
        or ""
    ).strip()
    return provided == cfg.api_secret


def _auth_error():
    return jsonify({"error": "Unauthorized"}), 401


def _parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


@email_bp.get("/system")
def system_page():
    return render_template("system.html", active="system")


@email_bp.get("/api/email/config")
def api_email_config_get():
    row = None
    try:
        from .email_settings_store import get_email_settings_row

        row = get_email_settings_row()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    cfg = load_email_config(force_reload=True)
    return jsonify(public_config_dict(cfg, row=row))


def _settings_payload_from_body(body: dict) -> dict:
    smtp = body.get("smtp") if isinstance(body.get("smtp"), dict) else body
    trigger = body.get("triggers", {}).get("new_sales_order")
    if not isinstance(trigger, dict):
        trigger = body.get("new_sales_order") if isinstance(body.get("new_sales_order"), dict) else body

    payload: dict = {}
    if smtp:
        if "enabled" in smtp:
            payload["smtp_enabled"] = _parse_bool(smtp.get("enabled"))
        for src, dst in (
            ("host", "smtp_host"),
            ("port", "smtp_port"),
            ("user", "smtp_user"),
            ("from_address", "smtp_from"),
            ("from", "smtp_from"),
            ("use_tls", "smtp_use_tls"),
            ("timeout_sec", "smtp_timeout_sec"),
        ):
            if src in smtp:
                payload[dst] = smtp[src]
        if "password" in smtp:
            payload["smtp_password"] = smtp.get("password")

    if trigger:
        if "enabled" in trigger:
            payload["new_so_enabled"] = _parse_bool(trigger.get("enabled"))
        if "recipients_text" in trigger:
            payload["new_so_recipients"] = trigger.get("recipients_text")
        elif "recipients" in trigger:
            recipients = trigger.get("recipients")
            if isinstance(recipients, list):
                payload["new_so_recipients"] = ", ".join(str(x).strip() for x in recipients if str(x).strip())
            else:
                payload["new_so_recipients"] = str(recipients or "")
        if "cc_text" in trigger:
            payload["new_so_cc"] = trigger.get("cc_text")
        elif "cc" in trigger:
            cc = trigger.get("cc")
            payload["new_so_cc"] = ", ".join(cc) if isinstance(cc, list) else str(cc or "")
        if "bcc_text" in trigger:
            payload["new_so_bcc"] = trigger.get("bcc_text")
        elif "bcc" in trigger:
            bcc = trigger.get("bcc")
            payload["new_so_bcc"] = ", ".join(bcc) if isinstance(bcc, list) else str(bcc or "")
        if "subject_template" in trigger:
            payload["new_so_subject"] = trigger.get("subject_template")
        if "lookback_days" in trigger:
            payload["new_so_lookback_days"] = trigger.get("lookback_days")
        if "ps_enabled" in trigger:
            payload["new_so_ps_enabled"] = _parse_bool(trigger.get("ps_enabled"))
        if "ps_heading" in trigger:
            payload["new_so_ps_heading"] = trigger.get("ps_heading")
        if "ps_line_template" in trigger:
            payload["new_so_ps_line_template"] = trigger.get("ps_line_template")
    return payload


@email_bp.put("/api/email/config")
def api_email_config_put():
    if not _planner_authenticated():
        return _auth_error()
    body = request.get_json(silent=True) or {}
    payload = _settings_payload_from_body(body)

    try:
        row = save_email_settings_row(payload)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    invalidate_email_config_cache()
    cfg = load_email_config(force_reload=True)
    return jsonify({"ok": True, **public_config_dict(cfg, row=row)})


@email_bp.post("/api/email/send-test")
def api_email_send_test():
    if not _authorized():
        return _auth_error()
    body = request.get_json(silent=True) or {}
    payload = _settings_payload_from_body(body) if body.get("smtp") else {}
    if payload:
        save_email_settings_row(payload)
    invalidate_email_config_cache()
    cfg = load_email_config_with_overrides(payload or None, force_reload=True)
    result = send_test_email(cfg=cfg)
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


@email_bp.post("/api/email/notify-new-sales-orders")
def api_email_notify_new_sales_orders():
    if not _authorized():
        return _auth_error()
    body = request.get_json(silent=True) or {}
    dry_run = _parse_bool(body.get("dry_run", request.args.get("dry_run", "0")))
    invalidate_email_config_cache()
    result = notify_new_sales_orders(dry_run=dry_run)
    status = 200 if result.get("ok") or result.get("skipped") or dry_run else 500
    if result.get("skipped") and result.get("issues"):
        status = 400
    return jsonify(result), status
