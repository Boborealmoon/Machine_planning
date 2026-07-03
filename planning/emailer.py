"""Send email via configured SMTP."""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Iterable

from .email_config import EmailConfig, load_email_config, smtp_ready

logger = logging.getLogger(__name__)


def _normalize_addresses(addresses: Iterable[str]) -> list[str]:
    out: list[str] = []
    for addr in addresses:
        text = (addr or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def render_template(template: str, **fields: object) -> str:
    from string import Formatter

    class _SafeDict(dict):
        def __missing__(self, key: str) -> str:
            return ""

    mapping = _SafeDict({key: "" if value is None else str(value) for key, value in fields.items()})
    try:
        return Formatter().vformat(template or "", (), mapping)
    except Exception:
        return template or ""


def send_email(
    *,
    to: Iterable[str],
    subject: str,
    body_text: str,
    body_html: str | None = None,
    cc: Iterable[str] | None = None,
    bcc: Iterable[str] | None = None,
    cfg: EmailConfig | None = None,
) -> dict:
    """Send one email. Returns {ok, message_id?, error?}."""
    cfg = cfg or load_email_config()
    if not smtp_ready(cfg):
        return {"ok": False, "error": "SMTP is not configured (set EMAIL_ENABLED, SMTP_HOST, SMTP_FROM)"}

    recipients = _normalize_addresses(to)
    cc_list = _normalize_addresses(cc or [])
    bcc_list = _normalize_addresses(bcc or [])
    all_recipients = recipients + cc_list + bcc_list
    if not recipients:
        return {"ok": False, "error": "No recipients"}

    msg = EmailMessage()
    msg["Subject"] = subject.strip() or "(no subject)"
    msg["From"] = cfg.smtp.from_address
    msg["To"] = ", ".join(recipients)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg.set_content(body_text or "")
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    smtp = cfg.smtp
    try:
        with smtplib.SMTP(host=smtp.host, port=smtp.port, timeout=smtp.timeout_sec) as client:
            client.ehlo()
            if smtp.use_tls:
                client.starttls()
                client.ehlo()
            if smtp.user:
                client.login(smtp.user, smtp.password)
            refused = client.send_message(msg, from_addr=smtp.from_address, to_addrs=all_recipients)
        if refused:
            return {"ok": False, "error": f"SMTP refused recipients: {refused}"}
        return {"ok": True, "recipients": all_recipients}
    except Exception as exc:
        logger.warning("email send failed: %s", exc, exc_info=True)
        return {"ok": False, "error": str(exc)}


def send_test_email(cfg: EmailConfig | None = None) -> dict:
    cfg = cfg or load_email_config()
    trigger = cfg.new_sales_order
    recipients = list(trigger.recipients) or list(_normalize_addresses(cfg.smtp.from_address))
    sample_ps = [
        {"process_sheet_no": "APS-TEST-001", "part_no": "PART-123", "line_item_no": "1", "qty": 10, "bom_code": "BOM-A", "po_due_date": "2026-07-15", "description": "Sample part"},
        {"process_sheet_no": "APS-TEST-002", "part_no": "PART-456", "line_item_no": "2", "qty": 5, "bom_code": "BOM-B", "po_due_date": "2026-07-20", "description": "Another part"},
    ]
    from .new_so_email import _render_process_sheet_lines

    ps_text, _, ps_numbers = _render_process_sheet_lines(trigger, sample_ps)
    subject = render_template(
        trigger.subject_template,
        sales_order_no="SO/TEST/0001",
        process_sheets=", ".join(ps_numbers),
    )
    body = (
        "This is a test email from Machine Planning.\n\n"
        f"SMTP host: {cfg.smtp.host}\n"
        f"Trigger: new_sales_order\n"
        f"Recipients: {', '.join(recipients)}\n\n"
        f"{ps_text}\n"
    )
    result = send_email(
        to=recipients,
        cc=trigger.cc,
        bcc=trigger.bcc,
        subject=f"[TEST] {subject}",
        body_text=body,
        cfg=cfg,
    )
    return {"test": True, "sample_process_sheets": ps_numbers, **result}
