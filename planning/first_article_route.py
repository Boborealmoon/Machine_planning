"""First Article Tracker - OPS view for flagged process sheets and NEW parts."""
from __future__ import annotations

import io
import logging

from flask import Blueprint, jsonify, redirect, render_template, request, send_file

from .first_article_service import (
    add_new_part_exception,
    add_pic,
    build_import_template_bytes,
    delete_pic,
    flag_process_sheet,
    flag_process_sheets,
    import_tracker_rows,
    json_error,
    list_change_history,
    list_flag_candidates,
    list_new_part_rows,
    list_tracker_rows,
    load_machine_catalog,
    load_pics,
    parse_npi_import_workbook,
    remove_new_part_exception,
    search_flag_candidates,
    unflag_process_sheet,
    update_new_part_row,
    update_tracker_row,
    _MAX_IMPORT_BYTES,
)
from .helpers import planner_db
from .utils import compact_text

logger = logging.getLogger(__name__)

first_article_bp = Blueprint("first_article", __name__)

FIRST_ARTICLE_PATH = "/ops/first-article"
FIRST_ARTICLE_LEGACY_PATH = "/archive/first-article"


@first_article_bp.get(FIRST_ARTICLE_PATH)
def first_article_page():
    return render_template("first_article.html", active="first_article")


@first_article_bp.get(FIRST_ARTICLE_LEGACY_PATH)
def first_article_page_legacy():
    return redirect(FIRST_ARTICLE_PATH)

_PATCH_FIELDS = (
    "pic_ids",
    "pic_names",
    "machine_codes",
    "remarks",
    "tooling",
    "fixture",
    "gauges",
    "tooling_mode",
    "tooling_tick",
    "tooling_text",
    "fixture_mode",
    "fixture_tick",
    "fixture_text",
    "gauges_mode",
    "gauges_tick",
    "gauges_text",
)

_NEW_PART_PATCH_FIELDS = (
    "bom_updated",
    "remarks",
    "program_finish_at",
    "program_pic_ids",
)


