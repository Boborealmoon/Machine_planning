"""Inbound and outbound shipment lists for Supply Chain View.

Mirrors the COMAIN Incoming / Outgoing Shipment tabs:

  outstanding  open headers that do not yet have a GRN (inbound stage B)
  grn          open inbound headers that already have a GRN (stage G)
  history      posted headers that were not cancelled
  cancelled    posted headers with status X
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, request

from .staged_erp import live_query
from .utils import compact_text

logger = logging.getLogger(__name__)

logistics_shipment_bp = Blueprint("logistics_shipment", __name__)

_CACHE_TTL_SEC = 300
_HISTORY_LIMIT = 500
_IN_BUCKETS = ("outstanding", "grn", "history", "cancelled")
_OUT_BUCKETS = ("outstanding", "history", "cancelled")
_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}

_IN_SELECT = """
SELECT
    h.shipment_voucher_no,
    h.grn_no,
    h.source_voucher_no,
    h.supplier_do_no,
    h.shipment_date,
    h.arrival_date,
    h.goods_receipt_date,
    COALESCE(pr.shm_priority_desc, h.priority) AS priority,
    COALESCE(m.shm_mode_desc, h.shm_mode_code) AS mode,
    h.subject,
    h.reference_no,
    COALESCE(loc.location_name, h.receiving_location_code) AS location_name,
    COALESCE(p.party_name, h.party_code) AS party_name,
    COALESCE(cu.alias, h.created_by) AS created_by_name,
    h.created_datetime,
    COALESCE(uu.alias, h.last_updated_by) AS last_updated_by_name,
    h.last_updated_datetime,
    h.sbu_code
"""

_OUT_SELECT = """
SELECT
    h.shipment_voucher_no,
    h.do_no,
    h.invoice_no,
    h.source_voucher_no,
    h.shipment_date,
    h.arrival_date,
    h.shipment_date_actual,
    COALESCE(pr.shm_priority_desc, h.priority) AS priority,
    COALESCE(m.shm_mode_desc, h.shm_mode_code) AS mode,
    h.subject,
    h.reference_no,
    COALESCE(loc.location_name, h.ship_to_location_code) AS location_name,
    COALESCE(p.party_name, h.party_code) AS party_name,
    COALESCE(cu.alias, h.created_by) AS created_by_name,
    h.created_datetime,
    COALESCE(uu.alias, h.last_updated_by) AS last_updated_by_name,
    h.last_updated_datetime,
    h.sbu_code
"""

_JOINS = """
LEFT JOIN public.mt_party p
  ON p.party_code = h.party_code
LEFT JOIN public.mt_shm_mode m
  ON m.shm_mode_code = h.shm_mode_code
LEFT JOIN public.mt_shm_priority pr
  ON pr.shm_priority_code = h.priority
LEFT JOIN public.mt_user cu
  ON cu.user_id = h.created_by
LEFT JOIN public.mt_user uu
  ON uu.user_id = h.last_updated_by
