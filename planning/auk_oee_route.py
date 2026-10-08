"""Auk OEE canvas dashboard page and API."""

from __future__ import annotations

import requests
from flask import Blueprint, jsonify, render_template, request

from .auk_oee_history import (
    default_layout_from_cards,
    load_board,
    load_layout,
    save_layout,
)
from .auk_oee_service import (
    auk_configured,
    fetch_asset_detail,
    fetch_canvas_dashboard,
    fetch_equipment_timeline,
    format_auk_http_error,
    load_dashboard_snapshot,
    parse_range_from_request,
    validate_pareto_dashboard,
)

auk_oee_bp = Blueprint("auk_oee", __name__)


@auk_oee_bp.get("/auk-oee")
def auk_oee_page():
    return render_template(
        "auk_oee_dashboard.html",
        active="auk_oee",
        auk_configured=auk_configured(),
    )


@auk_oee_bp.get("/api/auk-oee/dashboard")
def api_auk_oee_dashboard():
    if not auk_configured():
        return jsonify(
            {"error": "Set AUK_ACCESS_TOKEN in .env to load live OEE data.", "configured": False}
        ), 503

    lower, upper, range_preset = parse_range_from_request(request.args)
    res_x = int(request.args.get("res_x") or 15)
    res_period = (request.args.get("res_period") or "minutes").strip() or "minutes"

    try:
        payload = fetch_canvas_dashboard(
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
        )
        payload["configured"] = True
        payload["range_preset"] = range_preset
        payload["shift_window"] = "00:00-24:00" if range_preset == "day" else "08:30-20:30"
        payload["default_layout"] = default_layout_from_cards(payload.get("cards") or [])
        return jsonify(payload)
    except requests.HTTPError as exc:
        message, status = format_auk_http_error(exc)
        if status == 401:
            cached = load_dashboard_snapshot()
            if cached:
                cached["configured"] = True
                cached["range_preset"] = cached.get("range_preset") or "day"
                cached["default_layout"] = default_layout_from_cards(cached.get("cards") or [])
                cached["stale"] = True
                cached["warning"] = (
                    "Showing the Factory Dashboard read from the signed-in Auk session. "
                    "The saved AUK_ACCESS_TOKEN has expired, so this view will not auto-update "
                    "until that token is replaced."
                )
                return jsonify(cached)
        return jsonify({"error": message, "configured": True}), status
    except requests.RequestException as exc:
        return jsonify({"error": str(exc), "configured": True}), 502
    except Exception as exc:
        return jsonify({"error": str(exc), "configured": True}), 500


@auk_oee_bp.get("/api/auk-oee/history")
def api_auk_oee_history():
    minutes = request.args.get("minutes") or 10
    try:
        board = load_board(minutes=int(minutes))
    except (TypeError, ValueError):
        board = load_board(minutes=10)
    return jsonify(board)


@auk_oee_bp.get("/api/auk-oee/layout")
def api_auk_oee_layout_get():
    layout = load_layout()
    return jsonify({"layout": layout})


@auk_oee_bp.put("/api/auk-oee/layout")
def api_auk_oee_layout_put():
    body = request.get_json(silent=True) or {}
    layout = save_layout(body)
    return jsonify({"layout": layout})


@auk_oee_bp.get("/api/auk-oee/equipment/<int:equipment_id>")
def api_auk_oee_equipment(equipment_id: int):
    if not auk_configured():
        return jsonify(
            {"error": "Set AUK_ACCESS_TOKEN in .env to load live OEE data.", "configured": False}
        ), 503

    lower, upper, range_preset = parse_range_from_request(request.args)
    res_x = int(request.args.get("res_x") or 1)
    res_period = (request.args.get("res_period") or "hours").strip() or "hours"
    try:
        payload = fetch_equipment_timeline(
            equipment_id,
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
        )
        payload["configured"] = True
        payload["range_preset"] = range_preset
        return jsonify(payload)
    except requests.HTTPError as exc:
        message, status = format_auk_http_error(exc)
        return jsonify({"error": message, "configured": True}), status
    except requests.RequestException as exc:
        return jsonify({"error": str(exc), "configured": True}), 502
    except Exception as exc:
        return jsonify({"error": str(exc), "configured": True}), 500


@auk_oee_bp.get("/api/auk-oee/asset/<int:asset_id>")
def api_auk_oee_asset(asset_id: int):
    if not auk_configured():
        return jsonify(
            {"error": "Set AUK_ACCESS_TOKEN in .env to load live OEE data.", "configured": False}
        ), 503

    lower, upper, range_preset = parse_range_from_request(request.args)
    res_x = int(request.args.get("res_x") or 1)
    res_period = (request.args.get("res_period") or "hours").strip() or "hours"
    entity_id = request.args.get("entity_id")
    include_series = (request.args.get("include_series") or "false").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )

    try:
        payload = fetch_asset_detail(
            asset_id,
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
            entity_id=int(entity_id) if entity_id else None,
        )
        if not include_series:
            for chart in payload.get("charts") or []:
                chart.pop("series", None)
        payload["configured"] = True
        payload["range_preset"] = range_preset
        return jsonify(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc), "configured": True}), 404
    except requests.HTTPError as exc:
        message, status = format_auk_http_error(exc)
        return jsonify({"error": message, "configured": True}), status
    except requests.RequestException as exc:
        return jsonify({"error": str(exc), "configured": True}), 502
    except Exception as exc:
        return jsonify({"error": str(exc), "configured": True}), 500


@auk_oee_bp.get("/api/auk-oee/validate")
def api_auk_oee_validate():
    if not auk_configured():
        return jsonify(
            {"error": "Set AUK_ACCESS_TOKEN in .env to load live OEE data.", "configured": False}
        ), 503

    lower, upper, range_preset = parse_range_from_request(request.args)
    res_x = int(request.args.get("res_x") or 1)
    res_period = (request.args.get("res_period") or "hours").strip() or "hours"
    entity_id = request.args.get("entity_id")
    pareto_block_id = request.args.get("pareto_block_id") or request.args.get("block_id")
    tolerance = float(request.args.get("tolerance") or 0.05)

    try:
        payload = validate_pareto_dashboard(
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
            entity_id=int(entity_id) if entity_id else None,
            pareto_block_id=int(pareto_block_id) if pareto_block_id else None,
            tolerance=tolerance,
        )
        payload["configured"] = True
        payload["range_preset"] = range_preset
        return jsonify(payload)
    except requests.HTTPError as exc:
        message, status = format_auk_http_error(exc)
        return jsonify({"error": message, "configured": True}), status
    except requests.RequestException as exc:
        return jsonify({"error": str(exc), "configured": True}), 502
    except Exception as exc:
        return jsonify({"error": str(exc), "configured": True}), 500
