"""First Article Tracker - ARCHIVE view for flagged process sheets."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from .first_article_service import (
    add_pic,
    delete_pic,
    flag_process_sheet,
    json_error,
    list_tracker_rows,
    load_pics,
    search_flag_candidates,
    unflag_process_sheet,
    update_tracker_row,
)
from .helpers import planner_db
from .utils import compact_text

logger = logging.getLogger(__name__)

first_article_bp = Blueprint("first_article", __name__)

_PATCH_FIELDS = (
    "pic_ids",
    "remarks",
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


@first_article_bp.get("/archive/first-article")
def first_article_page():
    return render_template("first_article.html", active="first_article")


@first_article_bp.get("/api/first-article")
def api_list_first_article():
    try:
        with planner_db() as con:
            pics = load_pics(con)
        rows = list_tracker_rows()
    except Exception as exc:
        logger.exception("first article list failed")
        payload, status = json_error(exc)
        return jsonify(payload), status
    return jsonify({"ok": True, "count": len(rows), "rows": rows, "pics": pics})


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
