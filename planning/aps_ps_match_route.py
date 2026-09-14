"""APS process-sheet Excel matcher - Archive upload tool."""
from __future__ import annotations

import io
import json
import logging

from flask import Blueprint, jsonify, render_template, request, send_file

from .aps_ps_match_service import (
    MAX_UPLOAD_BYTES,
    json_error,
    process_upload,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

aps_ps_match_bp = Blueprint("aps_ps_match", __name__)

APS_PS_MATCH_PATH = "/archive/aps-ps-match"


@aps_ps_match_bp.get(APS_PS_MATCH_PATH)
def aps_ps_match_page():
    return render_template("aps_ps_match.html", active="aps_ps_match")


@aps_ps_match_bp.post("/api/archive/aps-ps-match")
def api_aps_ps_match():
    upload = request.files.get("file") or request.files.get("excel")
    if upload is None or not compact_text(getattr(upload, "filename", "")):
        return jsonify({"error": "Choose an Excel file to upload"}), 400
    filename = compact_text(upload.filename)
    lower = filename.lower()
    if not lower.endswith((".xlsx", ".xlsm", ".xls")):
        return jsonify({"error": "Upload an .xlsx or .xls workbook"}), 400
    payload = upload.read()
    if not payload:
        return jsonify({"error": "The Excel file is empty"}), 400
    if len(payload) > MAX_UPLOAD_BYTES:
        return jsonify({"error": "Excel file is larger than 12 MB"}), 400
    try:
        workbook_bytes, summary = process_upload(payload, filename)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("APS process-sheet Excel match failed")
        body, status = json_error(exc)
        return jsonify(body), status
    download_name = compact_text(summary.get("download_name")) or "aps-ps-match.xlsx"
    response = send_file(
        io.BytesIO(workbook_bytes),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=download_name,
    )
    response.headers["X-Aps-Match-Summary"] = json.dumps(summary, default=str)
    response.headers["Access-Control-Expose-Headers"] = "X-Aps-Match-Summary, Content-Disposition"
    return response
