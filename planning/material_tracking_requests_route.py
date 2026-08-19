"""Material Tracking - standalone part / inventory requests (no process sheet)."""
from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from flask import Blueprint, jsonify, request

from db import planner_db_connect_error
from .helpers import one, planner_db, rows
from .staged_erp import live_query, serialize_row
from .utils import compact_text

logger = logging.getLogger(__name__)

material_tracking_requests_bp = Blueprint("material_tracking_requests", __name__)

_SEARCH_LIMIT = 25
_PATCH_FIELDS = ("part_no", "inventory_code", "description", "qty", "material_subcon", "remarks", "material_delay")

_SEARCH_SQL = """
SELECT
    inventory_code,
    COALESCE(NULLIF(BTRIM(main_desc), ''), '') AS description
FROM public.mt_inventory
WHERE inventory_code IS NOT NULL
  AND BTRIM(inventory_code) <> ''
  AND (
    inventory_code ILIKE %s
    OR main_desc ILIKE %s
  )
ORDER BY
    CASE
        WHEN UPPER(BTRIM(inventory_code)) = UPPER(BTRIM(%s)) THEN 0
        WHEN inventory_code ILIKE %s THEN 1
        ELSE 2
    END,
    inventory_code
LIMIT %s
"""

_LOOKUP_SQL = """
SELECT
    inventory_code,
    COALESCE(NULLIF(BTRIM(main_desc), ''), '') AS description
FROM public.mt_inventory
WHERE UPPER(BTRIM(inventory_code)) = UPPER(BTRIM(%s))
LIMIT 1
"""


