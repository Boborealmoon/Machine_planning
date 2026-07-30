"""PPS application - standalone process-sheet tracking for PPS-prefixed sheets."""
from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

from db import planner_db_connect_error
from .helpers import planner_db, rows as db_rows
from .mro_route import search_workscope_remarks
from .pps_overlay_service import (
    load_overlay,
    load_overlays_for_keys,
    upsert_sheet_overlay,
)
from .utils import compact_text

logger = logging.getLogger(__name__)

_DEFAULT_PPS_PATH = "/PPS"

_PPS_BOM_STAGES_SQL = """
SELECT
    s.stage_no,
    s.stage_desc,
    b.op_no,
    b.op_index,
    b.machine_no,
    b.setup_time,
    b.cycle_time
FROM public.stg_inventory_bom_stage s
LEFT JOIN public.bom_op_stage b
       ON b.inventory_code = s.inventory_code
      AND b.bom_code = s.bom_code
      AND b.stage_no = s.stage_no
WHERE LOWER(TRIM(s.inventory_code)) = LOWER(TRIM(%s))
  AND LOWER(TRIM(s.bom_code)) = LOWER(TRIM(%s))
ORDER BY s.stage_no
"""

_PPS_SO_REMARKS_SQL = """
SELECT subject, remarks, external_remarks
FROM public.so_order_header
WHERE sales_order_no = %s
LIMIT 1
"""

_PPS_SO_VALUES_SQL = """
SELECT
    sales_order_no,
    COALESCE(total_pre_tax_home_amt, total_after_tax_home_amt, 0) AS sales_order_value
FROM public.so_order_header
WHERE sales_order_no = ANY(%s)
"""


