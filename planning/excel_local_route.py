"""API endpoint to serve rows from a local Excel workbook configured via LOCAL_EXCEL_PATH."""
from __future__ import annotations

import logging
import os

from flask import Blueprint, jsonify, render_template, request

from .excel_local import configured_excel_path, read_workbook_cached
from .utils import compact_text

logger = logging.getLogger(__name__)

excel_local_bp = Blueprint("excel_local", __name__)


def _truthy(value: str) -> bool:
    return compact_text(value).lower() in {"1", "true", "yes"}


@excel_local_bp.get("/planning-data/aker-inventory")
def aker_inventory_page():
    return render_template("aker_inventory.html", active="aker_inventory")


@excel_local_bp.get("/api/local-excel")
def api_local_excel():
    path = configured_excel_path()
    if not path:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "LOCAL_EXCEL_PATH is not set in .env",
                    "hint": "Set LOCAL_EXCEL_PATH to an absolute path or a path relative to the app folder.",
                }
            ),
            503,
        )

    sheet = compact_text(request.args.get("sheet")) or None
    if not sheet:
        env_sheet = compact_text(os.getenv("LOCAL_EXCEL_SHEET", ""))
        if env_sheet:
            sheet = env_sheet

    all_sheets_raw = request.args.get("all_sheets")
    if all_sheets_raw is not None:
        all_sheets = _truthy(all_sheets_raw)
    elif _truthy(os.getenv("LOCAL_EXCEL_ALL_SHEETS", "")):
        all_sheets = True
    elif sheet:
        all_sheets = False
    else:
        # No sheet configured — return every sheet (Aker Inventory default).
        all_sheets = True

    if all_sheets:
        sheet = None

    refresh = _truthy(request.args.get("refresh"))

    try:
        payload = read_workbook_cached(
            path,
            sheet=sheet,
            all_sheets=all_sheets,
            refresh=refresh,
        )
    except FileNotFoundError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 404
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 503
    except Exception as exc:
        logger.exception("local excel read failed")
        return jsonify({"ok": False, "error": f"Failed to read workbook: {exc}"}), 500

    return jsonify({"ok": True, **payload})
