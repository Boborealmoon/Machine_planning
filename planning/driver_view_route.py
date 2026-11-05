"""Driver delivery schedule view — read-only shop-floor page (no passcode)."""
from __future__ import annotations

import logging
import os
from datetime import date

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

from .delivery_commitment_service import (
    SHOP_PLAN_PS_TYPES,
    apply_okay_flags,
    build_commitment_view,
    load_commitments,
    load_okay_row_ids,
    plan_month_label,
    shop_month_work_lines,
)
from .first_article_service import attach_program_pic_labels
from .helpers import planner_db

logger = logging.getLogger(__name__)

_DEFAULT_DRIVER_VIEW_PATH = "/delivery-schedule-view"
_LEGACY_DRIVER_VIEW_PATH = "/driver-view"


def driver_view_path() -> str:
    raw = (os.getenv("DRIVER_VIEW_PATH") or _DEFAULT_DRIVER_VIEW_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


DRIVER_VIEW_PATH = driver_view_path()


def driver_view_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "driver_view.js"),
        os.path.join(root, "static", "css", "driver_view.css"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"driver-{int(mt)}"
    except OSError:
        return "driver-dev"


driver_view_bp = Blueprint("driver_view", __name__)


@driver_view_bp.get(DRIVER_VIEW_PATH)
def driver_view_page():
    return render_template(
        "driver_view.html",
        active="driver_view",
        driver_asset_version=driver_view_asset_version(),
    )


if DRIVER_VIEW_PATH != _LEGACY_DRIVER_VIEW_PATH:

    @driver_view_bp.get(_LEGACY_DRIVER_VIEW_PATH)
    def driver_view_legacy_redirect():
        return redirect(url_for("driver_view.driver_view_page"), code=301)


def _refresh_flag() -> bool:
    return (request.args.get("refresh") or "").strip().lower() in ("1", "true", "yes", "on")


@driver_view_bp.get("/api/trial/delivery-schedule/month-plan")
def api_driver_month_plan():
    """This month's delivery plan for the shop floor. Work fields only — no prices."""
    today = date.today()
    month = f"{today.year:04d}-{today.month:02d}"
    try:
        from .monthly_delivery_plan_route import _load_outstanding

        lines, _job_count = _load_outstanding(refresh=_refresh_flag(), year=today.year)
        with planner_db() as con:
            commitments = load_commitments(con)
            okay_ids = load_okay_row_ids(con)
            view = build_commitment_view(lines, commitments, year=today.year)
            joined = view.get("lines") or []
            apply_okay_flags(joined, okay_ids)
            attach_program_pic_labels(con, joined)
        work = shop_month_work_lines(joined, month, ps_types=SHOP_PLAN_PS_TYPES)
        qty = round(sum(float(row.get("month_qty") or 0) for row in work), 4)
        return jsonify(
            {
                "ok": True,
                "month": month,
                "month_label": plan_month_label(month),
                "ps_types": list(SHOP_PLAN_PS_TYPES),
                "lines": work,
                "summary": {"line_count": len(work), "qty": qty},
            }
        )
    except Exception as exc:
        logger.exception("driver month plan failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
