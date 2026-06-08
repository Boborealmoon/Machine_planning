"""Auk OEE canvas dashboard page and API."""

from __future__ import annotations

import requests
from flask import Blueprint, jsonify, render_template, request

from .auk_oee_service import (
    auk_configured,
    fetch_canvas_dashboard,
    parse_range_from_request,
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

    lower, upper = parse_range_from_request(request.args)
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
        return jsonify(payload)
    except requests.HTTPError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        return jsonify({"error": detail or str(exc), "configured": True}), 502
    except requests.RequestException as exc:
        return jsonify({"error": str(exc), "configured": True}), 502
    except Exception as exc:
        return jsonify({"error": str(exc), "configured": True}), 500