"""


def invalidate_logistics_shipment_cache() -> None:
    _cache.clear()


def buckets_for(direction: str) -> tuple[str, ...]:
    return _IN_BUCKETS if direction == "in" else _OUT_BUCKETS


def header_table(direction: str, bucket: str) -> str:
    if direction == "in":
        if bucket in {"history", "cancelled"}:
            return "public.lg_in_shm_hst_hdr"
        return "public.lg_in_shm_ost_hdr"
    if bucket in {"history", "cancelled"}:
        return "public.lg_out_shm_hst_hdr"
    return "public.lg_out_shm_ost_hdr"


def bucket_where(direction: str, bucket: str) -> str:
    if bucket == "cancelled":
        return "COALESCE(BTRIM(h.status), '') = 'X'"
    if bucket == "history":
        return "COALESCE(BTRIM(h.status), '') <> 'X'"
    if direction == "in" and bucket == "grn":
        return "h.shipment_stage = 'G'"
    if direction == "in":
        return "COALESCE(h.shipment_stage, '') <> 'G'"
    return "TRUE"


def _location_join(direction: str) -> str:
    column = "h.receiving_location_code" if direction == "in" else "h.ship_to_location_code"
    return f"LEFT JOIN public.mt_location loc ON loc.location_code = {column}"


def rows_sql(direction: str, bucket: str) -> str:
    select = _IN_SELECT if direction == "in" else _OUT_SELECT
    table = header_table(direction, bucket)
    where = bucket_where(direction, bucket)
    limit = f"\nLIMIT {_HISTORY_LIMIT}" if bucket == "history" else ""
    return (
        f"{select}\nFROM {table} h\n{_JOINS}{_location_join(direction)}\n"
        f"WHERE {where}\n"
        "ORDER BY h.created_datetime DESC NULLS LAST, h.shipment_voucher_no"
        f"{limit}"
    )


def _count_sql(table: str, where: str) -> str:
    return f"SELECT COUNT(*) AS n FROM {table} h WHERE {where}"


def _count_pair(table: str, open_where: str, closed_where: str) -> dict[str, int]:
    sql = f"""
    SELECT
        COUNT(*) FILTER (WHERE {open_where}) AS open_n,
        COUNT(*) FILTER (WHERE {closed_where}) AS closed_n
    FROM {table} h
    """
    row = live_query(sql, timeout_ms=30000)
    payload = row[0] if row else {}
    return {
        "open": int(payload.get("open_n") or 0),
        "closed": int(payload.get("closed_n") or 0),
    }


def fetch_counts(direction: str) -> dict[str, int]:
    if direction == "in":
        ost = _count_pair(
            "public.lg_in_shm_ost_hdr",
            bucket_where("in", "outstanding"),
            bucket_where("in", "grn"),
        )
        hst = _count_pair(
            "public.lg_in_shm_hst_hdr",
            bucket_where("in", "history"),
            bucket_where("in", "cancelled"),
        )
        return {
            "outstanding": ost["open"],
            "grn": ost["closed"],
            "history": hst["open"],
            "cancelled": hst["closed"],
        }
    hst = _count_pair(
        "public.lg_out_shm_hst_hdr",
        bucket_where("out", "history"),
        bucket_where("out", "cancelled"),
    )
    outstanding = live_query(
        _count_sql("public.lg_out_shm_ost_hdr", bucket_where("out", "outstanding")),
        timeout_ms=30000,
    )
    return {
        "outstanding": int((outstanding[0] if outstanding else {}).get("n") or 0),
        "history": hst["open"],
        "cancelled": hst["closed"],
    }


def fetch_bucket(direction: str, bucket: str, *, refresh: bool = False) -> dict[str, Any]:
    key = (direction, bucket)
    now = time.time()
    cached = _cache.get(key)
    if not refresh and cached and (now - cached[0]) < _CACHE_TTL_SEC:
        payload = dict(cached[1])
        payload["counts"] = fetch_counts(direction)
        return payload

    counts = fetch_counts(direction)
    rows = live_query(rows_sql(direction, bucket), timeout_ms=60000)
    total = int(counts.get(bucket) or 0)
    payload = {
        "rows": rows,
        "count": len(rows),
        "total": total,
        "truncated": bucket == "history" and total > len(rows),
        "counts": counts,
        "source": header_table(direction, bucket),
        "cached_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
    }
    _cache[key] = (now, payload)
    return payload


@logistics_shipment_bp.get("/api/material-tracking/shipments")
def api_logistics_shipments():
    direction = compact_text(request.args.get("direction")).lower()
    bucket = compact_text(request.args.get("bucket")).lower() or "outstanding"
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}

    if direction not in {"in", "out"}:
        return jsonify({"error": "direction must be in or out"}), 400
    if bucket not in buckets_for(direction):
        return jsonify({"error": f"invalid bucket '{bucket}'"}), 400

    try:
        payload = fetch_bucket(direction, bucket, refresh=refresh)
    except Exception as exc:
        logger.exception("logistics shipment ERP query failed (%s/%s)", direction, bucket)
        return jsonify({"error": f"ERP query failed: {exc}"}), 502

    return jsonify(
        {
            "ok": True,
            "direction": direction,
            "bucket": bucket,
            "source": payload["source"],
            "count": payload["count"],
            "total": payload["total"],
            "truncated": payload["truncated"],
            "counts": payload["counts"],
            "cached_at": payload["cached_at"],
            "cache_ttl_sec": _CACHE_TTL_SEC,
            "rows": payload["rows"],
        }
    )
