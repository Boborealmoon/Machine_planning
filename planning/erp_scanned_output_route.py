"""ERP scanned-output board: accepted-qty jumps grouped by machine."""
from __future__ import annotations

import logging
import os
from datetime import datetime

from flask import Blueprint, jsonify, render_template, request

from .erp_scanned_output_service import fetch_scanned_output
from .helpers import planner_db
from .utils import compact_text

logger = logging.getLogger(__name__)

erp_scanned_output_bp = Blueprint("erp_scanned_output", __name__)


def _parse_limit(raw) -> int:
    try:
        return int(raw or 2000)
    except (TypeError, ValueError):
        return 2000


def erp_scanned_output_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "erp_scanned_output.js"),
        os.path.join(root, "static", "css", "erp_scanned_output.css"),
        os.path.join(root, "templates", "erp_scanned_output.html"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"eso-{int(mt)}"
    except OSError:
        return "eso-dev"


@erp_scanned_output_bp.get("/erp-scanned-output")
def erp_scanned_output_page():
    return render_template(
        "erp_scanned_output.html",
        active="erp_scanned_output",
        asset_version=erp_scanned_output_asset_version(),
    )


@erp_scanned_output_bp.get("/api/erp-scanned-output")
def api_erp_scanned_output():
    try:
        with planner_db() as con:
            payload = fetch_scanned_output(
                con,
                from_date=compact_text(request.args.get("from") or request.args.get("from_date")),
                to_date=compact_text(request.args.get("to") or request.args.get("to_date")),
                machine_no=compact_text(request.args.get("machine_no") or request.args.get("machine")),
                search=compact_text(request.args.get("search") or request.args.get("q")),
                limit=_parse_limit(request.args.get("limit")),
            )
    except Exception as exc:
        logger.exception("ERP scanned output query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
    payload["ok"] = True
    payload["loaded_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return jsonify(payload)
