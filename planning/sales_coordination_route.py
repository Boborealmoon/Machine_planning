"""Sales-coordination view - APS/NPS delivery commitments."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from .sales_coordination_service import (
    build_sales_coordination,
    save_sales_coordination_edits,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

sales_coordination_bp = Blueprint("sales_coordination", __name__)

SALES_COORDINATION_PATH = "/sales-coordination"


@sales_coordination_bp.get(SALES_COORDINATION_PATH)
def sales_coordination_page():
    return render_template("sales_coordination.html", active="sales_coordination")


@sales_coordination_bp.get("/api/sales-coordination")
def api_sales_coordination():
    refresh = compact_text(request.args.get("refresh")).lower() in ("1", "true", "yes")
    try:
        from .sales_orders_route import _fetch_sales_orders, _job_count

        payload = _fetch_sales_orders(refresh=refresh, active_only=True)
        orders = list(payload.get("active") or [])
        result = build_sales_coordination(orders)
        result["active_job_count"] = _job_count(orders)
        result["frame_agreement_parts"] = list(payload.get("frame_agreement_parts") or [])
        return jsonify(result)
    except Exception as exc:
        logger.exception("sales coordination failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@sales_coordination_bp.patch("/api/sales-coordination/lines")
def api_sales_coordination_lines():
    data = request.get_json(force=True, silent=True) or {}
    updates = data.get("updates")
    if not isinstance(updates, list) or not updates:
        return jsonify({"ok": False, "error": "No updates."}), 400
    try:
        saved = save_sales_coordination_edits(updates)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("sales coordination save failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
    return jsonify({"ok": True, "lines": saved})