def _ensure_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_material_requests (
            request_id       BIGSERIAL    PRIMARY KEY,
            part_no          TEXT         NOT NULL DEFAULT '',
            inventory_code   TEXT         NOT NULL DEFAULT '',
            description      TEXT         NOT NULL DEFAULT '',
            qty              NUMERIC,
            material_subcon  TEXT         NOT NULL DEFAULT '',
            remarks          TEXT         NOT NULL DEFAULT '',
            material_delay   BOOLEAN      NOT NULL DEFAULT FALSE,
            created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            CONSTRAINT planner_material_requests_code_chk
                CHECK (BTRIM(part_no) <> '' OR BTRIM(inventory_code) <> '')
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_material_requests_updated_at
            ON public.planner_material_requests (updated_at DESC)
        """
    )


def _parse_qty(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = compact_text(value)
    if not text:
        return None
    try:
        qty = Decimal(text)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("qty must be a number") from exc
    return qty


def _serialize_request(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    out = serialize_row(dict(row))
    out["request_id"] = int(out.get("request_id") or 0)
    out["part_no"] = compact_text(out.get("part_no"))
    out["inventory_code"] = compact_text(out.get("inventory_code"))
    out["description"] = compact_text(out.get("description"))
    out["material_subcon"] = compact_text(out.get("material_subcon"))
    out["remarks"] = compact_text(out.get("remarks"))
    out["material_delay"] = bool(out.get("material_delay"))
    return out


def _lookup_description(code: str) -> str:
    needle = compact_text(code)
    if not needle:
        return ""
    try:
        hits = live_query(_LOOKUP_SQL, (needle,))
    except Exception as exc:
        logger.warning("material request inventory lookup skipped: %s", exc)
        return ""
    if not hits:
        return ""
    return compact_text(hits[0].get("description"))


def search_inventory(query: str, *, limit: int = _SEARCH_LIMIT) -> list[dict[str, Any]]:
    needle = compact_text(query)
    if not needle:
        return []
    cap = max(1, min(int(limit or _SEARCH_LIMIT), 50))
    like = f"%{needle}%"
    prefix = f"{needle}%"
    try:
        hits = live_query(_SEARCH_SQL, (like, like, needle, prefix, cap))
    except Exception:
        logger.exception("material request inventory search failed")
        raise
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in hits:
        code = compact_text(row.get("inventory_code"))
        key = code.upper()
        if not code or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "part_no": code,
                "inventory_code": code,
                "description": compact_text(row.get("description")),
            }
        )
    return out


def list_requests() -> list[dict[str, Any]]:
    with planner_db() as con:
        _ensure_table(con)
        fetched = rows(
            con.execute(
                """
                SELECT request_id, part_no, inventory_code, description, qty,
                       material_subcon, remarks, material_delay, created_at, updated_at
                FROM public.planner_material_requests
                ORDER BY updated_at DESC, request_id DESC
                """
            )
        )
    return [row for row in (_serialize_request(item) for item in fetched) if row]


def create_request(data: dict[str, Any]) -> dict[str, Any]:
    part_no = compact_text(data.get("part_no"))
    inventory_code = compact_text(data.get("inventory_code"))
    if not part_no and not inventory_code:
        raise ValueError("part_no or inventory_code is required")
    description = compact_text(data.get("description"))
    if not description:
        description = _lookup_description(inventory_code or part_no)
    qty = _parse_qty(data.get("qty"))
    material_subcon = compact_text(data.get("material_subcon"))
    remarks = compact_text(data.get("remarks"))
    material_delay = bool(data.get("material_delay"))

    with planner_db() as con:
        _ensure_table(con)
        row = one(
            con.execute(
                """
                INSERT INTO public.planner_material_requests (
                    part_no, inventory_code, description, qty,
                    material_subcon, remarks, material_delay, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                RETURNING request_id, part_no, inventory_code, description, qty,
                          material_subcon, remarks, material_delay, created_at, updated_at
                """,
                (part_no, inventory_code, description, qty, material_subcon, remarks, material_delay),
            )
        )
    serialized = _serialize_request(row)
    if not serialized:
        raise RuntimeError("Failed to create material request")
    return serialized


def update_request(request_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
    with planner_db() as con:
        _ensure_table(con)
        existing = one(
            con.execute(
                """
                SELECT request_id, part_no, inventory_code, description, qty,
                       material_subcon, remarks, material_delay, created_at, updated_at
                FROM public.planner_material_requests
                WHERE request_id = %s
                """,
                (request_id,),
            )
        )
        if not existing:
            return None
        current = dict(existing)
        if "part_no" in data:
            current["part_no"] = compact_text(data.get("part_no"))
        if "inventory_code" in data:
            current["inventory_code"] = compact_text(data.get("inventory_code"))
        if "description" in data:
            current["description"] = compact_text(data.get("description"))
        if "qty" in data:
            current["qty"] = _parse_qty(data.get("qty"))
        if "material_subcon" in data:
            current["material_subcon"] = compact_text(data.get("material_subcon"))
            if compact_text(current["material_subcon"]).upper() == "ARRIVED":
                current["material_delay"] = False
        if "remarks" in data:
            current["remarks"] = compact_text(data.get("remarks"))
        if "material_delay" in data:
            current["material_delay"] = bool(data.get("material_delay"))
        if not compact_text(current.get("part_no")) and not compact_text(current.get("inventory_code")):
            raise ValueError("part_no or inventory_code is required")
        row = one(
            con.execute(
                """
                UPDATE public.planner_material_requests
                SET part_no = %s,
                    inventory_code = %s,
                    description = %s,
                    qty = %s,
                    material_subcon = %s,
                    remarks = %s,
                    material_delay = %s,
                    updated_at = NOW()
                WHERE request_id = %s
                RETURNING request_id, part_no, inventory_code, description, qty,
                          material_subcon, remarks, material_delay, created_at, updated_at
                """,
                (
                    compact_text(current.get("part_no")),
                    compact_text(current.get("inventory_code")),
                    compact_text(current.get("description")),
                    current.get("qty"),
                    compact_text(current.get("material_subcon")),
                    compact_text(current.get("remarks")),
                    bool(current.get("material_delay")),
                    request_id,
                ),
            )
        )
    return _serialize_request(row)


def delete_request(request_id: int) -> bool:
    with planner_db() as con:
        _ensure_table(con)
        row = one(
            con.execute(
                """
                DELETE FROM public.planner_material_requests
                WHERE request_id = %s
                RETURNING request_id
                """,
                (request_id,),
            )
        )
    return bool(row)


def _json_error(exc: Exception, *, fallback_status: int = 500):
    friendly = planner_db_connect_error(exc)
    if friendly:
        return jsonify({"error": friendly}), 503
    return jsonify({"error": str(exc)}), fallback_status


@material_tracking_requests_bp.get("/api/material-tracking/requests")
def api_list_material_requests():
    try:
        items = list_requests()
    except Exception as exc:
        logger.exception("material request list failed")
        return _json_error(exc)
    return jsonify({"ok": True, "count": len(items), "rows": items})


@material_tracking_requests_bp.get("/api/material-tracking/requests/search")
def api_search_material_request_parts():
    query = compact_text(request.args.get("q"))
    try:
        limit = int(request.args.get("limit") or _SEARCH_LIMIT)
    except (TypeError, ValueError):
        limit = _SEARCH_LIMIT
    try:
        hits = search_inventory(query, limit=limit)
    except Exception as exc:
        logger.exception("material request search failed")
        return jsonify({"error": f"ERP query failed: {exc}"}), 502
    return jsonify({"ok": True, "count": len(hits), "rows": hits})


@material_tracking_requests_bp.post("/api/material-tracking/requests")
def api_create_material_request():
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    try:
        row = create_request(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("material request create failed")
        return _json_error(exc)
    return jsonify({"ok": True, "row": row}), 201


@material_tracking_requests_bp.patch("/api/material-tracking/requests/<int:request_id>")
def api_update_material_request(request_id: int):
    data = request.get_json(force=True, silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    patch = {key: data[key] for key in _PATCH_FIELDS if key in data}
    if not patch:
        return jsonify({"error": "No editable fields supplied"}), 400
    try:
        row = update_request(request_id, patch)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("material request update failed")
        return _json_error(exc)
    if not row:
        return jsonify({"error": "Request not found"}), 404
    return jsonify({"ok": True, "row": row})


@material_tracking_requests_bp.delete("/api/material-tracking/requests/<int:request_id>")
def api_delete_material_request(request_id: int):
    try:
        deleted = delete_request(request_id)
    except Exception as exc:
        logger.exception("material request delete failed")
        return _json_error(exc)
    if not deleted:
        return jsonify({"error": "Request not found"}), 404
    return jsonify({"ok": True, "request_id": request_id})
