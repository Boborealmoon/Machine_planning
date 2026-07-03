"""Persist email settings in planner Postgres (singleton row)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .helpers import one, planner_db

logger = logging.getLogger(__name__)

# Minimal table shell — all settings columns are added idempotently below so
# an older/partial planner_email_settings table is repaired automatically.
_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS public.planner_email_settings (
    settings_id INTEGER PRIMARY KEY DEFAULT 1 CHECK (settings_id = 1)
)
"""

_COLUMN_PATCHES: tuple[str, ...] = (
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_enabled BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_host TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_port INTEGER NOT NULL DEFAULT 587",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_user TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_password TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_from TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_use_tls BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS smtp_timeout_sec INTEGER NOT NULL DEFAULT 30",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_enabled BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_recipients TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_cc TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_bcc TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_subject TEXT NOT NULL DEFAULT '[Planner] New Sales Order: {sales_order_no}'",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_lookback_days INTEGER NOT NULL DEFAULT 7",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_ps_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_ps_heading TEXT NOT NULL DEFAULT 'Process sheets:'",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS new_so_ps_line_template TEXT NOT NULL DEFAULT '  - {process_sheet_no} | {part_no} | line {line_item_no} | qty {qty}'",
    "ALTER TABLE public.planner_email_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
)

_DEFAULTS: dict[str, Any] = {
    "settings_id": 1,
    "smtp_enabled": False,
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_password": "",
    "smtp_from": "",
    "smtp_use_tls": True,
    "smtp_timeout_sec": 30,
    "new_so_enabled": False,
    "new_so_recipients": "",
    "new_so_cc": "",
    "new_so_bcc": "",
    "new_so_subject": "[Planner] New Sales Order: {sales_order_no}",
    "new_so_lookback_days": 7,
    "new_so_ps_enabled": True,
    "new_so_ps_heading": "Process sheets:",
    "new_so_ps_line_template": "  - {process_sheet_no} | {part_no} | line {line_item_no} | qty {qty}",
}


def ensure_email_settings_schema(con) -> None:
    """Create/repair planner_email_settings — safe to run on every read/write."""
    con.execute(_CREATE_TABLE_SQL)
    for patch in _COLUMN_PATCHES:
        con.execute(patch)
    con.execute(
        """
        INSERT INTO public.planner_email_settings (settings_id)
        VALUES (1)
        ON CONFLICT (settings_id) DO NOTHING
        """
    )


def _normalize_row(row: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(_DEFAULTS)
    if row:
        out.update({key: row.get(key) for key in _DEFAULTS if key in row})
    out["smtp_port"] = max(1, min(65535, int(out.get("smtp_port") or 587)))
    out["smtp_timeout_sec"] = max(5, min(300, int(out.get("smtp_timeout_sec") or 30)))
    out["new_so_lookback_days"] = max(1, min(90, int(out.get("new_so_lookback_days") or 7)))
    return out


def get_email_settings_row(*, con=None) -> dict[str, Any]:
    if con is not None:
        ensure_email_settings_schema(con)
        row = one(con.execute("SELECT * FROM public.planner_email_settings WHERE settings_id = 1"))
        return _normalize_row(row)

    with planner_db() as db_con:
        ensure_email_settings_schema(db_con)
        row = one(db_con.execute("SELECT * FROM public.planner_email_settings WHERE settings_id = 1"))
        return _normalize_row(row)


def save_email_settings_row(payload: dict[str, Any]) -> dict[str, Any]:
    current = get_email_settings_row()
    merged = dict(current)
    for key in (
        "smtp_enabled",
        "smtp_host",
        "smtp_port",
        "smtp_user",
        "smtp_from",
        "smtp_use_tls",
        "smtp_timeout_sec",
        "new_so_enabled",
        "new_so_recipients",
        "new_so_cc",
        "new_so_bcc",
        "new_so_subject",
        "new_so_lookback_days",
        "new_so_ps_enabled",
        "new_so_ps_heading",
        "new_so_ps_line_template",
    ):
        if key in payload:
            merged[key] = payload[key]

    new_password = payload.get("smtp_password")
    if new_password is not None:
        password = str(new_password)
        if password.strip():
            merged["smtp_password"] = password.strip()

    merged = _normalize_row(merged)
    with planner_db() as con:
        ensure_email_settings_schema(con)
        con.execute(
            """
            UPDATE public.planner_email_settings
            SET smtp_enabled = %s,
                smtp_host = %s,
                smtp_port = %s,
                smtp_user = %s,
                smtp_password = %s,
                smtp_from = %s,
                smtp_use_tls = %s,
                smtp_timeout_sec = %s,
                new_so_enabled = %s,
                new_so_recipients = %s,
                new_so_cc = %s,
                new_so_bcc = %s,
                new_so_subject = %s,
                new_so_lookback_days = %s,
                new_so_ps_enabled = %s,
                new_so_ps_heading = %s,
                new_so_ps_line_template = %s,
                updated_at = %s
            WHERE settings_id = 1
            """,
            (
                bool(merged["smtp_enabled"]),
                str(merged["smtp_host"] or "").strip(),
                merged["smtp_port"],
                str(merged["smtp_user"] or "").strip(),
                str(merged["smtp_password"] or ""),
                str(merged["smtp_from"] or "").strip(),
                bool(merged["smtp_use_tls"]),
                merged["smtp_timeout_sec"],
                bool(merged["new_so_enabled"]),
                str(merged["new_so_recipients"] or "").strip(),
                str(merged["new_so_cc"] or "").strip(),
                str(merged["new_so_bcc"] or "").strip(),
                str(merged["new_so_subject"] or "").strip()
                or _DEFAULTS["new_so_subject"],
                merged["new_so_lookback_days"],
                bool(merged["new_so_ps_enabled"]),
                str(merged["new_so_ps_heading"] or "").strip()
                or _DEFAULTS["new_so_ps_heading"],
                str(merged["new_so_ps_line_template"] or "").strip()
                or _DEFAULTS["new_so_ps_line_template"],
                datetime.now(timezone.utc),
            ),
        )
        con.commit()
    return get_email_settings_row()
