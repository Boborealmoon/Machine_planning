"""OPS Sheet turnaround page and APIs."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from .ops_sheet_service import (
    OpsSheetError,
    add_extra_column,
    delete_extra_column,
    list_ops_sheets,
    rename_ops_file,
    scan_ops_sheets,
    set_extra_minutes,
    set_operation_count,
    update_extra_column,
    update_line_fields,
)

logger = logging.getLogger(__name__)

ops_sheet_bp = Blueprint("ops_sheets", __name__)

OPS_SHEET_PATH = "/ops-sheets"


@ops_sheet_bp.get(OPS_SHEET_PATH)
def ops_sheet_page():
    return render_template("ops_sheet.html", active="ops_sheets")


@ops_sheet_bp.get("/api/ops-sheets")
def api_ops_sheets():
    try:
        return jsonify(list_ops_sheets())
    except Exception as exc:
        logger.exception("OPS sheet list failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.post("/api/ops-sheets/scan")
def api_ops_sheets_scan():
    try:
        return jsonify(scan_ops_sheets())
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet scan failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.patch("/api/ops-sheets/lines/<int:line_id>")
def api_ops_sheet_line(line_id: int):
    data = request.get_json(silent=True) or {}
    try:
        if isinstance(data.get("fields"), dict):
            return jsonify(update_line_fields(line_id, data["fields"]))
        if "operation_count" not in data:
            return jsonify({"ok": False, "error": "Nothing to save."}), 400
        operation_count = _parse_operation_count(data.get("operation_count"))
        return jsonify(set_operation_count(line_id, operation_count))
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet line update failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.patch("/api/ops-sheets/files/<int:sheet_id>")
def api_ops_sheet_file(sheet_id: int):
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(rename_ops_file(sheet_id, data.get("file_name")))
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet file rename failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.put("/api/ops-sheets/lines/<int:line_id>/extras/<int:column_id>")
def api_ops_sheet_extra(line_id: int, column_id: int):
    data = request.get_json(silent=True) or {}
    if "minutes" not in data:
        return jsonify({"ok": False, "error": "minutes is required."}), 400
    try:
        minutes = _parse_minutes(data.get("minutes"))
        return jsonify(set_extra_minutes(line_id, column_id, minutes))
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet extra minutes update failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.post("/api/ops-sheets/columns")
def api_ops_sheet_add_column():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(add_extra_column(data.get("name") or "", data.get("apply_mode") or "per_piece"))
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet column create failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.patch("/api/ops-sheets/columns/<int:column_id>")
def api_ops_sheet_update_column(column_id: int):
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(update_extra_column(
            column_id,
            data.get("name") if "name" in data else None,
            data.get("apply_mode") if "apply_mode" in data else None,
        ))
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet column update failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.delete("/api/ops-sheets/columns/<int:column_id>")
def api_ops_sheet_delete_column(column_id: int):
    try:
        return jsonify(delete_extra_column(column_id))
    except OpsSheetError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("OPS sheet column delete failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.get("/api/rfq-workflow")
def api_rfq_library():
    from .rfq_workflow import library_payload

    try:
        return jsonify(library_payload(_rfq_team()))
    except Exception as exc:
        logger.exception("RFQ library failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@ops_sheet_bp.post("/api/rfq-workflow/team")
def api_rfq_team():
    from flask import session

    from .rfq_workflow import TEAMS

    data = request.get_json(silent=True) or {}
    team = data.get("team")
    if team not in TEAMS:
        return jsonify({"ok": False, "error": "Choose a team."}), 400
    session["rfq_team"] = team
    session.permanent = True
    return jsonify({"ok": True, "team": team, "label": TEAMS[team]})


@ops_sheet_bp.patch("/api/rfq-workflow/files/<int:sheet_id>")
def api_rfq_header(sheet_id: int):
    from .rfq_workflow import update_header

    data = request.get_json(silent=True) or {}
    return _rfq_call(lambda: update_header(sheet_id, _rfq_team(), data.get("fields") or data))


@ops_sheet_bp.patch("/api/rfq-workflow/lines/<int:line_id>/ops")
def api_rfq_ops(line_id: int):
    from .rfq_workflow import update_ops_line

    data = request.get_json(silent=True) or {}
    return _rfq_call(lambda: update_ops_line(line_id, _rfq_team(), data.get("fields") or {}))


@ops_sheet_bp.patch("/api/rfq-workflow/lines/<int:line_id>/quote")
def api_rfq_quote(line_id: int):
    from .rfq_workflow import update_quote

    data = request.get_json(silent=True) or {}
    return _rfq_call(lambda: update_quote(line_id, _rfq_team(), data.get("fields") or {}))


@ops_sheet_bp.patch("/api/rfq-workflow/lines/<int:line_id>/tat")
def api_rfq_tat(line_id: int):
    from .rfq_workflow import update_tat

    data = request.get_json(silent=True) or {}
    return _rfq_call(lambda: update_tat(line_id, _rfq_team(), data.get("tat_days")))


@ops_sheet_bp.post("/api/rfq-workflow/lines/<int:line_id>/reconfirm")
def api_rfq_reconfirm(line_id: int):
    from .rfq_workflow import reconfirm_line

    return _rfq_call(lambda: reconfirm_line(line_id, _rfq_team()))


@ops_sheet_bp.get("/api/rfq-workflow/files/<int:sheet_id>/price-to-sales")
def api_rfq_price_sheet(sheet_id: int):
    from io import BytesIO

    from flask import send_file

    from .rfq_workflow import RfqWorkflowError, price_to_sales_workbook

    try:
        book, rfq = price_to_sales_workbook(sheet_id)
    except RfqWorkflowError as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("Price to Sales export failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
    buffer = BytesIO()
    book.save(buffer)
    buffer.seek(0)
    name = f"{rfq['rfq_no'] or 'RFQ'} price to sales.xlsx"
    return send_file(
        buffer,
        as_attachment=True,
        download_name=name,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


def _rfq_team() -> str:
    from flask import session

    team = session.get("rfq_team") or "ops"
    if team not in {"ops", "supply_chain", "planning", "sales"}:
        return "ops"
    return team


def _rfq_call(action):
    from .ops_sheet_service import OpsSheetError
    from .rfq_workflow import RfqWorkflowError

    try:
        return jsonify(action())
    except (RfqWorkflowError, OpsSheetError) as exc:
        return jsonify({"ok": False, "error": exc.message}), exc.status
    except Exception as exc:
        logger.exception("RFQ workflow update failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


def _parse_operation_count(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise OpsSheetError("Operations must be a whole number.") from None
    if number < 0 or number > 999 or abs(number - round(number)) > 1e-9:
        raise OpsSheetError("Operations must be a whole number from 0 to 999.")
    return int(round(number))


def _parse_minutes(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise OpsSheetError("Minutes must be a number.") from None
    if number < 0 or number > 1_000_000:
        raise OpsSheetError("Minutes must be between 0 and 1,000,000.")
    return number
