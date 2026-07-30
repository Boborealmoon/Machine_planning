"""Factory floor plan - interactive shop layout with utilization and capacity bookings."""

from __future__ import annotations

import logging
from datetime import date

from flask import Blueprint, jsonify, render_template, request

from .capacity_group_service import default_planning_month
from .floor_plan_service import (
    add_machine_part_tag,
    delete_machine_capacity_booking,
    delete_machine_part_tag,
    fetch_floor_plan,
    upsert_machine_capacity_booking,
)
from .helpers import planner_db
from .process_sheets import format_planner_ps_id, normalize_standard_ps_id, search_process_sheet_sources
from .utils import compact_text

logger = logging.getLogger(__name__)

floor_plan_bp = Blueprint("floor_plan", __name__)


def _parse_year(raw) -> int:
    try:
        value = int(compact_text(raw) or date.today().year)
    except (TypeError, ValueError):
        value = date.today().year
    return max(2000, min(2100, value))


def _parse_month(raw) -> int:
    try:
        value = int(compact_text(raw) or default_planning_month()[1])
    except (TypeError, ValueError):
        value = default_planning_month()[1]
    return max(1, min(12, value))


def _parse_as_of(raw) -> date:
    text = compact_text(raw)
    if not text:
        return date.today()
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return date.today()


@floor_plan_bp.get("/floor-plan")
def floor_plan_page():
    return render_template("floor_plan.html", active="floor_plan")


@floor_plan_bp.get("/api/floor-plan")
def api_floor_plan():
    year = _parse_year(request.args.get("year"))
    month = _parse_month(request.args.get("month"))
    basis = compact_text(request.args.get("basis") or request.args.get("mode")) or "rest_of_month"
    as_of = _parse_as_of(request.args.get("as_of"))
    try:
        with planner_db() as con:
            payload = fetch_floor_plan(
                con,
                year=year,
                month=month,
                capacity_basis=basis,
                as_of=as_of,
            )
        return jsonify(payload)
    except Exception as exc:
        logger.exception("floor plan query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@floor_plan_bp.post("/api/floor-plan/bookings")
def api_floor_plan_upsert_booking():
    data = request.get_json(silent=True) or {}
    try:
        machine_id = int(data.get("machine_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "machine_id is required."}), 400

    year = data.get("planning_year", data.get("year"))
    month = data.get("planning_month", data.get("month"))
    as_of = _parse_as_of(data.get("as_of"))

    try:
        with planner_db() as con:
            booking = upsert_machine_capacity_booking(
                con,
                machine_id=machine_id,
                planning_year=year,
                planning_month=month,
                part_no=data.get("part_no"),
                reserved_hours=data.get("reserved_hours"),
                tag_label=data.get("tag_label") or "",
                notes=data.get("notes") or "",
                as_of=as_of,
            )
        return jsonify({"ok": True, "booking": booking, "warning": booking.get("warning")})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("floor plan upsert booking failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@floor_plan_bp.delete("/api/floor-plan/bookings/<int:booking_id>")
def api_floor_plan_delete_booking(booking_id: int):
    try:
        with planner_db() as con:
            deleted = delete_machine_capacity_booking(con, booking_id)
        if not deleted:
            return jsonify({"ok": False, "error": "Booking not found."}), 404
        return jsonify({"ok": True})
    except Exception as exc:
        logger.exception("floor plan delete booking failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@floor_plan_bp.post("/api/floor-plan/tags")
def api_floor_plan_add_tag():
    data = request.get_json(silent=True) or {}
    try:
        machine_id = int(data.get("machine_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "machine_id is required."}), 400

    try:
        with planner_db() as con:
            tag = add_machine_part_tag(
                con,
                machine_id=machine_id,
                part_no=data.get("part_no"),
                tag_label=data.get("tag_label") or "",
                notes=data.get("notes") or "",
            )
        return jsonify({"ok": True, "tag": tag})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("floor plan add tag failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@floor_plan_bp.delete("/api/floor-plan/tags/<int:tag_id>")
def api_floor_plan_delete_tag(tag_id: int):
    try:
        with planner_db() as con:
            deleted = delete_machine_part_tag(con, tag_id)
        if not deleted:
            return jsonify({"ok": False, "error": "Tag not found."}), 404
        return jsonify({"ok": True})
    except Exception as exc:
        logger.exception("floor plan delete tag failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@floor_plan_bp.get("/api/floor-plan/process-sheets/search")
def api_floor_plan_process_sheet_search():
    query = compact_text(request.args.get("q") or request.args.get("search"))
    if not query:
        return jsonify({"items": []})
    try:
        limit = max(1, min(int(request.args.get("limit") or 20), 30))
    except (TypeError, ValueError):
        limit = 20
    try:
        with planner_db() as con:
            items = search_process_sheet_sources(con, query, limit=limit)
        for item in items:
            source_ps_id = normalize_standard_ps_id(item.get("ps_id"))
            partial_no = int(item.get("pp_partial_no") or 1)
            item["source_ps_id"] = source_ps_id
            item["planner_ps_id"] = format_planner_ps_id(source_ps_id, partial_no)
            item["part_desc"] = compact_text(item.get("description"))
            partial_label = f" - Partial {partial_no}" if partial_no > 1 else ""
            item["display_ps_id"] = f"{source_ps_id}{partial_label}"
        return jsonify({"items": items})
    except Exception as exc:
        logger.exception("floor plan process sheet search failed")
        return jsonify({"error": str(exc)}), 500