def pps_path() -> str:
    raw = (os.getenv("PPS_PATH") or _DEFAULT_PPS_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


PPS_PATH = pps_path()


def pps_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "pps.js"),
        os.path.join(root, "static", "css", "pps.css"),
        os.path.join(root, "templates", "pps.html"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"pps-{int(mt)}"
    except OSError:
        return "pps-dev"


pps_bp = Blueprint("pps", __name__)


def _is_pps_process_sheet(row: dict[str, Any]) -> bool:
    """PPS is identified by process-sheet number prefix (e.g. PPS26-0123)."""
    source_id = compact_text(
        row.get("source_ps_id") or row.get("display_ps_id") or row.get("ps_id")
    )
    base_id = source_id.split("::", 1)[0].strip().upper()
    return base_id.startswith("PPS")


def _pps_shipped_completed(row: dict[str, Any]) -> bool:
    try:
        shipped = float(row.get("qty_shipped") or 0)
        so_qty = float(row.get("so_det_qty") or 0)
    except (TypeError, ValueError):
        return False
    return so_qty > 0 and shipped >= so_qty - 0.0001


@pps_bp.get(PPS_PATH)
def pps_page():
    return render_template(
        "pps.html",
        pps_path=PPS_PATH,
        pps_asset_version=pps_asset_version(),
        pps_subtitle="Loading PPS tracking...",
    )


if PPS_PATH != _DEFAULT_PPS_PATH:

    @pps_bp.get(_DEFAULT_PPS_PATH)
    def pps_legacy_redirect():
        return redirect(url_for("pps.pps_page"), code=301)


@pps_bp.get("/api/pps/process-sheet-tracking")
def api_pps_process_sheet_tracking():
    """Return read-only ERP PPS details with their current production stage."""
    try:
        from app import (
            _load_pp_vouchers_board_erp_data,
            _pp_vouchers_disk_cache_load,
            _pp_vouchers_memory_cache_lookup,
            _schedule_pp_vouchers_with_ops_refresh,
        )

        refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
        include_completed = compact_text(
            request.args.get("show_completed") or request.args.get("include_completed")
        ).lower() in {"1", "true", "yes", "on"}
        scope = "all" if include_completed else "open"
        if refresh:
            _schedule_pp_vouchers_with_ops_refresh(scope, include_completed)
        source_rows = _pp_vouchers_memory_cache_lookup(scope, allow_stale=True)
        if source_rows is None:
            source_rows = _pp_vouchers_disk_cache_load(scope)
        if source_rows is None:
            source_rows = _load_pp_vouchers_board_erp_data(
                include_completed,
                False,
                scope,
            )
        tracking_rows: list[dict[str, Any]] = []
        seen: set[tuple[str, int]] = set()
        for raw in source_rows:
            if not _is_pps_process_sheet(raw):
                continue
            row = dict(raw)
            shipped_completed = _pps_shipped_completed(row)
            if shipped_completed:
                row["shipped_completed"] = True
                row["is_completed"] = True
            if shipped_completed and not include_completed:
                continue
            source_id = compact_text(
                row.get("source_ps_id") or row.get("display_ps_id") or row.get("ps_id")
            ).split("::", 1)[0]
            partial_no = int(row.get("pp_partial_no") or 1)
            key = (source_id.upper(), partial_no)
            if key in seen:
                continue
            seen.add(key)
            row["ops"] = row.get("op_cards") or row.get("ops") or []
            row["tracking_source"] = "erp_pps"
            tracking_rows.append(row)

        tracking_rows.sort(
            key=lambda row: (
                compact_text(row.get("due_date")),
                compact_text(
                    row.get("source_ps_id")
                    or row.get("display_ps_id")
                    or row.get("ps_id")
                ),
                int(row.get("pp_partial_no") or 1),
            )
        )
        sales_order_nos = sorted(
            {
                compact_text(row.get("source_voucher_no"))
                for row in tracking_rows
                if compact_text(row.get("source_voucher_no"))
            }
        )
        sales_order_values: dict[str, Any] = {}
        if sales_order_nos:
            try:
                with planner_db() as con:
                    sales_order_values = {
                        compact_text(value_row.get("sales_order_no")): value_row.get("sales_order_value")
                        for value_row in db_rows(
                            con.execute(_PPS_SO_VALUES_SQL, (sales_order_nos,))
                        )
                    }
            except Exception as exc:
                logger.warning("PPS sales-order value lookup failed: %s", exc)
        for row in tracking_rows:
            row["sales_order_value"] = sales_order_values.get(
                compact_text(row.get("source_voucher_no"))
            )

        overlays_map: dict[tuple[str, int], Any] = {}
        try:
            with planner_db() as con:
                overlays_map = load_overlays_for_keys(
                    con,
                    [
                        (
                            compact_text(
                                row.get("source_ps_id")
                                or row.get("display_ps_id")
                                or row.get("ps_id")
                            ).split("::", 1)[0],
                            int(row.get("pp_partial_no") or 1),
                        )
                        for row in tracking_rows
                    ],
                )
        except Exception as exc:
            logger.warning("PPS sheet overlay lookup failed: %s", exc)
        for row in tracking_rows:
            source_id = compact_text(
                row.get("source_ps_id") or row.get("display_ps_id") or row.get("ps_id")
            ).split("::", 1)[0]
            key = (source_id.upper(), int(row.get("pp_partial_no") or 1))
            overlay = overlays_map.get(key) or {
                "remarks": "",
                "flagged": False,
                "material_date": None,
                "delivery_week": "",
            }
            row["overlay"] = overlay
            row["has_flagged_op"] = bool(overlay.get("flagged"))
            row["pps_remarks"] = overlay.get("remarks") or ""
            row["pps_flagged"] = bool(overlay.get("flagged"))
            row["pps_material_date"] = overlay.get("material_date")
            row["pps_delivery_week"] = overlay.get("delivery_week") or ""

        return jsonify(
            {
                "ok": True,
                "count": len(tracking_rows),
                "rows": tracking_rows,
                "include_completed": include_completed,
                "loaded_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
            }
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("PPS process-sheet tracking query failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@pps_bp.get("/api/pps/process-sheet-tracking/details")
def api_pps_process_sheet_tracking_details():
    inventory_code = compact_text(
        request.args.get("inventory_code") or request.args.get("part_no")
    )
    bom_code = compact_text(request.args.get("bom_code"))
    sales_order_no = compact_text(request.args.get("sales_order_no"))
    ps_id = compact_text(
        request.args.get("ps_id")
        or request.args.get("process_sheet_no")
        or request.args.get("source_ps_id")
    ).split("::", 1)[0]
    try:
        pp_partial_no = int(request.args.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1
    result: dict[str, Any] = {
        "ok": True,
        "bom_stages": [],
        "bom_remarks": [],
        "sales_order_remarks": {},
        "overlay": {
            "remarks": "",
            "flagged": False,
            "material_date": None,
            "delivery_week": "",
        },
        "warnings": [],
    }

    if inventory_code and bom_code:
        try:
            with planner_db() as con:
                result["bom_stages"] = [
                    dict(row)
                    for row in db_rows(
                        con.execute(
                            _PPS_BOM_STAGES_SQL,
                            (inventory_code, bom_code),
                        )
                    )
                ]
        except Exception as exc:
            logger.warning("PPS BOM-stage lookup failed: %s", exc)
            result["warnings"].append("BOM stages could not be loaded")

    if sales_order_no:
        try:
            with planner_db() as con:
                so_rows = [
                    dict(row)
                    for row in db_rows(
                        con.execute(_PPS_SO_REMARKS_SQL, (sales_order_no,))
                    )
                ]
            if so_rows:
                so_row = so_rows[0]
                result["sales_order_remarks"] = {
                    "subject": compact_text(so_row.get("subject")),
                    "remarks": compact_text(so_row.get("remarks")),
                    "external_remarks": compact_text(so_row.get("external_remarks")),
                }
        except Exception as exc:
            logger.warning("PPS sales-order remarks lookup failed: %s", exc)
            result["warnings"].append("Sales-order remarks could not be loaded")

    if ps_id:
        try:
            with planner_db() as con:
                result["overlay"] = load_overlay(
                    con, ps_id=ps_id, pp_partial_no=pp_partial_no
                )
        except Exception as exc:
            logger.warning("PPS overlay load failed: %s", exc)
            result["warnings"].append("Sheet controls could not be loaded")

    return jsonify(result)


@pps_bp.post("/api/pps/sheet-overlay")
@pps_bp.post("/api/pps/op-overlay")
def api_pps_sheet_overlay_save():
    """Persist PS-level remarks / flag / material date / delivery week."""
    data = request.get_json(force=True, silent=True) or {}
    ps_id = compact_text(data.get("ps_id") or data.get("process_sheet_no")).split("::", 1)[0]
    try:
        pp_partial_no = int(data.get("pp_partial_no") or 1)
    except (TypeError, ValueError):
        pp_partial_no = 1

    if not ps_id:
        return jsonify({"ok": False, "error": "ps_id is required"}), 400

    remarks = data.get("remarks")
    flagged = data.get("flagged")
    material_date = data.get("material_date")
    delivery_week = data.get("delivery_week")
    clear_material_date = False
    if "material_date" in data and (
        material_date is None or compact_text(material_date) == ""
    ):
        clear_material_date = True
        material_date = None

    try:
        with planner_db() as con:
            row = upsert_sheet_overlay(
                con,
                ps_id=ps_id,
                pp_partial_no=pp_partial_no,
                remarks=None if remarks is None else str(remarks),
                flagged=None if flagged is None else bool(flagged),
                material_date=None if material_date is None else str(material_date),
                clear_material_date=clear_material_date,
                delivery_week=None if delivery_week is None else str(delivery_week),
            )
        return jsonify({"ok": True, "overlay": row})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("PPS sheet overlay save failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@pps_bp.get("/api/pps/workscope-remarks")
def api_pps_workscope_remarks():
    part_no = compact_text(request.args.get("part_no") or request.args.get("inventory_code"))
    bom_code = compact_text(request.args.get("bom_code"))
    process_sheet_no = compact_text(
        request.args.get("process_sheet_no")
        or request.args.get("pp_voucher_no")
        or request.args.get("ps")
    )
    q = compact_text(request.args.get("q") or request.args.get("search"))
    try:
        result = search_workscope_remarks(
            part_no=part_no,
            bom_code=bom_code,
            process_sheet_no=process_sheet_no,
            q=q,
        )
        remark_rows = result.get("rows") or []
        return jsonify(
            {
                "ok": True,
                "count": len(remark_rows),
                "rows": remark_rows,
                "resolved": result.get("resolved"),
            }
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("PPS workscope remarks search failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
