"""Monthly delivery plan page - outstanding lines assigned to a delivery month."""
from __future__ import annotations

import logging
from datetime import date

from flask import Blueprint, jsonify, render_template, request

from .delivery_commitment_service import (
    AllocationError,
    build_commitment_view,
    delete_commitment,
    load_commitments,
    save_adds,
    save_move,
    save_qty,
)
from .helpers import planner_db
from .utils import compact_text

logger = logging.getLogger(__name__)

monthly_delivery_plan_bp = Blueprint("monthly_delivery_plan", __name__)


def _parse_year(raw) -> int:
    try:
        value = int(compact_text(raw) or date.today().year)
    except (TypeError, ValueError):
        value = date.today().year
    return max(2000, min(2100, value))


def _load_outstanding(*, refresh: bool) -> tuple[list[dict], int]:
    from .process_sheets import fetch_so_line_pricing_map
    from .sales_orders_route import _fetch_sales_orders, _job_count
    from .so_outstanding_balance_route import _fetch_open_so_lines
    from .so_outstanding_balance_service import (
        build_outstanding_balance,
        pricing_keys_from_orders,
    )

    payload = _fetch_sales_orders(refresh=refresh, active_only=True)
    orders = list(payload.get("active") or [])
    open_so_lines = _fetch_open_so_lines(refresh=refresh)
    pricing = fetch_so_line_pricing_map(pricing_keys_from_orders(orders))
    result = build_outstanding_balance(orders, pricing, open_so_lines)
    return list(result.get("lines") or []), _job_count(orders)


def _lines_by_id(lines: list[dict]) -> dict[str, dict]:
    return {compact_text(line.get("row_id")): line for line in lines if compact_text(line.get("row_id"))}


def _refresh_flag() -> bool:
    return compact_text(request.args.get("refresh")).lower() in ("1", "true", "yes")


@monthly_delivery_plan_bp.get("/monthly-delivery-plan")
def monthly_delivery_plan_page():
    return render_template("monthly_delivery_plan.html", active="monthly_delivery_plan")


@monthly_delivery_plan_bp.get("/api/monthly-delivery-plan")
def api_monthly_delivery_plan():
    year = _parse_year(request.args.get("year"))
    try:
        lines, job_count = _load_outstanding(refresh=_refresh_flag())
        with planner_db() as con:
            commitments = load_commitments(con)
        view = build_commitment_view(lines, commitments, year=year)
        view["active_job_count"] = job_count
        return jsonify(view)
    except Exception as exc:
        logger.exception("monthly delivery plan failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


def _assignment_items(body: dict) -> tuple[object, list[dict]]:
    plan_month = body.get("plan_month")
    items = body.get("items")
    if items is None and body.get("row_id"):
        items = [{"row_id": body.get("row_id"), "qty": body.get("qty")}]
    if not isinstance(items, list):
        items = []
    return plan_month, items


@monthly_delivery_plan_bp.post("/api/monthly-delivery-plan/slices")
def api_add_delivery_slices():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "Expected a JSON object."}), 400
    plan_month, items = _assignment_items(body)
    try:
        lines, _job_count = _load_outstanding(refresh=False)
        with planner_db() as con:
            save_adds(con, _lines_by_id(lines), plan_month, items)
        return jsonify({"ok": True})
    except AllocationError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("assign delivery month failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@monthly_delivery_plan_bp.patch("/api/monthly-delivery-plan/slices/<int:commitment_id>")
def api_update_delivery_slice(commitment_id: int):
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "Expected a JSON object."}), 400
    has_qty = "qty" in body and body.get("qty") not in (None, "")
    has_month = bool(compact_text(body.get("plan_month")))
    if has_qty == has_month:
        message = (
            "Update quantity or month, not both at once."
            if has_qty
            else "Nothing to update."
        )
        return jsonify({"ok": False, "error": message}), 400
    try:
        lines, _job_count = _load_outstanding(refresh=False)
        with planner_db() as con:
            if has_qty:
                save_qty(con, _lines_by_id(lines), commitment_id, body.get("qty"))
            else:
                save_move(con, _lines_by_id(lines), commitment_id, body.get("plan_month"))
        return jsonify({"ok": True})
    except AllocationError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 404
    except Exception as exc:
        logger.exception("update delivery slice failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@monthly_delivery_plan_bp.delete("/api/monthly-delivery-plan/slices/<int:commitment_id>")
def api_delete_delivery_slice(commitment_id: int):
    try:
        with planner_db() as con:
            deleted = delete_commitment(con, commitment_id)
        if not deleted:
            return jsonify({"ok": False, "error": "That assignment is no longer saved."}), 404
        return jsonify({"ok": True})
    except Exception as exc:
        logger.exception("delete delivery slice failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
