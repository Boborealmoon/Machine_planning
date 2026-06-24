"""Auk OEE canvas dashboard page and API."""

from __future__ import annotations

import requests
from flask import Blueprint, jsonify, render_template, request

from .auk_oee_service import (
    auk_configured,
    fetch_asset_detail,
    fetch_canvas_dashboard,
    format_auk_http_error,
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
    res_x = int(request.args.get("res_x") or 1)
    res_period = (request.args.get("res_period") or "hours").strip() or "hours"

    try:
        payload = fetch_canvas_dashboard(
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
        )
        payload["configured"] = True
        payload["range_preset"] = range_preset
        payload["shift_window"] = "08:30-20:30"
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
