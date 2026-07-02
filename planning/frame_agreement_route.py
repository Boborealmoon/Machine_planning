"""Frame agreement parts — master data under Queries & Master Data."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error
from .frame_agreement_service import (
    add_frame_agreement_part,
    delete_frame_agreement_part,
    enrich_frame_agreement_part,
    fetch_frame_agreement_part_preview,
    list_frame_agreement_parts,
    search_frame_agreement_parts,
    update_frame_agreement_part,
)
from .helpers import planner_db
from .sales_orders_route import invalidate_sales_orders_cache
from .utils import compact_text
logger = logging.getLogger(__name__)

frame_agreement_bp = Blueprint("frame_agreement", __name__)


def _erp_db_query(sql, params=(), fetchone=False, fetchall=False):
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if fetchone:
                return cur.fetchone()
            if fetchall:
                return cur.fetchall()
            return None
    finally:
        release_conn(conn)


@frame_agreement_bp.get("/planning-data/frame-agreement-parts")
def frame_agreement_parts_page():
    return render_template("planning_data/frame_agreement_parts.html", active="planning_data")


@frame_agreement_bp.get("/api/planning-data/frame-agreement-parts")
def api_list_frame_agreement_parts():
    action = compact_text(request.args.get("action")).lower()
    if action == "search":
        search = compact_text(request.args.get("q"))
        if not search:
            return jsonify({"ok": True, "rows": []})
        try:
            hits = search_frame_agreement_parts(_erp_db_query, search)
            return jsonify({"ok": True, "rows": hits})
        except Exception as exc:
            logger.exception("frame agreement part search failed")
            return jsonify({"ok": False, "error": str(exc)}), 500

    if action == "preview":
        part_no = compact_text(request.args.get("part_no"))
        bom_code = compact_text(request.args.get("bom"))
        if not part_no:
            return jsonify({"ok": False, "error": "part_no is required"}), 400
        try:
            preview = fetch_frame_agreement_part_preview(_erp_db_query, part_no, bom_code or None)
            return jsonify({"ok": True, "preview": preview})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            logger.exception("frame agreement part preview failed")
            return jsonify({"ok": False, "error": str(exc)}), 500

    search = compact_text(request.args.get("q"))
    enrich = compact_text(request.args.get("enrich")).lower() in {"1", "true", "yes"}
    try:
        with planner_db() as con:
            rows_out = list_frame_agreement_parts(con, search=search)
        if enrich and rows_out:
            rows_out = [enrich_frame_agreement_part(_erp_db_query, row) for row in rows_out]
        return jsonify({"ok": True, "count": len(rows_out), "rows": rows_out})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("frame agreement parts list failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@frame_agreement_bp.get("/api/planning-data/frame-agreement-parts/part-search")
def api_search_frame_agreement_parts():
    search = compact_text(request.args.get("q"))
    if not search:
        return jsonify({"ok": True, "rows": []})
    try:
        hits = search_frame_agreement_parts(_erp_db_query, search)
        return jsonify({"ok": True, "rows": hits})
    except Exception as exc:
        logger.exception("frame agreement part search failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@frame_agreement_bp.get("/api/planning-data/frame-agreement-parts/part-preview")
def api_preview_frame_agreement_part():
    part_no = compact_text(request.args.get("part_no"))
    bom_code = compact_text(request.args.get("bom"))
    if not part_no:
        return jsonify({"ok": False, "error": "part_no is required"}), 400
    try:
        preview = fetch_frame_agreement_part_preview(_erp_db_query, part_no, bom_code or None)
        return jsonify({"ok": True, "preview": preview})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("frame agreement part preview failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@frame_agreement_bp.post("/api/planning-data/frame-agreement-parts")
def api_add_frame_agreement_part():
    data = request.get_json(force=True, silent=True) or {}
    part_no = compact_text(data.get("part_no"))
    notes = compact_text(data.get("notes"))
    if not part_no:
        return jsonify({"ok": False, "error": "part_no is required"}), 400
    try:
        with planner_db() as con:
            row = add_frame_agreement_part(con, part_no, notes=notes)
        invalidate_sales_orders_cache()
        return jsonify({"ok": True, "row": row})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("frame agreement part add failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@frame_agreement_bp.patch("/api/planning-data/frame-agreement-parts/<path:part_no>")
def api_update_frame_agreement_part(part_no: str):
    data = request.get_json(force=True, silent=True) or {}
    notes = data.get("notes")
    if notes is None:
        return jsonify({"ok": False, "error": "notes is required"}), 400
    try:
        with planner_db() as con:
            row = update_frame_agreement_part(con, part_no, notes=compact_text(notes))
        if not row:
            return jsonify({"ok": False, "error": "Part not found"}), 404
        invalidate_sales_orders_cache()
        return jsonify({"ok": True, "row": row})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("frame agreement part update failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@frame_agreement_bp.delete("/api/planning-data/frame-agreement-parts/<path:part_no>")
def api_delete_frame_agreement_part(part_no: str):
    try:
        with planner_db() as con:
            deleted = delete_frame_agreement_part(con, part_no)
        if not deleted:
            return jsonify({"ok": False, "error": "Part not found"}), 404
        invalidate_sales_orders_cache()
        return jsonify({"ok": True, "part_no": compact_text(part_no)})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("frame agreement part delete failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
