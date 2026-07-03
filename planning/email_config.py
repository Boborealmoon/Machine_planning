"""Email notification configuration loaded from planner DB settings."""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass

from .email_settings_store import get_email_settings_row

_config_cache: "EmailConfig | None" = None
_config_lock = threading.Lock()


def _split_addresses(raw: str) -> list[str]:
    parts: list[str] = []
    for item in (raw or "").replace(";", ",").split(","):
        addr = item.strip()
        if addr and addr not in parts:
            parts.append(addr)
    return parts


@dataclass(frozen=True)
class SmtpConfig:
    enabled: bool
    host: str
    port: int
    user: str
    password: str
    from_address: str
    use_tls: bool
    timeout_sec: int


@dataclass(frozen=True)
class EmailTriggerConfig:
    enabled: bool
    recipients: tuple[str, ...]
    cc: tuple[str, ...]
    bcc: tuple[str, ...]
    subject_template: str
    lookback_days: int
    ps_enabled: bool
    ps_heading: str
    ps_line_template: str


@dataclass(frozen=True)
class EmailConfig:
    smtp: SmtpConfig
    new_sales_order: EmailTriggerConfig
    api_secret: str


def invalidate_email_config_cache() -> None:
    global _config_cache
    with _config_lock:
        _config_cache = None


def _build_config(row: dict) -> EmailConfig:
    smtp = SmtpConfig(
        enabled=bool(row.get("smtp_enabled")),
        host=str(row.get("smtp_host") or "").strip(),
        port=int(row.get("smtp_port") or 587),
        user=str(row.get("smtp_user") or "").strip(),
        password=str(row.get("smtp_password") or ""),
        from_address=str(row.get("smtp_from") or row.get("smtp_user") or "").strip(),
        use_tls=bool(row.get("smtp_use_tls", True)),
        timeout_sec=max(5, int(row.get("smtp_timeout_sec") or 30)),
    )
    new_so = EmailTriggerConfig(
        enabled=bool(row.get("new_so_enabled")),
        recipients=tuple(_split_addresses(str(row.get("new_so_recipients") or ""))),
        cc=tuple(_split_addresses(str(row.get("new_so_cc") or ""))),
        bcc=tuple(_split_addresses(str(row.get("new_so_bcc") or ""))),
        subject_template=(
            str(row.get("new_so_subject") or "").strip()
            or "[Planner] New Sales Order: {sales_order_no}"
        ),
        lookback_days=max(1, int(row.get("new_so_lookback_days") or 7)),
        ps_enabled=bool(row.get("new_so_ps_enabled", True)),
        ps_heading=str(row.get("new_so_ps_heading") or "").strip() or "Process sheets:",
        ps_line_template=(
            str(row.get("new_so_ps_line_template") or "").strip()
            or "  - {process_sheet_no} | {part_no} | line {line_item_no} | qty {qty}"
        ),
    )
    return EmailConfig(
        smtp=smtp,
        new_sales_order=new_so,
        api_secret=(os.getenv("ERP_CACHE_REFRESH_SECRET") or "").strip(),
    )


def load_email_config(*, force_reload: bool = False) -> EmailConfig:
    global _config_cache
    with _config_lock:
        if _config_cache is None or force_reload:
            _config_cache = _build_config(get_email_settings_row())
        return _config_cache


def smtp_ready(cfg: EmailConfig) -> bool:
    smtp = cfg.smtp
    return bool(smtp.enabled and smtp.host and smtp.from_address)


def trigger_ready(cfg: EmailConfig, trigger: EmailTriggerConfig) -> bool:
    return bool(smtp_ready(cfg) and trigger.enabled and trigger.recipients)


def public_config_dict(cfg: EmailConfig, *, row: dict | None = None) -> dict:
    row = row or get_email_settings_row()
    smtp = cfg.smtp
    new_so = cfg.new_sales_order
    return {
        "smtp": {
            "enabled": smtp.enabled,
            "host": smtp.host,
            "port": smtp.port,
            "user": smtp.user,
            "from_address": smtp.from_address,
            "use_tls": smtp.use_tls,
            "timeout_sec": smtp.timeout_sec,
            "password_set": bool(str(row.get("smtp_password") or "").strip()),
            "configured": smtp_ready(cfg),
        },
        "triggers": {
            "new_sales_order": {
                "enabled": new_so.enabled,
                "recipients": list(new_so.recipients),
                "recipients_text": str(row.get("new_so_recipients") or ""),
                "cc": list(new_so.cc),
                "cc_text": str(row.get("new_so_cc") or ""),
                "bcc": list(new_so.bcc),
                "bcc_text": str(row.get("new_so_bcc") or ""),
                "subject_template": new_so.subject_template,
                "lookback_days": new_so.lookback_days,
                "ps_enabled": new_so.ps_enabled,
                "ps_heading": new_so.ps_heading,
                "ps_line_template": new_so.ps_line_template,
                "configured": trigger_ready(cfg, new_so),
            },
        },
        "updated_at": row.get("updated_at"),
        "api_secret_required": bool(cfg.api_secret),
    }
