"""Force /api/* errors to JSON so the UI never parses an HTML error page."""
from __future__ import annotations

import logging

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException, InternalServerError

from db import planner_db_connect_error

logger = logging.getLogger(__name__)


def is_api_request() -> bool:
    return (request.path or "").startswith("/api/")


def json_error_response(message: str, status: int):
    return jsonify({"ok": False, "error": message}), int(status or 500)


def _http_error_message(exc: HTTPException) -> str:
    code = int(exc.code or 500)
    path = request.path or "/"
    if code == 404:
        return f"API route not found: {path}"
    if code == 405:
        return f"Method not allowed for {path}"
    description = (exc.description or exc.name or "").strip()
    return description or f"HTTP {code}"


def register_api_json_error_handlers(app: Flask) -> None:
    @app.errorhandler(HTTPException)
    def handle_http_exception(exc: HTTPException):
        if not is_api_request():
            return exc
        return json_error_response(_http_error_message(exc), exc.code or 500)

    @app.errorhandler(Exception)
    def handle_uncaught_exception(exc: Exception):
        if isinstance(exc, HTTPException):
            return handle_http_exception(exc)
        if not is_api_request():
            return InternalServerError(original_exception=exc)
        logger.exception("Unhandled API exception for %s", request.path)
        friendly = planner_db_connect_error(exc)
        return json_error_response(friendly or str(exc) or exc.__class__.__name__, 500)
