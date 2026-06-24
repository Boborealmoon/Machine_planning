"""Preferred machines archive — live planner routing + completion history."""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .helpers import planner_db
from .preferred_machines_service import fetch_preferred_machines_archive
from .utils import compact_text

logger = logging.getLogger(__name__)

preferred_machines_bp = Blueprint("preferred_machines", __name__)

_CACHE_TTL_SEC = 60
_cache: tuple[float, list[dict[str, Any]]] | None = None


def invalidate_preferred_machines_cache() -> None:
    global _cache
    _cache = None


def _fetch_preferred_machines(*, refresh: bool = False, reconcile: bool = False) -> dict[str, Any]:
    global _cache
    now = time.time()
    if not refresh and not reconcile and _cache and now - _cache[0] < _CACHE_TTL_SEC:
        items = _cache[1]
        cached_at = _cache[0]
    else:
        with planner_db() as con:
            items = fetch_preferred_machines_archive(con, reconcile=refresh or reconcile)
        _cache = (now, items)
        cached_at = now

    missing_groups = sum(1 for item in items if item["missing_preferred_count"] > 0)
    mismatch_groups = sum(1 for item in items if item["erp_mismatch_count"] > 0)
    history_groups = sum(1 for item in items if item["history_machine_count"] > 0)

    return {
        "ok": True,
        "count": len(items),
        "rows": items,
        "stats": {
            "group_count": len(items),
            "missing_preferred_groups": missing_groups,
            "erp_mismatch_groups": mismatch_groups,
            "history_groups": history_groups,
            "total_machining_ops": sum(item["machining_op_count"] for item in items),
        },
        "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
        "cache_ttl_sec": _CACHE_TTL_SEC,
    }


@preferred_machines_bp.get("/preferred-machines")
def preferred_machines_page():
    return render_template("preferred_machines.html", active="preferred_machines")


@preferred_machines_bp.get("/api/preferred-machines")
def api_preferred_machines():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    reconcile = compact_text(request.args.get("reconcile")).lower() in {"1", "true", "yes", "on"}
    try:
        return jsonify(_fetch_preferred_machines(refresh=refresh, reconcile=reconcile))
    except Exception as exc:
        logger.exception("preferred machines query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
