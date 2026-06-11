"""Daily output & efficiency board — page and API."""

from __future__ import annotations

import logging
import os
import secrets
from datetime import date

from flask import jsonify, render_template, request, session

from .daily_output_service import (
    apply_migration,
    build_sheet_payload,
    get_snapshot_detail,
    patch_sheet,
    refresh_plan_from_schedule,
)
from .helpers import planner_db
from .utils import compact_text

log = logging.getLogger(__name__)

DAILY_OUTPUT_EDIT_SESSION_KEY = "daily_output_edit_ok"
_schema_ready = False


def _planner_passcode() -> str:
    return (os.getenv("PLANNER_PASSCODE") or "").strip()


def _daily_output_edit_unlocked() -> bool:
    return session.get(DAILY_OUTPUT_EDIT_SESSION_KEY) is True


def _parse_work_date(raw: str | None) -> date:
    text = compact_text(raw)
    if not text:
        return date.today()
    return date.fromisoformat(text[:10])


def _ensure_schema(con):
    global _schema_ready
    if _schema_ready:
        return
    try:
        apply_migration(con)
        _schema_ready = True
    except Exception as exc:
        log.warning("daily output migration apply failed (run migrations/add_daily_output_board.sql): %s", exc)


def daily_output_page():
    return render_template("daily_output.html", active="daily_output")


def api_daily_output_get():
    work_date = _parse_work_date(request.args.get("date"))
    try:
        with planner_db() as con:
            _ensure_schema(con)
            payload = build_sheet_payload(con, work_date)
    except Exception as exc:
        log.exception("daily output load failed")
        return jsonify({"error": str(exc)}), 500

    payload["edit_unlocked"] = _daily_output_edit_unlocked()
    payload["requires_passcode"] = work_date < date.today() and not _daily_output_edit_unlocked()
    return jsonify(payload)


def api_daily_output_patch():
    data = request.get_json(silent=True) or {}
    work_date = _parse_work_date(data.get("work_date") or data.get("date"))
    allow_past = work_date >= date.today() or _daily_output_edit_unlocked()
    if not allow_past:
        return jsonify({"error": "Passcode required to edit past days.", "requires_passcode": True}), 403

    try:
        with planner_db() as con:
            _ensure_schema(con)
            payload = patch_sheet(
                con,
                work_date,
                lines=data.get("lines"),
                machines=data.get("machines"),
                shift_start=compact_text(data.get("shift_start") or data.get("shiftStart")) or None,
                shift_end=compact_text(data.get("shift_end") or data.get("shiftEnd")) or None,
                allow_past_edit=_daily_output_edit_unlocked(),
            )
    except PermissionError as exc:
        return jsonify({"error": str(exc), "requires_passcode": True}), 403
    except Exception as exc:
        log.exception("daily output patch failed")
        return jsonify({"error": str(exc)}), 400

    payload["edit_unlocked"] = _daily_output_edit_unlocked()
    return jsonify(payload)


def api_daily_output_refresh_plan():
    data = request.get_json(silent=True) or {}
    work_date = _parse_work_date(data.get("work_date") or data.get("date"))
    try:
        with planner_db() as con:
            _ensure_schema(con)
            payload = refresh_plan_from_schedule(con, work_date)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 409
    except Exception as exc:
        log.exception("daily output refresh plan failed")
        return jsonify({"error": str(exc)}), 500
    return jsonify(payload)


def api_daily_output_unlock():
    data = request.get_json(silent=True) or {}
    entered = compact_text(data.get("passcode"))
    passcode = _planner_passcode()
    if not passcode:
        session[DAILY_OUTPUT_EDIT_SESSION_KEY] = True
        return jsonify({"ok": True, "message": "No passcode configured — edit unlocked."})
    if passcode and secrets.compare_digest(entered, passcode):
        session[DAILY_OUTPUT_EDIT_SESSION_KEY] = True
        return jsonify({"ok": True})
    return jsonify({"error": "Invalid passcode."}), 403


def api_daily_output_snapshot_detail(snapshot_id: int):
    try:
        with planner_db() as con:
            _ensure_schema(con)
            detail = get_snapshot_detail(con, snapshot_id)
    except Exception as exc:
        log.exception("daily output snapshot load failed")
        return jsonify({"error": str(exc)}), 500
    if not detail:
        return jsonify({"error": "Snapshot not found."}), 404
    return jsonify(detail)
