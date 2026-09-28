"""RFQ checker pages and APIs."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, redirect, render_template, request

from .rfq_checker_service import (
    FIELD_LABELS,
    MAX_UPLOAD_BYTES,
    SHEET_TAGS,
    archive_batch,
    check_parts,
    create_batch_from_upload,
    delete_batch,
    get_batch,
    get_existing_part,
    json_error,
    list_archive,
    list_existing_parts,
    list_part_master,
    llm_status,
    remap_batch,
    update_batch_defaults,
    update_line,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

rfq_checker_bp = Blueprint("rfq_checker", __name__)

RFQ_CHECKER_PATH = "/archive/rfq-checker"
RFQ_UPLOAD_PATH = "/archive/rfq-checker/upload"


@rfq_checker_bp.get(RFQ_CHECKER_PATH)
def rfq_checker_page():
    return render_template("rfq_checker.html", active="rfq_checker", rfq_page="library")


@rfq_checker_bp.get(RFQ_UPLOAD_PATH)
def rfq_checker_upload_page():
    return render_template("rfq_checker_upload.html", active="rfq_checker", rfq_page="upload")


@rfq_checker_bp.get("/rfq-checker")
def rfq_checker_short_path():
    return redirect(RFQ_CHECKER_PATH)


@rfq_checker_bp.get("/api/rfq-checker/meta")
def api_rfq_meta():
    return jsonify({
        "ok": True,
        "field_labels": FIELD_LABELS,
        "llm": llm_status(),
        "hours_per_day": 10,
        "sheet_tags": list(SHEET_TAGS),
    })


@rfq_checker_bp.get("/api/rfq-checker/parts")
def api_rfq_parts():
    query = compact_text(request.args.get("q"))
    try:
        limit = int(request.args.get("limit") or 250)
    except (TypeError, ValueError):
        limit = 250
    try:
        payload = list_existing_parts(query, limit=limit)
    except Exception as exc:
        logger.exception("RFQ parts list failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    return jsonify(payload)


@rfq_checker_bp.get("/api/rfq-checker/parts/<path:part_no>")
def api_rfq_part_detail(part_no: str):
    try:
        row = get_existing_part(part_no)
    except Exception as exc:
        logger.exception("RFQ part detail failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    if not row:
        return jsonify({"error": "Part not found in cycle times, process sheets, or RFQ part records"}), 404
    return jsonify({"ok": True, "part": row})


@rfq_checker_bp.get("/api/rfq-checker/archive")
def api_rfq_archive():
    query = compact_text(request.args.get("q"))
    try:
        payload = list_archive(query)
    except Exception as exc:
        logger.exception("RFQ archive list failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    return jsonify(payload)


@rfq_checker_bp.get("/api/rfq-checker/part-master")
def api_rfq_part_master():
    query = compact_text(request.args.get("q"))
    try:
        payload = list_part_master(query)
    except Exception as exc:
        logger.exception("RFQ part master list failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    return jsonify(payload)


@rfq_checker_bp.post("/api/rfq-checker/upload")
def api_rfq_upload():
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
    sheet_name = compact_text(request.form.get("sheet") or request.args.get("sheet"))
    use_llm_raw = compact_text(request.form.get("use_llm") or request.args.get("use_llm") or "0").lower()
    use_llm = use_llm_raw not in {"0", "false", "no", "off"}
    try:
        batch = create_batch_from_upload(
            filename=filename,
            payload=payload,
            sheet_name=sheet_name,
            use_llm=use_llm,
            sheet_tag=compact_text(request.form.get("sheet_tag") or request.args.get("sheet_tag")),
            default_rfq=compact_text(request.form.get("rfq") or request.form.get("default_rfq")),
            default_customer=compact_text(request.form.get("customer") or request.form.get("default_customer")),
            default_salesperson=compact_text(
                request.form.get("salesperson") or request.form.get("default_salesperson")
            ),
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("RFQ upload failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return jsonify({"ok": True, "batch": batch}), 201


@rfq_checker_bp.get("/api/rfq-checker/batches/<int:batch_id>")
def api_rfq_batch(batch_id: int):
    line_limit = None
    raw_limit = compact_text(request.args.get("limit"))
    if raw_limit:
        try:
            line_limit = max(1, min(int(raw_limit), 2000))
        except (TypeError, ValueError):
            line_limit = 300
    try:
        batch = get_batch(batch_id, line_limit=line_limit)
    except Exception as exc:
        logger.exception("RFQ batch load failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    if not batch:
        return jsonify({"error": "RFQ batch not found"}), 404
    return jsonify({"ok": True, "batch": batch})


@rfq_checker_bp.post("/api/rfq-checker/batches/<int:batch_id>/remap")
def api_rfq_remap(batch_id: int):
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    column_map = data.get("column_map") or data.get("mapping") or {}
    if not isinstance(column_map, dict):
        return jsonify({"error": "column_map must be an object"}), 400
    try:
        batch = remap_batch(batch_id, column_map)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("RFQ remap failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return jsonify({"ok": True, "batch": batch})


@rfq_checker_bp.patch("/api/rfq-checker/lines/<int:line_id>")
def api_rfq_update_line(line_id: int):
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    try:
        row = update_line(line_id, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("RFQ line update failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return jsonify({"ok": True, "row": row})


@rfq_checker_bp.patch("/api/rfq-checker/batches/<int:batch_id>/defaults")
def api_rfq_batch_defaults(batch_id: int):
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    try:
        batch = update_batch_defaults(batch_id, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("RFQ batch defaults failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return jsonify({"ok": True, "batch": batch})


@rfq_checker_bp.delete("/api/rfq-checker/batches/<int:batch_id>")
def api_rfq_delete_batch(batch_id: int):
    try:
        result = delete_batch(batch_id)
    except ValueError as exc:
        status = 404 if "not found" in str(exc).lower() else 400
        return jsonify({"error": str(exc)}), status
    except Exception as exc:
        logger.exception("RFQ batch delete failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return jsonify(result)


@rfq_checker_bp.post("/api/rfq-checker/check")
def api_rfq_check():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        data = {}
    raw_parts = data.get("parts") or data.get("part_nos") or []
    if isinstance(raw_parts, str):
        raw_parts = [raw_parts]
    if not isinstance(raw_parts, list):
        return jsonify({"error": "parts must be a list of part numbers"}), 400
    query = compact_text(data.get("q") or request.args.get("q"))
    raw_batch = data.get("batch_id")
    if raw_batch in (None, ""):
        raw_batch = request.args.get("batch_id")
    batch_id = None
    if raw_batch not in (None, ""):
        try:
            batch_id = int(raw_batch)
        except (TypeError, ValueError):
            return jsonify({"error": "batch_id must be a number"}), 400
    try:
        payload = check_parts(
            [compact_text(item) for item in raw_parts if compact_text(item)],
            batch_id=batch_id,
            query=query,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("RFQ check failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    return jsonify(payload)


@rfq_checker_bp.post("/api/rfq-checker/batches/<int:batch_id>/archive")
def api_rfq_archive_batch(batch_id: int):
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        data = {}
    customer = compact_text(data.get("customer") or data.get("default_customer"))
    if not customer:
        return jsonify({"error": "Choose the customer this quote is for before saving."}), 400
    try:
        batch = archive_batch(batch_id, customer)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("RFQ archive save failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return jsonify({"ok": True, "batch": batch})
