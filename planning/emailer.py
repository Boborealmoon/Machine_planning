"""Send email via configured SMTP."""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Iterable

from .email_config import EmailConfig, load_email_config, smtp_config_issues, smtp_ready

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
    cfg = cfg or load_email_config(force_reload=True)
    if not smtp_ready(cfg):
        issues = smtp_config_issues(cfg)
        detail = "; ".join(issues) if issues else "SMTP is not configured"
        return {"ok": False, "error": f"SMTP is not ready — {detail}", "issues": issues}

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
