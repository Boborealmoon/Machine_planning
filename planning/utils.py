"""planning/utils.py — pure-Python helpers, no DB dependency."""
from __future__ import annotations

import re
from datetime import date, datetime

try:
    from openpyxl import load_workbook
except Exception:
    load_workbook = None


def compact_text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value != value:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def parse_number(value, default=0.0):
    try:
        if value is None or value == "":
            return float(default)
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def parse_nullable_number(value):
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_date_text(value):
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if text.lower() in {"nan", "nat", "none", "null"}:
        return ""
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return text


def normalize_column_name(value):
    value = str(value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    return value.strip("_")


def normalize_sheet_name(value):
    value = str(value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "", value)
    return value


def first_nonempty(row, *keys):
    for key in keys:
        value = compact_text(row.get(key))
        if value:
            return value
    return ""


def format_qty(value):
    if value is None:
        return ""
    value = float(value)
    if value.is_integer():
        return str(int(value))
    return str(value)


def normalize_block_status_inputs(data, default_planning="PLANNED", default_execution="NOT_STARTED"):
    planning_status = compact_text(data.get("planning_status")) or default_planning
    execution_status = compact_text(data.get("execution_status")) or default_execution
    legacy_status = compact_text(data.get("status"))
    if legacy_status:
        if legacy_status.upper() in {"NOT_STARTED", "IN_PROGRESS", "DONE"}:
            execution_status = legacy_status
        elif legacy_status.upper() in {"UNPLANNED", "PARTIALLY_PLANNED", "PLANNED"}:
            planning_status = legacy_status
    return planning_status, execution_status


def combine_date_time(d: date, hhmm: str):
    hour, minute = [int(part) for part in hhmm.split(":", 1)]
    return datetime(d.year, d.month, d.day, hour, minute, 0)


def trial_process_sheet_completed(row):
    return (
        compact_text(row.get("status")).upper() == "COMPLETED"
        or compact_text(row.get("planner_status")).upper() == "COMPLETED"
    )
