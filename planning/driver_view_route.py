"""Driver delivery schedule view — read-only shop-floor page (no passcode)."""
from __future__ import annotations

import os

from flask import Blueprint, redirect, render_template, url_for

_DEFAULT_DRIVER_VIEW_PATH = "/delivery-schedule-view"
_LEGACY_DRIVER_VIEW_PATH = "/driver-view"


def driver_view_path() -> str:
    raw = (os.getenv("DRIVER_VIEW_PATH") or _DEFAULT_DRIVER_VIEW_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


DRIVER_VIEW_PATH = driver_view_path()


def driver_view_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "driver_view.js"),
        os.path.join(root, "static", "css", "driver_view.css"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"driver-{int(mt)}"
    except OSError:
        return "driver-dev"


driver_view_bp = Blueprint("driver_view", __name__)


@driver_view_bp.get(DRIVER_VIEW_PATH)
def driver_view_page():
    return render_template(
        "driver_view.html",
        active="driver_view",
        driver_asset_version=driver_view_asset_version(),
    )


if DRIVER_VIEW_PATH != _LEGACY_DRIVER_VIEW_PATH:

    @driver_view_bp.get(_LEGACY_DRIVER_VIEW_PATH)
    def driver_view_legacy_redirect():
        return redirect(url_for("driver_view.driver_view_page"), code=301)
