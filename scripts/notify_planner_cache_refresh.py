"""Notify the running Flask app to refresh in-process ERP read caches after scheduled sync."""
from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger(__name__)


def notify_planner_cache_refresh(*, timeout: float = 30.0) -> dict:
    """POST to the planner app so list/count caches rebuild after external ERP sync."""
    base = os.getenv("PLANNER_BASE_URL", "http://127.0.0.1:5001").rstrip("/")
    url = f"{base}/api/pp-staging/cache-refresh"
    headers: dict[str, str] = {}
    secret = os.getenv("ERP_CACHE_REFRESH_SECRET", "").strip()
    if secret:
        headers["X-ERP-Cache-Refresh"] = secret

    try:
        response = requests.post(url, headers=headers, timeout=timeout)
        payload = response.json() if response.content else {}
        if response.ok:
            logger.info("planner cache refresh notified: %s", payload)
            return {"ok": True, **payload}
        logger.warning(
            "planner cache refresh failed (%s): %s",
            response.status_code,
            payload.get("error") or response.text,
        )
        return {
            "ok": False,
            "status_code": response.status_code,
            "error": payload.get("error") or response.text,
        }
    except Exception as exc:
        logger.warning("planner cache refresh notify failed: %s", exc)
        return {"ok": False, "error": str(exc)}
