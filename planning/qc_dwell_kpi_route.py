"""KPI page: QC dwell from the QAQC Pushed to QC column."""
from __future__ import annotations

import logging
from datetime import datetime

from flask import Blueprint, jsonify, render_template, request

from planning.finishing_queue_service import ensure_finishing_queue_tables
from planning.helpers import planner_db
from planning.qc_dwell_kpi import build_qc_dwell_report, fetch_qc_dwell_rows
from planning.so_kpi import build_so_kpi
from planning.utils import PLANNER_TZ, compact_text

logger = logging.getLogger(__name__)

qc_dwell_kpi_bp = Blueprint("qc_dwell_kpi", __name__)

_STATUSES = {"all", "in_qc", "left_qc", "left_unstamped", "before_qc"}


def _parse_date(raw: str):
    text = compact_text(raw)
    if not text:
        return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _parse_min_days(raw: str):
    text = compact_text(raw)
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if value < 0:
        return None
    return value


def _filters() -> dict:
    status = compact_text(request.args.get("status")).lower() or "all"
    if status not in _STATUSES:
        status = "all"
    include_raw = compact_text(request.args.get("include_open")).lower()
    include_open = include_raw not in {"0", "false", "no", "off"}
    return {
        "from_date": _parse_date(request.args.get("from") or ""),
        "to_date": _parse_date(request.args.get("to") or ""),
        "include_open": include_open,
        "status": status,
        "query": compact_text(request.args.get("q")),
        "min_days": _parse_min_days(request.args.get("min_days") or ""),
    }


@qc_dwell_kpi_bp.get("/kpi")
def kpi_page():
    return render_template("kpi.html", active="kpi")


@qc_dwell_kpi_bp.get("/api/kpi/qc-dwell")
def api_qc_dwell():
    filters = _filters()
    try:
        with planner_db() as con:
            ensure_finishing_queue_tables(con)
            raw = fetch_qc_dwell_rows(
                con,
                from_date=filters["from_date"],
                to_date=filters["to_date"],
                include_open=filters["include_open"],
            )
        report = build_qc_dwell_report(
            raw,
            now=datetime.now(PLANNER_TZ),
            **filters,
        )
        report["filters"] = {
            "from": filters["from_date"].isoformat() if filters["from_date"] else "",
            "to": filters["to_date"].isoformat() if filters["to_date"] else "",
            "include_open": filters["include_open"],
            "status": filters["status"],
            "q": filters["query"],
            "min_days": filters["min_days"],
        }
        return jsonify(report)
    except Exception as exc:
        logger.exception("qc dwell kpi failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@qc_dwell_kpi_bp.get("/api/kpi/so-management")
def api_so_management():
    try:
        from planning.sales_orders_route import _fetch_sales_orders

        payload = _fetch_sales_orders(active_only=True)
        return jsonify(build_so_kpi(payload.get("active") or []))
    except Exception as exc:
        logger.exception("so management kpi failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
