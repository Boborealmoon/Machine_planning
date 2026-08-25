"""SO outstanding balance page - open S/O line values and remaining balance."""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from .so_outstanding_balance_service import (
    build_outstanding_balance,
    pricing_keys_from_orders,
    restrict_orders_to_open_so_lines,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

so_outstanding_balance_bp = Blueprint("so_outstanding_balance", __name__)


def _fetch_open_so_lines(*, refresh: bool = False) -> list[dict] | None:
    """ERP outstanding S/O lines (remaining qty > 0, header not void)."""
    from .sales_report_route import _SO_LINES_SQL
    from .staged_erp import STAGED_SO_LINES_SQL, fetch_rows

    # Refresh hits live COMAIN so recently shipped lines drop immediately.
    domain = "sales_orders" if refresh else None
    try:
        return fetch_rows(STAGED_SO_LINES_SQL, live_sql=_SO_LINES_SQL, domain=domain)
    except Exception:
        logger.exception("open S/O line lookup failed")
        if domain:
            try:
                return fetch_rows(STAGED_SO_LINES_SQL, live_sql=_SO_LINES_SQL)
            except Exception:
                logger.exception("open S/O line staging fallback failed")
        return None


@so_outstanding_balance_bp.get("/so-outstanding-balance")
def so_outstanding_balance_page():
    return render_template("so_outstanding_balance.html", active="so_outstanding_balance")


@so_outstanding_balance_bp.get("/api/so-outstanding-balance")
def api_so_outstanding_balance():
    refresh = compact_text(request.args.get("refresh")).lower() in ("1", "true", "yes")
    try:
        from .process_sheets import fetch_so_line_pricing_map
        from .sales_orders_route import _fetch_sales_orders, _job_count

        payload = _fetch_sales_orders(refresh=refresh, active_only=True)
        orders = list(payload.get("active") or [])
        open_so_lines = _fetch_open_so_lines(refresh=refresh)
        if open_so_lines:
            orders = restrict_orders_to_open_so_lines(orders, open_so_lines)
        pricing = fetch_so_line_pricing_map(pricing_keys_from_orders(orders))
        result = build_outstanding_balance(orders, pricing)
        result["active_job_count"] = _job_count(orders)
        return jsonify(result)
    except Exception as exc:
        logger.exception("so outstanding balance failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
