"""On-time delivery report - process sheets vs PO due date."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .on_time_delivery import PP_TYPES, aggregate_on_time_delivery, collapse_to_process_sheets, parse_month_basis
from .sales_report_route import _fetch_ytd_report
from .utils import compact_text

logger = logging.getLogger(__name__)

on_time_delivery_bp = Blueprint("on_time_delivery", __name__)


def _parse_year_arg() -> int:
    year_raw = compact_text(request.args.get("year"))
    today = datetime.now().date()
    try:
        year = int(year_raw) if year_raw else today.year
    except ValueError as exc:
        raise ValueError("year must be an integer") from exc
    if year < 2000 or year > 2100:
        raise ValueError("year out of supported range")
    return year


def _parse_pp_types_arg() -> list[str]:
    raw = compact_text(request.args.get("pp_types"))
    if not raw:
        return ["APS", "NPS"]
    if raw.upper() == "ALL":
        return list(PP_TYPES)
    parts = [item.strip().upper() for item in raw.split(",") if item.strip()]
    allowed = set(PP_TYPES)
    selected = [item for item in parts if item in allowed]
    return selected or ["APS", "NPS"]


def _parse_sales_persons_arg() -> list[str]:
    raw = compact_text(
        request.args.get("sales_persons") or request.args.get("sales_person")
    )
    if not raw or raw.upper() == "ALL":
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def build_report_payload(
    *,
    year: int,
    pp_types: list[str],
    month_basis: str,
    sales_persons: list[str] | None = None,
    refresh: bool = False,
) -> dict[str, Any]:
    ytd = _fetch_ytd_report(year, refresh=refresh)
    shipments = ytd.get("shipments_attributed") or ytd.get("shipments") or []
    collapsed = collapse_to_process_sheets(shipments)
    return aggregate_on_time_delivery(
        shipments,
        year=year,
        pp_types=pp_types,
        month_basis=month_basis,
        sales_persons=sales_persons,
        collapsed=collapsed,
    )


@on_time_delivery_bp.get("/on-time-delivery")
def on_time_delivery_page():
    return render_template("on_time_delivery.html", active="on_time_delivery")


@on_time_delivery_bp.get("/api/on-time-delivery/report")
def api_on_time_delivery_report():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    month_basis = parse_month_basis(request.args.get("month_basis") or request.args.get("basis"))
    try:
        year = _parse_year_arg()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    pp_types = _parse_pp_types_arg()
    sales_persons = _parse_sales_persons_arg()
    try:
        data = build_report_payload(
            year=year,
            pp_types=pp_types,
            month_basis=month_basis,
            sales_persons=sales_persons,
            refresh=refresh,
        )
    except Exception as exc:
        logger.exception("on-time delivery report query failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502
    return jsonify(
        {
            "ok": True,
            "cached_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
            **data,
        }
    )
