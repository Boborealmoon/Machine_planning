"""Post-machining queue — synced staging per PP partial + planner QA overlays."""
from __future__ import annotations

import logging
import os
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

from .erp_wo_merge import finishing_stage_bucket
from .anticipated_material_service import (
    anticipated_material_payload,
    fetch_anticipated_material,
)
from .finishing_queue_service import (
    add_inspector,
    delete_inspector,
    fetch_finishing_queue_bundle,
    fetch_recently_packed_from_staging,
    load_inspectors,
    upsert_overlay,
)
from .helpers import planner_db
from .material_issue_queue_service import fetch_material_issue_queue
from .utils import compact_text

logger = logging.getLogger(__name__)

_DEFAULT_FINISHING_QUEUE_PATH = "/qaqc-view"
_LEGACY_FINISHING_QUEUE_PATHS = frozenset({
    "/finishing-queue",
    "/post-machining-queue",
    "/finishing_queue",
    "/qaqc",
    "/qaqc-view",
})


def finishing_queue_path() -> str:
    raw = (os.getenv("FINISHING_QUEUE_PATH") or _DEFAULT_FINISHING_QUEUE_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


FINISHING_QUEUE_PATH = finishing_queue_path()
LEGACY_FINISHING_QUEUE_PATHS = _LEGACY_FINISHING_QUEUE_PATHS


def finishing_queue_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "finishing_queue.js"),
        os.path.join(root, "static", "js", "qaqc_i18n.js"),
        os.path.join(root, "static", "css", "qaqc.css"),
        os.path.join(root, "templates", "finishing_queue.html"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"fq-{int(mt)}"
    except OSError:
        return "fq-dev"


finishing_queue_bp = Blueprint("finishing_queue", __name__)

_CACHE_TTL_SEC = 180
_CACHE_VERSION = 17
_cache: tuple[float, int, list[dict[str, Any]], str, list[dict[str, Any]], list[dict[str, Any]]] | None = None
_RECENTLY_PACKED_CACHE_TTL_SEC = 300
_recently_packed_cache: tuple[float, int, list[dict[str, Any]]] | None = None


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_value(val) for key, val in row.items()}


def _stage_bucket(stage_desc: str) -> str:
    return finishing_stage_bucket(stage_desc)


def _working_week_range(for_date: date | None = None, offset_weeks: int = 0) -> tuple[date, date]:
    """Mon–Sat working week (matches material inspection / new orders)."""
    anchor = for_date or date.today()
    js_day = (anchor.weekday() + 1) % 7
    monday_offset = -6 if js_day == 0 else 1 - js_day
    start = anchor + timedelta(days=monday_offset + offset_weeks * 7)
    end = start + timedelta(days=5)
    return start, end


def _recently_packed_week_bounds() -> tuple[date, date]:
    this_start, this_end = _working_week_range(date.today(), 0)
    last_start, _last_end = _working_week_range(date.today(), -1)
    return last_start, this_end


def _enrich_recently_packed_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for item in items:
        merged = dict(item)
        merged["stage_bucket"] = _stage_bucket(merged.get("current_stage_desc") or "")
        merged["current_stage_status"] = "C"
        enriched.append(merged)
    return enriched


