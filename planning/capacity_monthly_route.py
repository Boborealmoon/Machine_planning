"""Monthly production capacity calculator — page and API."""

from __future__ import annotations

from datetime import date

from flask import Blueprint, jsonify, render_template, request

from .capacity_monthly_service import build_monthly_capacity_report
from .helpers import planner_db
from .utils import compact_text

capacity_monthly_bp = Blueprint("capacity_monthly", __name__)


def _parse_year(raw) -> int:
    try:
        value = int(compact_text(raw) or date.today().year)
    except (TypeError, ValueError):
        value = date.today().year
    return max(2000, min(2100, value))


@capacity_monthly_bp.get("/production-capacity")
def production_capacity_page():
    return render_template("capacity_monthly.html", active="production_capacity")


def _parse_as_of(raw) -> date:
    text = compact_text(raw)
    if not text:
        return date.today()
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return date.today()


@capacity_monthly_bp.get("/api/production-capacity")
def api_production_capacity():
    year = _parse_year(request.args.get("year"))
    category = compact_text(request.args.get("category")) or "all"
    schedule_mode = compact_text(request.args.get("mode") or request.args.get("schedule_mode")) or "forecast"
    as_of = _parse_as_of(request.args.get("as_of"))
    try:
        with planner_db() as con:
            payload = build_monthly_capacity_report(
                con,
                year,
                category,
                schedule_mode=schedule_mode,
                as_of=as_of,
            )
        return jsonify(payload)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
