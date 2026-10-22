"""Monthly delivery plan page - outstanding lines assigned to a delivery month."""
from __future__ import annotations

import logging
import time
from datetime import date

from flask import Blueprint, jsonify, render_template, request

from .delivery_commitment_service import (
    AllocationError,
    apply_okay_flags,
    build_commitment_view,
    delete_commitment,
    load_commitments,
    load_okay_row_ids,
    save_adds,
    save_assign_month,
    save_move,
    save_qty,
    set_line_okay,
)
from .first_article_service import attach_program_pic_labels
from .helpers import planner_db
from .utils import compact_text

logger = logging.getLogger(__name__)

monthly_delivery_plan_bp = Blueprint("monthly_delivery_plan", __name__)

_LINES_CACHE: dict[int, tuple[float, tuple[list[dict], int]]] = {}
_LINES_TTL_SEC = 120.0


def _parse_year(raw) -> int:
    try:
        value = int(compact_text(raw) or date.today().year)
    except (TypeError, ValueError):
        value = date.today().year
    return max(2000, min(2100, value))


def _pricing_keys(orders: list[dict]) -> list[tuple[str, str]]:
    from .so_outstanding_balance_service import _so_line_pair

    keys: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for order in orders:
        so_no = compact_text(order.get("sales_order_no"))
        for pp in order.get("pp_vouchers") or []:
            pair = _so_line_pair(so_no, pp.get("source_line_item_no"))
            if not pair[0] or not pair[1] or pair in seen:
                continue
            seen.add(pair)
            keys.append(pair)
    return keys


def _load_outstanding(*, refresh: bool, year: int) -> tuple[list[dict], int]:
    from .monthly_delivery_plan_service import expand_delivered_lines
    from .process_sheets import fetch_so_line_pricing_map
    from .sales_orders_route import _fetch_sales_orders, _job_count
    from .so_outstanding_balance_route import _fetch_open_so_lines
    from .so_outstanding_balance_service import build_outstanding_balance

    cached = _LINES_CACHE.get(year)
    if not refresh and cached and (time.monotonic() - cached[0]) < _LINES_TTL_SEC:
        return cached[1]

    payload = _fetch_sales_orders(refresh=refresh, active_only=False)
    orders = list(payload.get("active") or [])
    complete = list(payload.get("complete") or [])
    open_so_lines = _fetch_open_so_lines(refresh=refresh)
    # Completed jobs already carry a unit price. Pricing every shipped line made assign wait.
    pricing = fetch_so_line_pricing_map(_pricing_keys(orders))
    result = build_outstanding_balance(orders, pricing, open_so_lines)
    lines = list(result.get("lines") or [])
    seen = {compact_text(line.get("row_id")) for line in lines}
    for line in expand_delivered_lines(complete, pricing, year=year):
        row_id = compact_text(line.get("row_id"))
        if not row_id or row_id in seen:
            continue
        seen.add(row_id)
        lines.append(line)
    packed = (lines, _job_count(orders))
    _LINES_CACHE[year] = (time.monotonic(), packed)
    return packed


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
        lines, job_count = _load_outstanding(refresh=_refresh_flag(), year=year)
        with planner_db() as con:
            commitments = load_commitments(con)
            okay_ids = load_okay_row_ids(con)
            view = build_commitment_view(lines, commitments, year=year)
            apply_okay_flags(view.get("lines") or [], okay_ids)
            attach_program_pic_labels(con, view.get("lines") or [])
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


@monthly_delivery_plan_bp.post("/api/monthly-delivery-plan/okay")
def api_set_line_okay():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "Expected a JSON object."}), 400
    row_id = compact_text(body.get("row_id"))
    okay = body.get("okay")
    if not row_id or not isinstance(okay, bool):
        return jsonify({"ok": False, "error": "Missing line."}), 400
    try:
        with planner_db() as con:
            set_line_okay(con, row_id, okay)
        return jsonify({"ok": True, "row_id": row_id, "okay": okay})
    except AllocationError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("set delivery line okay failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@monthly_delivery_plan_bp.post("/api/monthly-delivery-plan/slices")
def api_add_delivery_slices():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "Expected a JSON object."}), 400
    plan_month, items = _assignment_items(body)
    try:
        with planner_db() as con:
            if body.get("whole"):
                assigned = save_assign_month(con, {}, plan_month, items)
                return jsonify({"ok": True, "assigned": assigned})
            lines, _job_count = _load_outstanding(refresh=False, year=date.today().year)
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
        lines, _job_count = _load_outstanding(refresh=False, year=date.today().year)
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


@monthly_delivery_plan_bp.post("/api/monthly-delivery-plan/slices/clear")
def api_clear_delivery_slices():
    body = request.get_json(silent=True) or {}
    raw_ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids:
        return jsonify({"ok": False, "error": "Nothing to clear."}), 400
    try:
        ids = [int(item) for item in raw_ids]
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Nothing to clear."}), 400
    try:
        with planner_db() as con:
            for commitment_id in ids:
                delete_commitment(con, commitment_id)
        return jsonify({"ok": True, "cleared": ids})
    except Exception as exc:
        logger.exception("clear delivery slices failed")
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
