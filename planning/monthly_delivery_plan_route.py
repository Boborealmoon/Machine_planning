"""Monthly delivery plan page - ARCHIVE view of commitment-month revenue targets."""
from __future__ import annotations

import logging
from datetime import date

from flask import Blueprint, jsonify, render_template, request

from .monthly_delivery_plan_service import (
    build_monthly_delivery_plan,
    pricing_keys_from_orders,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

monthly_delivery_plan_bp = Blueprint("monthly_delivery_plan", __name__)


def _parse_year(raw) -> int:
    try:
        value = int(compact_text(raw) or date.today().year)
    except (TypeError, ValueError):
        value = date.today().year
    return max(2000, min(2100, value))


@monthly_delivery_plan_bp.get("/monthly-delivery-plan")
def monthly_delivery_plan_page():
    return render_template("monthly_delivery_plan.html", active="monthly_delivery_plan")


@monthly_delivery_plan_bp.get("/api/monthly-delivery-plan")
def api_monthly_delivery_plan():
    year = _parse_year(request.args.get("year"))
    refresh = compact_text(request.args.get("refresh")).lower() in ("1", "true", "yes")
    try:
        from .process_sheets import fetch_so_line_pricing_map
        from .sales_orders_route import _fetch_sales_orders, _job_count

        payload = _fetch_sales_orders(refresh=refresh)
        orders = list(payload.get("active") or [])
        pricing = fetch_so_line_pricing_map(pricing_keys_from_orders(orders))
        plan = build_monthly_delivery_plan(orders, year=year, pricing_by_key=pricing)
        plan["active_job_count"] = _job_count(orders)
        return jsonify(plan)
    except Exception as exc:
        logger.exception("monthly delivery plan failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
