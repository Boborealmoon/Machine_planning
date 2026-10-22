"""Process sheet trace — public shop-floor view of a job's assigned batch."""
from __future__ import annotations

import logging

from flask import Blueprint, Response, jsonify, redirect, render_template, request

from db import planner_db_connect_error

from .process_sheet_document import document_filename, load_process_sheet_document, render_process_sheet_pdf
from .process_sheet_trace_service import suggest_trace_sheets, trace_process_sheet
from .utils import compact_text

logger = logging.getLogger(__name__)

process_sheet_trace_bp = Blueprint("process_sheet_trace", __name__)

TRACE_PATH = "/process-sheet-trace"
LEGACY_TRACE_PATH = "/planning-data/process-sheet-trace"


def _render_trace_page():
    return render_template(
        "process_sheet_trace.html",
        active="process_sheet_trace",
        initial_ps=compact_text(request.args.get("ps")),
    )


@process_sheet_trace_bp.get(TRACE_PATH)
def process_sheet_trace_page():
    return _render_trace_page()


@process_sheet_trace_bp.get(LEGACY_TRACE_PATH)
def process_sheet_trace_legacy_page():
    query = request.query_string.decode()
    target = TRACE_PATH + (f"?{query}" if query else "")
    return redirect(target, code=302)


@process_sheet_trace_bp.get("/api/process-sheet-trace/suggest")
def api_process_sheet_suggest():
    query = compact_text(request.args.get("q") or request.args.get("ps"))
    if len(query) < 2:
        return jsonify({"suggestions": []})
    try:
        suggestions = suggest_trace_sheets(query)
    except Exception as exc:
        logger.exception("process sheet suggest failed for %s", query)
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": "Could not look up process sheets."}), 500
    return jsonify({"suggestions": suggestions})


@process_sheet_trace_bp.get("/api/process-sheet-trace")
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


@process_sheet_trace_bp.get("/api/process-sheet-trace/document")
def api_process_sheet_document():
    process_sheet_no = compact_text(request.args.get("ps") or request.args.get("q"))
    if not process_sheet_no:
        return jsonify({"error": "Enter a process sheet number."}), 400
    try:
        document = load_process_sheet_document(process_sheet_no)
    except Exception as exc:
        logger.exception("process sheet document failed for %s", process_sheet_no)
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": "Could not build the process sheet."}), 500
    if not document:
        return jsonify({"error": "Process sheet was not found."}), 404
    try:
        pdf = render_process_sheet_pdf(document)
    except Exception:
        logger.exception("process sheet pdf failed for %s", process_sheet_no)
        return jsonify({"error": "Could not build the process sheet."}), 500
    filename = document_filename(document)
    return Response(
        pdf,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
