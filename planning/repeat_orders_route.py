"""Repeat order consolidation — process sheets grouped by part_no + BOM with program info."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from flask import Blueprint, jsonify, render_template, request

from .helpers import planner_db, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

repeat_orders_bp = Blueprint("repeat_orders", __name__)

_KNOWN_PS_TYPES = frozenset({"MPS", "APS", "NPS", "PPS", "CPS", "SR"})


def _ps_type(ps_id: str) -> str:
    raw = compact_text(ps_id).split("::")[0]
    if "[sr]" in raw.lower():
        return "SR"
    match = re.match(r"^([A-Z]+)", raw.upper())
    if not match:
        return "OTHER"
    prefix = match.group(1)
    if prefix in _KNOWN_PS_TYPES:
        return prefix
    return prefix


_REPEAT_ORDERS_SQL = """
WITH partials AS (
    SELECT
        c.ps_id,
        c.pp_partial_no,
        MAX(c.part_no) AS part_no,
        MAX(c.description) AS part_desc,
        MAX(NULLIF(TRIM(c.bom_code), '')) AS bom_code,
        MIN(c.order_date) AS order_date,
        MIN(c.due_date) AS due_date,
        MAX(c.status) AS status,
        MAX(c.partial_qty) AS partial_qty,
        MAX(c.total_qty) AS total_qty
    FROM pp_vouchers_cache c
    WHERE COALESCE(NULLIF(TRIM(c.part_no), ''), '') <> ''
    GROUP BY c.ps_id, c.pp_partial_no
),
process_sheets AS (
    SELECT
        p.ps_id,
        MAX(p.part_no) AS part_no,
        MAX(p.part_desc) AS part_desc,
        MAX(p.bom_code) AS bom_code,
        MIN(p.order_date) AS order_date,
        MIN(p.due_date) AS due_date,
        MAX(p.status) AS status,
        COALESCE(SUM(p.partial_qty), 0) AS partial_qty,
        MAX(p.total_qty) AS total_qty,
        COUNT(*)::INT AS partial_count
    FROM partials p
    GROUP BY p.ps_id
),
programs AS (
    SELECT
        TRIM(part_no) AS part_no,
        TRIM(bom_code) AS bom_code,
        json_agg(
            json_build_object(
                'stage_no', stage_no,
                'stage_name', stage_name,
                'op_no', op_no,
                'op_type', op_type,
                'program_no', program_no,
                'program_file', program_file,
                'tool_list_file', tool_list_file
            )
            ORDER BY stage_no, op_no NULLS LAST
        ) AS programs
    FROM planner_cycle_time_master
    GROUP BY TRIM(part_no), TRIM(bom_code)
)
SELECT
    p.part_no,
    MAX(p.part_desc) AS part_desc,
    COALESCE(p.bom_code, '') AS bom_code,
    COUNT(*)::INT AS order_count,
    json_agg(
        json_build_object(
            'ps_id', p.ps_id,
            'partial_count', p.partial_count,
            'order_date', p.order_date,
            'due_date', p.due_date,
            'status', p.status,
            'partial_qty', p.partial_qty,
            'total_qty', p.total_qty
        )
        ORDER BY p.order_date DESC NULLS LAST, p.ps_id
    ) AS orders,
    MAX(pr.programs::TEXT) AS programs_json
FROM process_sheets p
LEFT JOIN programs pr
       ON pr.part_no = TRIM(p.part_no)
      AND pr.bom_code = TRIM(COALESCE(p.bom_code, ''))
GROUP BY p.part_no, COALESCE(p.bom_code, '')
ORDER BY COUNT(*) DESC, p.part_no, COALESCE(p.bom_code, '')
"""


def _parse_programs(raw: Any) -> list[dict[str, Any]]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [dict(item) for item in raw]
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return [dict(item) for item in parsed] if isinstance(parsed, list) else []


def _unique_join(values: list[str]) -> str:
    seen: list[str] = []
    for value in values:
        text = compact_text(value)
        if not text or text in seen:
            continue
        seen.append(text)
    return ", ".join(seen)


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    programs = _parse_programs(row.pop("programs_json", None))
    orders = row.get("orders") or []
    if isinstance(orders, str):
        try:
            orders = json.loads(orders)
        except json.JSONDecodeError:
            orders = []

    program_nos = _unique_join([p.get("program_no") for p in programs])
    program_files = _unique_join([p.get("program_file") for p in programs])
    tool_files = _unique_join([p.get("tool_list_file") for p in programs])

    type_counts: dict[str, int] = {}
    for order in orders:
        ps_type = _ps_type(order.get("ps_id") or "")
        order["ps_type"] = ps_type
        type_counts[ps_type] = type_counts.get(ps_type, 0) + 1

    order_count = int(row.get("order_count") or 0)
    return {
        "part_no": compact_text(row.get("part_no")),
        "part_desc": compact_text(row.get("part_desc")),
        "bom_code": compact_text(row.get("bom_code")),
        "order_count": order_count,
        "is_repeat": order_count >= 2,
        "type_counts": type_counts,
        "program_no": program_nos,
        "program_file": program_files,
        "tool_list_file": tool_files,
        "programs": programs,
        "orders": orders,
    }


def _fetch_repeat_orders(*, repeats_only: bool = False) -> dict[str, Any]:
    with planner_db() as con:
        raw_rows = rows(con.execute(_REPEAT_ORDERS_SQL))
    items = [_serialize_row(dict(row)) for row in raw_rows]
    if repeats_only:
        items = [item for item in items if item["is_repeat"]]

    total_orders = sum(item["order_count"] for item in items)
    repeat_groups = sum(1 for item in items if item["is_repeat"])

    return {
        "rows": items,
        "stats": {
            "group_count": len(items),
            "repeat_groups": repeat_groups,
            "total_orders": total_orders,
        },
    }


def api_repeat_orders_payload():
    repeats_only = compact_text(request.args.get("repeats_only")).lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    try:
        payload = _fetch_repeat_orders(repeats_only=repeats_only)
        return jsonify(payload)
    except Exception as exc:
        logger.exception("repeat orders query failed")
        return jsonify({"error": str(exc)}), 500


def _repeat_orders_page():
    return render_template("planning_data/repeat_orders.html", active="repeat_orders")


@repeat_orders_bp.get("/repeat-orders")
@repeat_orders_bp.get("/planning-data/repeat-orders")
def repeat_orders_page():
    return _repeat_orders_page()


@repeat_orders_bp.get("/api/planning-data/repeat-orders")
def api_repeat_orders():
    return api_repeat_orders_payload()
