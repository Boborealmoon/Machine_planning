"""Daily planner email settings, SMTP delivery, and send logging."""

from __future__ import annotations

import logging
import os
import re
import smtplib
from datetime import date, datetime, time
from email.message import EmailMessage
from typing import Any

from .helpers import one, planner_db, rows
from .planner_board_export import build_planner_board_workbook_bytes
from .utils import compact_text, planner_now_naive, planner_today

logger = logging.getLogger(__name__)

_EMAIL_SPLIT_RE = re.compile(r"[,;\s]+")
_DEFAULT_SUBJECT = "Daily Production Planner — {date}"


def _smtp_config() -> dict[str, Any]:
    use_tls = compact_text(os.getenv("SMTP_USE_TLS", "true")).lower() not in {"0", "false", "no", "off"}
    port_raw = compact_text(os.getenv("SMTP_PORT", "587"))
    try:
        port = int(port_raw or 587)
    except ValueError:
        port = 587
    return {
        "host": compact_text(os.getenv("SMTP_HOST")),
        "port": port,
        "username": compact_text(os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER")),
        "password": compact_text(os.getenv("SMTP_PASSWORD") or os.getenv("SMTP_PASS")),
        "from_email": compact_text(os.getenv("SMTP_FROM") or os.getenv("SMTP_FROM_EMAIL")),
        "use_tls": use_tls,
    }


def smtp_configured() -> bool:
    cfg = _smtp_config()
    return bool(cfg["host"] and cfg["from_email"])


def parse_recipient_emails(raw: str) -> list[str]:
    parts = [part.strip() for part in _EMAIL_SPLIT_RE.split(compact_text(raw)) if part.strip()]
    seen: set[str] = set()
    result: list[str] = []
    for part in parts:
        key = part.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(part)
    return result


def _ensure_settings_row(con):
    row = one(con.execute("SELECT * FROM planner_email_settings ORDER BY settings_id LIMIT 1"))
    if row:
        return dict(row)
    con.execute(
        """
        INSERT INTO planner_email_settings (enabled, recipient_emails, send_time_local, email_subject)
        VALUES (FALSE, '', TIME '07:00', %s)
        RETURNING settings_id
        """,
        (_DEFAULT_SUBJECT,),
    )
    return dict(one(con.execute("SELECT * FROM planner_email_settings ORDER BY settings_id DESC LIMIT 1")))


def get_email_settings() -> dict[str, Any]:
    with planner_db() as con:
        row = _ensure_settings_row(con)
    return serialize_email_settings(row)


def serialize_email_settings(row: dict[str, Any]) -> dict[str, Any]:
    send_time = row.get("send_time_local")
    if isinstance(send_time, time):
        send_time_text = send_time.strftime("%H:%M")
    else:
        send_time_text = compact_text(send_time)[:5] or "07:00"
    return {
        "settings_id": int(row.get("settings_id") or 0),
        "enabled": bool(row.get("enabled")),
        "recipient_emails": compact_text(row.get("recipient_emails")),
        "recipients": parse_recipient_emails(row.get("recipient_emails")),
        "send_time_local": send_time_text,
        "email_subject": compact_text(row.get("email_subject")) or _DEFAULT_SUBJECT,
        "last_sent_at": row.get("last_sent_at").isoformat(sep=" ", timespec="seconds")
        if row.get("last_sent_at")
        else "",
        "last_send_status": compact_text(row.get("last_send_status")),
        "last_send_message": compact_text(row.get("last_send_message")),
        "smtp_configured": smtp_configured(),
        "smtp_host": _smtp_config()["host"],
        "smtp_from_email": _smtp_config()["from_email"],
    }


def _parse_send_time(value: str) -> time:
    text = compact_text(value)
    if not text:
        return time(7, 0)
    if len(text) == 5 and text[2] == ":":
        hour, minute = text.split(":", 1)
        return time(int(hour), int(minute))
    parsed = datetime.strptime(text, "%H:%M:%S")
    return parsed.time()


def update_email_settings(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = bool(payload.get("enabled"))
    recipient_emails = compact_text(payload.get("recipient_emails"))
    send_time_local = _parse_send_time(payload.get("send_time_local"))
    email_subject = compact_text(payload.get("email_subject")) or _DEFAULT_SUBJECT
    with planner_db() as con:
        row = _ensure_settings_row(con)
        settings_id = int(row["settings_id"])
        con.execute(
            """
            UPDATE planner_email_settings
            SET enabled = %s,
                recipient_emails = %s,
                send_time_local = %s,
                email_subject = %s,
                updated_at = NOW()
            WHERE settings_id = %s
            """,
            (enabled, recipient_emails, send_time_local, email_subject, settings_id),
        )
        updated = one(con.execute("SELECT * FROM planner_email_settings WHERE settings_id = %s", (settings_id,)))
    return serialize_email_settings(updated or row)


def _render_subject(template: str, snapshot_date: date) -> str:
    text = compact_text(template) or _DEFAULT_SUBJECT
    return text.replace("{date}", snapshot_date.isoformat())


def _append_send_log(
    con,
    *,
    status: str,
    recipient_emails: str,
    subject: str,
    message: str,
    attachment_name: str,
):
    con.execute(
        """
        INSERT INTO planner_email_send_log (status, recipient_emails, subject, message, attachment_name)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (status, recipient_emails, subject, message, attachment_name),
    )


def _update_last_send(con, settings_id: int, *, status: str, message: str):
    con.execute(
        """
        UPDATE planner_email_settings
        SET last_sent_at = NOW(),
            last_send_status = %s,
            last_send_message = %s,
            updated_at = NOW()
        WHERE settings_id = %s
        """,
        (status, message, settings_id),
    )


def list_send_log(limit: int = 20) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit or 20), 100))
    with planner_db() as con:
        log_rows = rows(
            con.execute(
                """
                SELECT log_id, sent_at, status, recipient_emails, subject, message, attachment_name
                FROM planner_email_send_log
                ORDER BY sent_at DESC
                LIMIT %s
                """,
                (limit,),
            )
        )
    result = []
    for row in log_rows:
        sent_at = row.get("sent_at")
        result.append(
            {
                "log_id": int(row.get("log_id") or 0),
                "sent_at": sent_at.isoformat(sep=" ", timespec="seconds") if sent_at else "",
                "status": compact_text(row.get("status")),
                "recipient_emails": compact_text(row.get("recipient_emails")),
                "subject": compact_text(row.get("subject")),
                "message": compact_text(row.get("message")),
                "attachment_name": compact_text(row.get("attachment_name")),
            }
        )
    return result


def send_planner_email(*, force: bool = False, test_recipients: list[str] | None = None) -> dict[str, Any]:
    settings = get_email_settings()
    recipients = test_recipients or settings["recipients"]
    if not recipients:
        raise ValueError("Add at least one recipient email address")
    if not force and not settings["enabled"] and not test_recipients:
        raise ValueError("Daily planner email is disabled")
    if not smtp_configured():
        raise ValueError("SMTP is not configured. Set SMTP_HOST and SMTP_FROM in .env")

    snapshot_date = planner_today()
    attachment_bytes, attachment_name = build_planner_board_workbook_bytes(snapshot_date=snapshot_date)
    subject = _render_subject(settings["email_subject"], snapshot_date)
    body = (
        "Attached is the daily production planner machine board snapshot.\n\n"
        f"Snapshot date: {snapshot_date.isoformat()}\n"
        "All schedule times are Singapore (SGT, UTC+8).\n"
    )

    cfg = _smtp_config()
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = cfg["from_email"]
    message["To"] = ", ".join(recipients)
    message.set_content(body)
    message.add_attachment(
        attachment_bytes,
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=attachment_name,
    )

    try:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=60) as smtp:
            if cfg["use_tls"]:
                smtp.starttls()
            if cfg["username"]:
                smtp.login(cfg["username"], cfg["password"])
            smtp.send_message(message)
        status = "SUCCESS"
        result_message = f"Sent to {len(recipients)} recipient(s)"
    except Exception as exc:
        logger.exception("Daily planner email failed")
        status = "FAILED"
        result_message = str(exc)
        with planner_db() as con:
            row = _ensure_settings_row(con)
            settings_id = int(row["settings_id"])
            _append_send_log(
                con,
                status=status,
                recipient_emails=", ".join(recipients),
                subject=subject,
                message=result_message,
                attachment_name=attachment_name,
            )
            if not test_recipients:
                _update_last_send(con, settings_id, status=status, message=result_message)
        raise

    with planner_db() as con:
        row = _ensure_settings_row(con)
        settings_id = int(row["settings_id"])
        _append_send_log(
            con,
            status=status,
            recipient_emails=", ".join(recipients),
            subject=subject,
            message=result_message,
            attachment_name=attachment_name,
        )
        if not test_recipients:
            _update_last_send(con, settings_id, status=status, message=result_message)

    return {
        "status": status,
        "message": result_message,
        "recipients": recipients,
        "subject": subject,
        "attachment_name": attachment_name,
    }


def should_send_scheduled_now(now: datetime | None = None) -> bool:
    settings = get_email_settings()
    if not settings["enabled"] or not settings["recipients"] or not smtp_configured():
        return False
    now = now or planner_now_naive()
    target = _parse_send_time(settings["send_time_local"])
    if now.time().hour != target.hour or now.time().minute != target.minute:
        return False
    last_sent_at = compact_text(settings.get("last_sent_at"))
    if last_sent_at:
        try:
            last_sent = datetime.fromisoformat(last_sent_at.replace(" ", "T", 1))
            if last_sent.date() == now.date():
                return False
        except ValueError:
            pass
    return True
