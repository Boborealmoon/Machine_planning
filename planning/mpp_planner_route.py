"""MPP planner — multi-pallet round blocks for the full MPP fleet (incl. CNC 41)."""
from __future__ import annotations

import logging
from datetime import datetime

from flask import Blueprint, jsonify, render_template, request

from db import planner_db_connect_error
from .helpers import planner_db
from .mpp_planner_queue_service import (
    _recover_db_transaction,
    load_mpp_planner_queue,
    mpp_auto_dequeue_on_page_load,
    recalculate_mpp_planner_machines,
    save_mpp_planner_queue,
)
from .mpp_planner_service import (
    fetch_mpp_planner_intake_meta,
    fetch_mpp_planner_jobs,
    fetch_mpp_planner_machines,
)

logger = logging.getLogger(__name__)

mpp_planner_bp = Blueprint("mpp_planner", __name__)

MPP_PLANNER_PATH = "/mpp-planner"
MPP_PLANNER_LEGACY_PATH = "/archive/mpp-planner"


@mpp_planner_bp.get(MPP_PLANNER_PATH)
@mpp_planner_bp.get(MPP_PLANNER_LEGACY_PATH)
def mpp_planner_page():
    return render_template("mpp_planner.html", active="mpp_planner")


@mpp_planner_bp.get("/api/mpp-planner/machines")
def api_mpp_planner_machines():
    try:
        with planner_db() as con:
            machines = fetch_mpp_planner_machines(con)
        return jsonify({"ok": True, "count": len(machines), "machines": machines})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("mpp planner machines query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mpp_planner_bp.get("/api/mpp-planner/jobs")
def api_mpp_planner_jobs():
    try:
        with planner_db() as con:
            jobs = fetch_mpp_planner_jobs(con)
            meta = fetch_mpp_planner_intake_meta(con)
        return jsonify({
            "ok": True,
            "count": len(jobs),
            "source": "frame_agreement",
            "fetched_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
            "frame_agreement_part_count": meta.get("frameAgreementPartCount", 0),
            "jobs": jobs,
        })
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("mpp planner jobs query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mpp_planner_bp.get("/api/mpp-planner/queue")
def api_mpp_planner_queue_get():
    try:
        with planner_db() as con:
            queue = load_mpp_planner_queue(con)
            try:
                deq = mpp_auto_dequeue_on_page_load(con)
                if int((deq or {}).get("dequeued") or 0) > 0:
                    queue = load_mpp_planner_queue(con)
            except Exception as exc:
                logger.warning("mpp planner auto-dequeue skipped: %s", exc)
                _recover_db_transaction(con)
        return jsonify({"ok": True, **queue})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("mpp planner queue load failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mpp_planner_bp.post("/api/mpp-planner/recalculate")
def api_mpp_planner_recalculate():
    try:
        data = request.get_json(silent=True) or {}
        machine_ids = data.get("machine_ids") or data.get("machineIds")
        ids = sorted({int(mid) for mid in (machine_ids or []) if int(mid or 0) > 0})
        if not ids:
            return jsonify({"ok": True, "recalculated": 0, "machineIds": [], "warnings": []})
        with planner_db() as con:
            result = recalculate_mpp_planner_machines(con, ids)
        return jsonify({"ok": True, **result})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("mpp planner recalculate failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mpp_planner_bp.put("/api/mpp-planner/queue")
@mpp_planner_bp.post("/api/mpp-planner/queue")
def api_mpp_planner_queue_save():
    try:
        payload = request.get_json(silent=True) or {}
        with planner_db() as con:
            result = save_mpp_planner_queue(con, payload)
        return jsonify({"ok": True, **result})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("mpp planner queue save failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
