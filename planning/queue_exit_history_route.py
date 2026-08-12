"""API for machine lane queue exit history (part × stage × machine)."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from .helpers import planner_db
from .queue_exit_history_service import (
    fetch_queue_exit_history,
    fetch_queue_exit_summary,
    get_cached_queue_exit_history,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

queue_exit_history_bp = Blueprint("queue_exit_history", __name__)


def _query_args() -> dict:
    return {
        "part_no": compact_text(request.args.get("part_no")),
        "bom_code": compact_text(request.args.get("bom_code")),
        "machine_no": compact_text(request.args.get("machine_no")),
        "stage_no": int(request.args.get("stage_no") or 0),
        "source_ps_id": compact_text(request.args.get("source_ps_id") or request.args.get("ps_id")),
        "from_date": compact_text(request.args.get("from") or request.args.get("from_date")),
        "to_date": compact_text(request.args.get("to") or request.args.get("to_date")),
        "limit": int(request.args.get("limit") or 500),
    }


@queue_exit_history_bp.get("/api/queue-exit-history")
def api_queue_exit_history():
    summary = compact_text(request.args.get("summary")).lower() in {"1", "true", "yes", "on"}
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    args = _query_args()
    try:
        if not summary and not refresh:
            cached = get_cached_queue_exit_history(**args)
            if cached is not None:
                return jsonify(
                    {
                        "ok": True,
                        "mode": "events",
                        "count": len(cached),
                        "cached": True,
                        "rows": cached,
                    }
                )

        with planner_db() as con:
            if summary:
                rows_data = fetch_queue_exit_summary(
                    con, **{k: v for k, v in args.items() if k != "source_ps_id"}
                )
                return jsonify(
                    {"ok": True, "mode": "summary", "count": len(rows_data), "rows": rows_data}
                )
            rows_data = fetch_queue_exit_history(con, refresh=refresh, **args)
            return jsonify(
                {
                    "ok": True,
                    "mode": "events",
                    "count": len(rows_data),
                    "cached": False,
                    "rows": rows_data,
                }
            )
    except Exception as exc:
        logger.exception("queue exit history query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