@first_article_bp.get("/api/first-article")
def api_list_first_article():
    try:
        with planner_db() as con:
            pics = load_pics(con)
        rows = list_tracker_rows()
        machines = load_machine_catalog()
    except Exception as exc:
        logger.exception("first article list failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify({"ok": True, "count": len(rows), "rows": rows, "pics": pics, "machines": machines})


@first_article_bp.get("/api/first-article/search")
def api_search_first_article():
    query = compact_text(request.args.get("q"))
    try:
        limit = int(request.args.get("limit") or 25)
    except (TypeError, ValueError):
        limit = 25
    try:
        hits = search_flag_candidates(query, limit=limit)
    except Exception as exc:
        logger.exception("first article search failed")
        payload, status = json_error(exc, fallback_status=502)
        return jsonify(payload), status
    return jsonify({"ok": True, "count": len(hits), "rows": hits})


@first_article_bp.get("/api/first-article/candidates")
def api_list_first_article_candidates():
    query = compact_text(request.args.get("q"))
    ps_type_filter = compact_text(request.args.get("ps_type"))
    scope_filter = compact_text(request.args.get("scope"))
    try:
        limit = int(request.args.get("limit") or 1500)
    except (TypeError, ValueError):
        limit = 1500
    try:
        payload = list_flag_candidates(
            query=query,
            ps_type_filter=ps_type_filter,
            scope_filter=scope_filter,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("first article candidates failed")
        body, status = json_error(exc, fallback_status=502)
        return jsonify(body), status
    return jsonify({"ok": True, **payload})


@first_article_bp.post("/api/first-article")
def api_flag_first_article():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    try:
        row, created = flag_process_sheet(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article flag failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify({"ok": True, "created": created, "row": row}), (201 if created else 200)


@first_article_bp.post("/api/first-article/bulk")
def api_bulk_flag_first_article():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    items = data.get("items")
    if items is None:
        items = data.get("process_sheet_nos")
    if items is None and compact_text(data.get("process_sheet_no")):
        items = [data]
    if not isinstance(items, list):
        return jsonify({"error": "items must be a list of process sheets"}), 400
    try:
        result = flag_process_sheets(items)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article bulk flag failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    status = 201 if result.get("created_count") else 200
    return jsonify({"ok": True, **result}), status


@first_article_bp.get("/api/first-article/import-template")
def api_first_article_import_template():
    try:
        payload = build_import_template_bytes()
    except Exception as exc:
        logger.exception("first article import template failed")
        body, status = json_error(exc)
        return jsonify(body), status
    return send_file(
        io.BytesIO(payload),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="npi-tracker-import.xlsx",
    )


@first_article_bp.post("/api/first-article/import")
def api_import_first_article():
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
    if len(payload) > _MAX_IMPORT_BYTES:
        return jsonify({"error": "Excel file is larger than 12 MB"}), 400
    try:
        items = parse_npi_import_workbook(payload, filename)
        result = import_tracker_rows(items)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article excel import failed")
        body, status = json_error(exc)
        return jsonify(body), status
    status = 201 if result.get("created_count") else 200
    return jsonify({"ok": True, **result}), status


@first_article_bp.patch("/api/first-article/<int:first_article_id>")
def api_update_first_article(first_article_id: int):
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    patch = {key: data[key] for key in _PATCH_FIELDS if key in data}
    if not patch:
        return jsonify({"error": "No editable fields supplied"}), 400
    try:
        row = update_tracker_row(first_article_id, patch)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article update failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    if not row:
        return jsonify({"error": "First article row not found"}), 404
    return jsonify({"ok": True, "row": row})


@first_article_bp.delete("/api/first-article/<int:first_article_id>")
def api_unflag_first_article(first_article_id: int):
    try:
        deleted = unflag_process_sheet(first_article_id)
    except Exception as exc:
        logger.exception("first article unflag failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    if not deleted:
        return jsonify({"error": "First article row not found"}), 404
    return jsonify({"ok": True, "first_article_id": first_article_id})


@first_article_bp.get("/api/first-article/new-parts")
def api_list_first_article_new_parts():
    scope = compact_text(request.args.get("scope")).lower() or "active"
    if scope not in {"active", "history"}:
        scope = "active"
    try:
        with planner_db() as con:
            pics = load_pics(con)
        rows = list_new_part_rows(scope=scope)
    except Exception as exc:
        logger.exception("first article new-parts list failed")
        payload, status = json_error(exc, fallback_status=502)
        return jsonify(payload), status
    return jsonify({"ok": True, "scope": scope, "count": len(rows), "rows": rows, "pics": pics})


@first_article_bp.post("/api/first-article/new-parts")
def api_add_first_article_new_part_exception():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    try:
        row, created = add_new_part_exception(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article new-part exception add failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    already = not created
    message = (
        f"Added {row.get('process_sheet_no')} as an exception"
        if created
        else f"{row.get('process_sheet_no')} is already on the NEW parts list"
    )
    return jsonify(
        {
            "ok": True,
            "created": created,
            "already_on_list": already,
            "row": row,
            "message": message,
        }
    ), (201 if created else 200)


@first_article_bp.delete("/api/first-article/new-parts/<path:process_sheet_no>")
def api_remove_first_article_new_part_exception(process_sheet_no: str):
    try:
        result = remove_new_part_exception(process_sheet_no)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article new-part exception remove failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    if not result:
        return jsonify({"error": "Exception not found"}), 404
    return jsonify({"ok": True, **result})


@first_article_bp.patch("/api/first-article/new-parts")
def api_update_first_article_new_part():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    patch = {key: data[key] for key in _NEW_PART_PATCH_FIELDS if key in data}
    process_sheet_no = compact_text(data.get("process_sheet_no") or data.get("pp_voucher_no"))
    if not process_sheet_no:
        return jsonify({"error": "process_sheet_no is required"}), 400
    if not patch:
        return jsonify({"error": "No editable fields supplied"}), 400
    patch["process_sheet_no"] = process_sheet_no
    if compact_text(data.get("pp_voucher_no")):
        patch["pp_voucher_no"] = compact_text(data.get("pp_voucher_no"))
    try:
        row = update_new_part_row(patch)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article new-part update failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify({"ok": True, "row": row})


@first_article_bp.get("/api/first-article/history")
def api_list_first_article_history():
    source = compact_text(request.args.get("source")).lower() or "new_part"
    process_sheet_no = compact_text(request.args.get("process_sheet_no") or request.args.get("ps"))
    try:
        limit = int(request.args.get("limit") or 200)
    except (TypeError, ValueError):
        limit = 200
    try:
        rows = list_change_history(source=source, process_sheet_no=process_sheet_no, limit=limit)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article history list failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify({
        "ok": True,
        "source": source,
        "process_sheet_no": process_sheet_no,
        "count": len(rows),
        "rows": rows,
    })


@first_article_bp.get("/api/first-article/pics")
def api_list_first_article_pics():
    try:
        with planner_db() as con:
            pics = load_pics(con)
    except Exception as exc:
        logger.exception("first article PIC list failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify({"ok": True, "pics": pics})


@first_article_bp.post("/api/first-article/pics")
def api_add_first_article_pic():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    name = compact_text(data.get("name"))
    if not name:
        return jsonify({"error": "PIC name is required"}), 400
    try:
        with planner_db() as con:
            pic, created = add_pic(con, name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("first article PIC add failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify(
        {
            "ok": True,
            "pic": pic,
            "created": created,
            "message": f"Added {pic.get('name', name)}" if created else f"{pic.get('name', name)} is already on the list",
        }
    )


@first_article_bp.delete("/api/first-article/pics/<int:pic_id>")
def api_delete_first_article_pic(pic_id: int):
    try:
        with planner_db() as con:
            result = delete_pic(con, pic_id)
    except Exception as exc:
        logger.exception("first article PIC delete failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    if not result:
        return jsonify({"error": "PIC not found"}), 404
    return jsonify(
        {
            "ok": True,
            "name": result.get("name"),
            "removed_count": result.get("removed_count", 0),
            "message": f"Removed {result.get('name') or 'PIC'}",
        }
    )
