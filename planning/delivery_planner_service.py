"""Delivery planner row flags (OK dismiss + exception) stored per planner_ps_id."""

from __future__ import annotations

from datetime import date
from typing import Any

from flask import jsonify, request

from db import planner_db_connect_error
from .helpers import one, planner_db, rows
from .process_sheets import _planner_ps_identity
from .utils import compact_text


def _clear_delivery_schedule_cache() -> None:
    from . import planner_routes

    planner_routes.clear_delivery_schedule_cache()


def _parse_flag_bool(value) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = compact_text(value).lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def ensure_delivery_planner_table(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_delivery_row (
            planner_ps_id   TEXT PRIMARY KEY,
            dismissed       BOOLEAN      NOT NULL DEFAULT FALSE,
            exception_flag  BOOLEAN      NOT NULL DEFAULT FALSE,
            coc_done        BOOLEAN      NOT NULL DEFAULT FALSE,
            qaqc_report_ready BOOLEAN    NOT NULL DEFAULT FALSE,
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        ALTER TABLE planner_delivery_row
        ADD COLUMN IF NOT EXISTS coc_done BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    con.execute(
        """
        ALTER TABLE planner_delivery_row
        ADD COLUMN IF NOT EXISTS qaqc_report_ready BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    con.execute(
        """
        ALTER TABLE planner_delivery_row
        ADD COLUMN IF NOT EXISTS proposed_delivery DATE
        """
    )


def _canonical_planner_ps_id(planner_ps_id: str) -> str:
    _, _, canonical = _planner_ps_identity(planner_ps_id)
    return compact_text(canonical)


def _proposed_delivery_text(value) -> str:
    text = compact_text(value)
    return text[:10] if text else ""


def _parse_proposed_delivery(value) -> date | None:
    if value is None:
        return None
    text = compact_text(value)
    if not text:
        return None
    if len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-":
        text = text[:10]
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("proposed_delivery must be YYYY-MM-DD") from exc


def _empty_delivery_flags() -> dict[str, Any]:
    return {
        "dismissed": False,
        "exception": False,
        "coc_done": False,
        "qaqc_report_ready": False,
        "proposed_delivery": "",
    }


def _row_to_flags(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return _empty_delivery_flags()
    return {
        "dismissed": bool(row.get("dismissed")),
        "exception": bool(row.get("exception_flag")),
        "coc_done": bool(row.get("coc_done")),
        "qaqc_report_ready": bool(row.get("qaqc_report_ready")),
        "proposed_delivery": _proposed_delivery_text(row.get("proposed_delivery")),
    }


def load_delivery_row_flags(con, planner_ps_ids: list[str]) -> dict[str, dict[str, Any]]:
    ensure_delivery_planner_table(con)
    ids = []
    seen = set()
    for raw in planner_ps_ids or []:
        canonical = _canonical_planner_ps_id(raw)
        if canonical and canonical not in seen:
            seen.add(canonical)
            ids.append(canonical)
    if not ids:
        return {}
    out = {pid: _empty_delivery_flags() for pid in ids}
    for row in rows(
        con.execute(
            """
            SELECT planner_ps_id, dismissed, exception_flag, coc_done, qaqc_report_ready,
                   proposed_delivery
            FROM planner_delivery_row
            WHERE planner_ps_id = ANY(%s)
            """,
            (ids,),
        )
    ):
        pid = compact_text(row.get("planner_ps_id"))
        if pid:
            out[pid] = _row_to_flags(row)
    return out


def get_delivery_row_flags(con, planner_ps_id: str) -> dict[str, Any]:
    ensure_delivery_planner_table(con)
    canonical = _canonical_planner_ps_id(planner_ps_id)
    if not canonical:
        empty = _empty_delivery_flags()
        empty["planner_ps_id"] = ""
        return empty
    row = one(
        con.execute(
            """
            SELECT planner_ps_id, dismissed, exception_flag, coc_done, qaqc_report_ready,
                   proposed_delivery
            FROM planner_delivery_row
            WHERE planner_ps_id = %s
            """,
            (canonical,),
        )
    )
    flags = _row_to_flags(row)
    return {
        "planner_ps_id": canonical,
        "dismissed": flags["dismissed"],
        "exception": flags["exception"],
        "coc_done": flags["coc_done"],
        "qaqc_report_ready": flags["qaqc_report_ready"],
        "proposed_delivery": flags["proposed_delivery"],
    }


def upsert_delivery_row_flags(
    con,
    planner_ps_id: str,
    *,
    dismissed: bool | None = None,
    exception: bool | None = None,
    coc_done: bool | None = None,
    qaqc_report_ready: bool | None = None,
    stage_desc: str | None = None,
    sync_qaqc_checklist: bool = True,
) -> dict[str, Any]:
    ensure_delivery_planner_table(con)
    canonical = _canonical_planner_ps_id(planner_ps_id)
    if not canonical:
        raise ValueError("planner_ps_id is required")

    current = get_delivery_row_flags(con, canonical)
    next_dismissed = current["dismissed"] if dismissed is None else bool(dismissed)
    next_exception = current["exception"] if exception is None else bool(exception)
    next_coc_done = current["coc_done"] if coc_done is None else bool(coc_done)
    next_qaqc_report_ready = (
        current["qaqc_report_ready"] if qaqc_report_ready is None else bool(qaqc_report_ready)
    )

    con.execute(
        """
        INSERT INTO planner_delivery_row (
            planner_ps_id, dismissed, exception_flag, coc_done, qaqc_report_ready, updated_at
        ) VALUES (%s, %s, %s, %s, %s, NOW())
        ON CONFLICT (planner_ps_id) DO UPDATE SET
            dismissed = EXCLUDED.dismissed,
            exception_flag = EXCLUDED.exception_flag,
            coc_done = EXCLUDED.coc_done,
            qaqc_report_ready = EXCLUDED.qaqc_report_ready,
            updated_at = NOW()
        """,
        (canonical, next_dismissed, next_exception, next_coc_done, next_qaqc_report_ready),
    )
    if sync_qaqc_checklist and qaqc_report_ready is not None:
        from planning.finishing_queue_service import set_checklist_done_for_planner_ps

        set_checklist_done_for_planner_ps(
            con,
            canonical,
            next_qaqc_report_ready,
            stage_desc=stage_desc,
        )
        try:
            from planning.finishing_queue_route import invalidate_finishing_queue_cache

            invalidate_finishing_queue_cache()
        except Exception:
            pass
    _clear_delivery_schedule_cache()
    return {
        "planner_ps_id": canonical,
        "dismissed": next_dismissed,
        "exception": next_exception,
        "coc_done": next_coc_done,
        "qaqc_report_ready": next_qaqc_report_ready,
        "proposed_delivery": current.get("proposed_delivery") or "",
    }


def upsert_proposed_delivery(con, planner_ps_id: str, proposed_delivery: date | None) -> dict[str, Any]:
    """Delivery-schedule-only date. Does not change Coway EDD."""
    ensure_delivery_planner_table(con)
    canonical = _canonical_planner_ps_id(planner_ps_id)
    if not canonical:
        raise ValueError("planner_ps_id is required")

    row = one(
        con.execute(
            """
            INSERT INTO planner_delivery_row (planner_ps_id, proposed_delivery, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (planner_ps_id) DO UPDATE SET
                proposed_delivery = EXCLUDED.proposed_delivery,
                updated_at = NOW()
            RETURNING planner_ps_id, proposed_delivery
            """,
            (canonical, proposed_delivery),
        )
    )
    saved = _proposed_delivery_text((row or {}).get("proposed_delivery"))
    _clear_delivery_schedule_cache()
    return {
        "planner_ps_id": canonical,
        "proposed_delivery": saved,
    }


def bulk_upsert_delivery_row_flags(con, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    saved: list[dict[str, Any]] = []
    for item in items or []:
        planner_ps_id = compact_text((item or {}).get("planner_ps_id"))
        if not planner_ps_id:
            continue
        dismissed = item.get("dismissed")
        exception = item.get("exception")
        coc_done = item.get("coc_done")
        qaqc_report_ready = item.get("qaqc_report_ready")
        if (
            dismissed is None
            and exception is None
            and coc_done is None
            and qaqc_report_ready is None
        ):
            continue
        saved.append(
            upsert_delivery_row_flags(
                con,
                planner_ps_id,
                dismissed=dismissed if dismissed is not None else None,
                exception=exception if exception is not None else None,
                coc_done=coc_done if coc_done is not None else None,
                qaqc_report_ready=qaqc_report_ready if qaqc_report_ready is not None else None,
            )
        )
    return saved


def delivery_flags_post_response():
    data = request.get_json(force=True, silent=True) or {}
    planner_ps_id = compact_text(data.get("planner_ps_id") or data.get("ps_id"))
    if not planner_ps_id:
        return jsonify({"error": "planner_ps_id is required"}), 400

    dismissed = _parse_flag_bool(data.get("dismissed"))
    exception = _parse_flag_bool(data.get("exception"))
    coc_done = _parse_flag_bool(data.get("coc_done"))
    qaqc_report_ready = _parse_flag_bool(data.get("qaqc_report_ready"))
    stage_desc = compact_text(data.get("stage_desc") or data.get("current_stage_desc"))
    if dismissed is None and exception is None and coc_done is None and qaqc_report_ready is None:
        return jsonify({"error": "dismissed, exception, coc_done, or qaqc_report_ready is required"}), 400

    try:
        with planner_db() as con:
            payload = upsert_delivery_row_flags(
                con,
                planner_ps_id,
                dismissed=dismissed,
                exception=exception,
                coc_done=coc_done,
                qaqc_report_ready=qaqc_report_ready,
                stage_desc=stage_desc or None,
            )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(exc)}), 500

    _clear_delivery_schedule_cache()
    return jsonify(payload)


def proposed_delivery_post_response():
    data = request.get_json(force=True, silent=True) or {}
    planner_ps_id = compact_text(data.get("planner_ps_id") or data.get("ps_id"))
    if not planner_ps_id:
        return jsonify({"error": "planner_ps_id is required"}), 400
    if "proposed_delivery" not in data:
        return jsonify({"error": "proposed_delivery is required"}), 400
    try:
        proposed = _parse_proposed_delivery(data.get("proposed_delivery"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        with planner_db() as con:
            payload = upsert_proposed_delivery(con, planner_ps_id, proposed)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(exc)}), 500

    _clear_delivery_schedule_cache()
    return jsonify(payload)


def delivery_flags_bulk_post_response():
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items array is required"}), 400

    try:
        with planner_db() as con:
            saved = bulk_upsert_delivery_row_flags(con, items)
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"error": friendly}), 503
        return jsonify({"error": str(exc)}), 500

    if saved:
        _clear_delivery_schedule_cache()
    return jsonify({"items": saved, "count": len(saved)})
