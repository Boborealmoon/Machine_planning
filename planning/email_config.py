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


def smtp_config_issues(cfg: EmailConfig) -> list[str]:
    issues: list[str] = []
    smtp = cfg.smtp
    if not smtp.enabled:
        issues.append("SMTP is disabled")
    if not smtp.host:
        issues.append("Set SMTP host")
    if not smtp.from_address:
        issues.append("Set From address")
    return issues


def new_so_config_issues(cfg: EmailConfig) -> list[str]:
    issues: list[str] = []
    trigger = cfg.new_sales_order
    if not trigger.enabled:
        issues.append("Enable New sales order alert")
    if not trigger.recipients:
        issues.append("Add at least one To recipient")
    issues.extend(smtp_config_issues(cfg))
    return issues


def trigger_ready(cfg: EmailConfig, trigger: EmailTriggerConfig) -> bool:
    return bool(trigger.enabled and trigger.recipients and smtp_ready(cfg))