def _fetch_recently_packed(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _recently_packed_cache

    now = time.time()
    if (
        not refresh
        and _recently_packed_cache
        and now - _recently_packed_cache[0] < _RECENTLY_PACKED_CACHE_TTL_SEC
    ):
        return _recently_packed_cache[1]

    week_start, week_end = _recently_packed_week_bounds()
    with planner_db() as con:
        raw_rows = fetch_recently_packed_from_staging(
            con,
            week_start=week_start,
            week_end=week_end,
        )
    items = _enrich_recently_packed_items(raw_rows)
    _recently_packed_cache = (now, items)
    return items


def invalidate_finishing_queue_cache() -> None:
    global _cache, _recently_packed_cache
    _cache = None
    _recently_packed_cache = None


def _fetch_finishing_queue(*, refresh: bool = False) -> tuple[list[dict[str, Any]], str, list[dict[str, Any]], list[dict[str, Any]]]:
    global _cache
    now = time.time()
    if (
        not refresh
        and _cache
        and _cache[1] == _CACHE_VERSION
        and now - _cache[0] < _CACHE_TTL_SEC
    ):
        return _cache[2], _cache[3], _cache[4], _cache[5]

    t0 = time.perf_counter()
    with planner_db() as con:
        # Bound slow scans / lock waits so Waitress threads and the
        # connection pool are not held open indefinitely.
        try:
            con.execute("SET LOCAL statement_timeout = '45s'")
            con.execute("SET LOCAL lock_timeout = '8s'")
        except Exception:
            pass
        bundle = fetch_finishing_queue_bundle(con)
        items = bundle["items"]
        inspectors = bundle["inspectors"]
        try:
            material_issue_items = fetch_material_issue_queue(con)
        except Exception:
            logger.exception("material-issue queue query failed; returning finishing rows only")
            material_issue_items = []
    source = "staging"
    logger.info(
        "finishing queue loaded (%s): %d rows, %d material-issue rows in %dms",
        source,
        len(items),
        len(material_issue_items),
        int((time.perf_counter() - t0) * 1000),
    )

    _cache = (now, _CACHE_VERSION, items, source, inspectors, material_issue_items)
    return items, source, inspectors, material_issue_items


def _build_queue_payload(
    *,
    items: list[dict[str, Any]],
    source: str,
    inspectors: list[dict[str, Any]],
    material_issue_items: list[dict[str, Any]] | None = None,
    recently_packed: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    material_issue_items = material_issue_items or []
    recently_packed = recently_packed or []
    packed_this_week = 0
    packed_last_week = 0
    this_start, this_end = _working_week_range(date.today(), 0)
    last_start, last_end = _working_week_range(date.today(), -1)
    for item in recently_packed:
        packed_on = compact_text(item.get("packed_on"))
        if not packed_on:
            continue
        try:
            packed_date = date.fromisoformat(packed_on[:10])
        except ValueError:
            continue
        if this_start <= packed_date <= this_end:
            packed_this_week += 1
        elif last_start <= packed_date <= last_end:
            packed_last_week += 1

    summary = _queue_summary(items)
    hint = ""
    if not items:
        hint = (
            "No partials at a finishing stage. Run Sync ERP (mfg_wo_status + pp_vouchers_cache) "
            "then Refresh this page."
        )
    cached_at = _cache[0] if _cache else time.time()
    packed_cached_at = _recently_packed_cache[0] if _recently_packed_cache else cached_at
    return {
        "ok": True,
        "items": items,
        "material_issue_items": material_issue_items,
        "material_issue_count": len(material_issue_items),
        "material_issue_hint": (
            "No open jobs with an assembly WO stage (SO qty not fully shipped). "
            "Run Sync ERP then Refresh."
            if not material_issue_items
            else ""
        ),
        "recently_packed": recently_packed,
        "inspectors": inspectors,
        "count": len(items),
        "recently_packed_count": len(recently_packed),
        "packed_this_week_count": packed_this_week,
        "packed_last_week_count": packed_last_week,
        **summary,
        "week_ranges": {
            "this_week": {"start": this_start.isoformat(), "end": this_end.isoformat()},
            "last_week": {"start": last_start.isoformat(), "end": last_end.isoformat()},
        },
        "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
        "packed_cached_at": datetime.fromtimestamp(packed_cached_at).isoformat(sep=" ", timespec="seconds"),
        "cache_ttl_sec": _CACHE_TTL_SEC,
        "packed_cache_ttl_sec": _RECENTLY_PACKED_CACHE_TTL_SEC,
        "source": source,
        "hint": hint,
    }


def _queue_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {stage: 0 for stage in ("deburring", "final_inspection", "packing", "engraving_packing")}
    status_counts = {"I": 0, "R": 0, "P": 0}
    assignment_counts: dict[str, int] = {}
    for item in items:
        bucket = item.get("stage_bucket") or ""
        if bucket in counts:
            counts[bucket] += 1
        status = compact_text(item.get("current_stage_status")).upper()
        if status in status_counts:
            status_counts[status] += 1
        assignee = compact_text(item.get("inspector_name")) or "Unassigned"
        assignment_counts[assignee] = assignment_counts.get(assignee, 0) + 1
    return {
        "stage_counts": counts,
        "status_counts": status_counts,
        "assignment_counts": assignment_counts,
    }


def _finishing_queue_client_config() -> dict[str, str]:
    return {
        "pagePath": FINISHING_QUEUE_PATH,
        "apiQueue": url_for("finishing_queue.api_finishing_queue"),
        "apiOverlay": url_for("finishing_queue.api_finishing_queue_overlay"),
        "apiInspectors": url_for("finishing_queue.api_finishing_queue_inspectors"),
        "apiWoStatusSync": url_for("api_mfg_wo_status_sync"),
        "apiMaterialInspection": url_for("material_inspection.api_material_inspection"),
        "apiMaterialInspectionOverlay": url_for("material_inspection.api_material_inspection_overlay"),
        "apiQcQualityQueue": url_for("qc_quality_queue.api_qc_quality_queue"),
        "apiAnticipatedMaterial": url_for("finishing_queue.api_anticipated_material"),
    }


@finishing_queue_bp.get(FINISHING_QUEUE_PATH)
def finishing_queue_page():
    fq_bootstrap = None
    fq_bootstrap_error = None
    # Never block HTML on a cold mfg_wo_status scan — that query can take tens of
    # seconds and used to make the whole page look hung. Warm process cache only.
    try:
        now = time.time()
        if (
            _cache
            and _cache[1] == _CACHE_VERSION
            and now - _cache[0] < _CACHE_TTL_SEC
        ):
            items, source, inspectors, material_issue_items = _fetch_finishing_queue(refresh=False)
            fq_bootstrap = _build_queue_payload(
                items=items,
                source=source,
                inspectors=inspectors,
                material_issue_items=material_issue_items,
            )
    except Exception as exc:
        logger.exception("post-machining queue page bootstrap failed")
        fq_bootstrap_error = str(exc)
    return render_template(
        "finishing_queue.html",
        active="finishing_queue",
        fq_bootstrap=fq_bootstrap,
        fq_bootstrap_error=fq_bootstrap_error,
        fq_client_config=_finishing_queue_client_config(),
        fq_asset_version=finishing_queue_asset_version(),
    )


@finishing_queue_bp.get("/material-issue-assembly")
def material_issue_queue_legacy_redirect():
    return redirect(f"{FINISHING_QUEUE_PATH}?tab=material_issue")


@finishing_queue_bp.get("/api/finishing-queue/anticipated-material")
def api_anticipated_material():
    try:
        with planner_db() as con:
            items = fetch_anticipated_material(con)
    except Exception as exc:
        logger.exception("anticipated material query failed")
        return jsonify({"ok": False, "error": str(exc)}), 502
    return jsonify(anticipated_material_payload(items))


@finishing_queue_bp.get("/api/finishing-queue")
def api_finishing_queue():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    include_packed = compact_text(request.args.get("include_packed")).lower() in {"1", "true", "yes"}

    try:
        items, source, inspectors, material_issue_items = _fetch_finishing_queue(refresh=refresh)
    except Exception as exc:
        logger.exception("post-machining queue query failed")
        return jsonify({"error": str(exc)}), 502

    recently_packed: list[dict[str, Any]] = []
    if include_packed:
        try:
            recently_packed = _fetch_recently_packed(refresh=refresh)
        except Exception as exc:
            logger.exception("recently packed query failed")
            return jsonify({"error": f"Recently packed query failed: {exc}"}), 502

    return jsonify(
        _build_queue_payload(
            items=items,
            source=source,
            inspectors=inspectors,
            material_issue_items=material_issue_items,
            recently_packed=recently_packed,
        )
    )


@finishing_queue_bp.get("/api/finishing-queue/recently-packed")
def api_finishing_queue_recently_packed():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes"}
    try:
        recently_packed = _fetch_recently_packed(refresh=refresh)
    except Exception as exc:
        logger.exception("recently packed query failed")
        return jsonify({"error": str(exc)}), 502

    this_start, this_end = _working_week_range(date.today(), 0)
    last_start, last_end = _working_week_range(date.today(), -1)
    packed_this_week = 0
    packed_last_week = 0
    for item in recently_packed:
        packed_on = compact_text(item.get("packed_on"))
        if not packed_on:
            continue
        try:
            packed_date = date.fromisoformat(packed_on[:10])
        except ValueError:
            continue
        if this_start <= packed_date <= this_end:
            packed_this_week += 1
        elif last_start <= packed_date <= last_end:
            packed_last_week += 1

    packed_cached_at = _recently_packed_cache[0] if _recently_packed_cache else time.time()
    return jsonify(
        {
            "ok": True,
            "recently_packed": recently_packed,
            "recently_packed_count": len(recently_packed),
            "packed_this_week_count": packed_this_week,
            "packed_last_week_count": packed_last_week,
            "week_ranges": {
                "this_week": {"start": this_start.isoformat(), "end": this_end.isoformat()},
                "last_week": {"start": last_start.isoformat(), "end": last_end.isoformat()},
            },
            "packed_cached_at": datetime.fromtimestamp(packed_cached_at).isoformat(sep=" ", timespec="seconds"),
            "packed_cache_ttl_sec": _RECENTLY_PACKED_CACHE_TTL_SEC,
        }
    )


@finishing_queue_bp.put("/api/finishing-queue/overlay")
def api_finishing_queue_overlay():
    payload = request.get_json(silent=True) or {}
    ps_id = compact_text(payload.get("ps_id"))
    stage_desc = compact_text(payload.get("stage_desc") or payload.get("current_stage_desc"))
    try:
        pp_partial_no = int(payload.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1
    if not ps_id or not stage_desc:
        return jsonify({"ok": False, "error": "ps_id and stage_desc are required"}), 400

    inspector_raw = payload.get("inspector_id")
    inspector_id = None
    if inspector_raw not in (None, ""):
        try:
            inspector_id = int(inspector_raw)
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "invalid inspector_id"}), 400

    try:
        with planner_db() as con:
            row = upsert_overlay(
                con,
                ps_id=ps_id,
                pp_partial_no=pp_partial_no,
                stage_desc=stage_desc,
                remarks=payload.get("remarks") if "remarks" in payload else None,
                inspector_id=inspector_id if "inspector_id" in payload else None,
                qa_due_date=payload.get("qa_due_date") if "qa_due_date" in payload else None,
                checklist_done=payload.get("checklist_done") if "checklist_done" in payload else None,
                exception_flag=payload.get("exception_flag") if "exception_flag" in payload else None,
                clear_inspector=payload.get("inspector_id") in ("", None) and "inspector_id" in payload,
                clear_qa_due_date=payload.get("qa_due_date") in ("", None) and "qa_due_date" in payload,
            )
    except Exception as exc:
        logger.exception("finishing queue overlay save failed")
        return jsonify({"ok": False, "error": str(exc)}), 500

    invalidate_finishing_queue_cache()
    return jsonify({"ok": True, "overlay": row})


@finishing_queue_bp.post("/api/finishing-queue/overlay")
def api_finishing_queue_overlay_post():
    """POST alias for environments that block PUT."""
    return api_finishing_queue_overlay()


@finishing_queue_bp.get("/api/finishing-queue/inspectors")
def api_finishing_queue_inspectors():
    with planner_db() as con:
        inspectors = load_inspectors(con)
    return jsonify({"ok": True, "inspectors": inspectors})


@finishing_queue_bp.post("/api/finishing-queue/inspectors")
def api_finishing_queue_inspector_add():
    payload = request.get_json(silent=True) or {}
    name = compact_text(payload.get("name"))
    if not name:
        return jsonify({"ok": False, "error": "name is required"}), 400
    try:
        with planner_db() as con:
            inspector, created = add_inspector(con, name)
    except Exception as exc:
        logger.exception("finishing queue inspector add failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
    invalidate_finishing_queue_cache()
    return jsonify({
        "ok": True,
        "inspector": inspector,
        "created": created,
        "message": f"Added {inspector.get('name', name)}" if created else f"{inspector.get('name', name)} is already on the team",
    })


@finishing_queue_bp.delete("/api/finishing-queue/inspectors/<int:inspector_id>")
def api_finishing_queue_inspector_delete(inspector_id: int):
    try:
        with planner_db() as con:
            result = delete_inspector(con, inspector_id)
    except Exception as exc:
        logger.exception("finishing queue inspector delete failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
    if not result:
        return jsonify({"ok": False, "error": "inspector not found"}), 404
    invalidate_finishing_queue_cache()
    return jsonify({
        "ok": True,
        "name": result.get("name"),
        "removed_count": result.get("removed_count", 0),
        "message": f"Removed {result.get('name') or 'inspector'}",
    })
