"""Process sheet trace — pushed BOM inventory code through to allocated batch / heat."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error

from .process_sheet_trace_service import trace_process_sheet
from .utils import compact_text

logger = logging.getLogger(__name__)

process_sheet_trace_bp = Blueprint("process_sheet_trace", __name__)

TRACE_PATH = "/planning-data/process-sheet-trace"


@process_sheet_trace_bp.get(TRACE_PATH)
def process_sheet_trace_page():
    return render_template(
        "process_sheet_trace.html",
        active="planning_data",
        initial_ps=compact_text(request.args.get("ps")),
    )


@process_sheet_trace_bp.get("/api/planning-data/process-sheet-trace")
def api_process_sheet_trace():
    process_sheet_no = compact_text(request.args.get("ps") or request.args.get("q"))
    if not process_sheet_no:
        return jsonify({"error": "Enter a process sheet number."}), 400
    try:
        payload = trace_process_sheet(process_sheet_no)
    except Exception as exc:
        logger.exception("process sheet trace failed for %s", process_sheet_no)
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": "Could not read the process sheet from ERP."}), 500
    if not payload.get("found"):
        return jsonify(payload), 404
    return jsonify(payload)
