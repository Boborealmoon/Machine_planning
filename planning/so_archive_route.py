"""SO Line Archive - ARCHIVE standalone view of SO/PP/shipment lines by PS bucket."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, render_template, request

from .so_archive_service import (
    ARCHIVE_COLUMNS,
    PS_BUCKETS,
    bucket_counts,
    build_recent_notifications,
    filter_by_buckets,
    group_rows_by_sales_order,
    shape_archive_rows,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

so_archive_bp = Blueprint("so_archive", __name__)

_DEFAULT_LOOKBACK_DAYS = 60
_MAX_LOOKBACK_DAYS = 366
_RECENT_LIMIT = 10
_DEFAULT_BUCKETS = ("APS", "NPS")


def _parse_buckets() -> list[str]:
    """Accept buckets=APS,NPS or legacy bucket=APS / bucket=ALL."""
    raw_multi = compact_text(request.args.get("buckets"))
    if raw_multi:
        parsed = [
            compact_text(part).upper()
            for part in raw_multi.split(",")
            if compact_text(part)
        ]
        return [b for b in parsed if b in PS_BUCKETS] or list(_DEFAULT_BUCKETS)

    legacy = compact_text(request.args.get("bucket")).upper()
    if legacy == "ALL":
        return list(PS_BUCKETS)
    if legacy in PS_BUCKETS:
        return [legacy]
    return list(_DEFAULT_BUCKETS)


def _parse_iso_date(raw: str | None, field: str) -> date | None:
    text = compact_text(raw)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).date()
    except ValueError as exc:
        raise ValueError(f"{field} must be YYYY-MM-DD") from exc


def _default_range() -> tuple[date, date]:
    to_d = date.today()
    from_d = to_d - timedelta(days=_DEFAULT_LOOKBACK_DAYS - 1)
    return from_d, to_d


def _resolve_range() -> tuple[date, date]:
    from_raw = compact_text(request.args.get("from"))
    to_raw = compact_text(request.args.get("to"))
    days_raw = compact_text(request.args.get("days"))

    if from_raw or to_raw:
        from_d = _parse_iso_date(from_raw, "from")
        to_d = _parse_iso_date(to_raw, "to")
        if from_d is None or to_d is None:
            raise ValueError("from and to are required together")
        if to_d < from_d:
            from_d, to_d = to_d, from_d
        if (to_d - from_d).days > _MAX_LOOKBACK_DAYS:
            from_d = to_d - timedelta(days=_MAX_LOOKBACK_DAYS)
        return from_d, to_d

    if days_raw:
        try:
            days = max(1, min(_MAX_LOOKBACK_DAYS, int(days_raw)))
        except ValueError as exc:
            raise ValueError("days must be an integer") from exc
        to_d = date.today()
        return to_d - timedelta(days=days - 1), to_d

    return _default_range()


@so_archive_bp.get("/archive/so-lines")
def so_archive_page():
    return render_template("so_archive.html", active="so_archive")


@so_archive_bp.get("/api/archive/so-lines")
def api_so_archive():
    refresh = compact_text(request.args.get("refresh")).lower() in ("1", "true", "yes")
    buckets = _parse_buckets()

    try:
        from_d, to_d = _resolve_range()
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    try:
        from .new_orders_route import _fetch_new_orders

        raw_rows = _fetch_new_orders(from_d, to_d, refresh=refresh)
    except Exception as exc:
        logger.exception("so archive ERP query failed")
        return jsonify({"ok": False, "error": f"ERP query failed: {exc}"}), 502

    shaped = shape_archive_rows(raw_rows)
    filtered = filter_by_buckets(shaped, buckets)
    groups = group_rows_by_sales_order(filtered)
    recent = build_recent_notifications(
        shaped,
        buckets=buckets,
        limit=_RECENT_LIMIT,
    )

    return jsonify(
        {
            "ok": True,
            "from": from_d.isoformat(),
            "to": to_d.isoformat(),
            "buckets": buckets,
            "columns": list(ARCHIVE_COLUMNS),
            "counts": bucket_counts(shaped),
            "count": len(filtered),
            "group_count": len(groups),
            "recent_limit": _RECENT_LIMIT,
            "recent": recent,
            "groups": groups,
            "rows": filtered,
        }
    )
