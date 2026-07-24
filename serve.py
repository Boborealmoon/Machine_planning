"""Production HTTP server for Machine Planning (Waitress on Windows).

Foreground:
    python serve.py

Windows service (after scripts/install_waitress_service.ps1):
    nssm start MachinePlanning-Web

Environment (see .env.example):
    WAITRESS_HOST, WAITRESS_PORT / FLASK_PORT, WAITRESS_THREADS
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time

_APP_ROOT = os.path.dirname(os.path.abspath(__file__))
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)

from dotenv import load_dotenv

# utf-8-sig strips a leading BOM so keys like DB_HOST are not read as \ufeffDB_HOST
load_dotenv(os.path.join(_APP_ROOT, ".env"), encoding="utf-8-sig")

_log_format = "%(asctime)s %(levelname)s %(name)s: %(message)s"
logging.basicConfig(level=logging.INFO, format=_log_format)
log = logging.getLogger("serve")

_log_file = (os.getenv("WAITRESS_LOG_FILE") or "").strip()
if _log_file:
    _log_path = _log_file if os.path.isabs(_log_file) else os.path.join(_APP_ROOT, _log_file)
    os.makedirs(os.path.dirname(_log_path) or _APP_ROOT, exist_ok=True)
    _fh = logging.FileHandler(_log_path, encoding="utf-8")
    _fh.setFormatter(logging.Formatter(_log_format))
    logging.getLogger().addHandler(_fh)


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    return max(1, int(raw))


def main() -> None:
    from waitress import serve

    from app import (
        FINISHING_QUEUE_PATH,
        MACHINIST_BOARD_PATH,
        PLANNER_PATH,
        SCHEDULER_ASSET_VERSION,
        app,
    )

    host = (os.getenv("WAITRESS_HOST") or "127.0.0.1").strip()
    port = _env_int("WAITRESS_PORT", _env_int("FLASK_PORT", 5001))
    threads = _env_int("WAITRESS_THREADS", 12)
    channel_timeout = _env_int("WAITRESS_CHANNEL_TIMEOUT", 120)

    log.info("Waitress starting on http://%s:%s (threads=%s)", host, port, threads)
    log.info("planner: http://%s:%s%s", host, port, PLANNER_PATH)
    log.info("machinist board: http://%s:%s%s", host, port, MACHINIST_BOARD_PATH)
    log.info("QAQC view: http://%s:%s%s", host, port, FINISHING_QUEUE_PATH)
    log.info("scheduler asset build: %s", SCHEDULER_ASSET_VERSION)

    def _warm_catalog():
        time.sleep(2)
        try:
            from app import warm_pp_vouchers_with_ops_cache

            warm_pp_vouchers_with_ops_cache()
        except Exception as exc:
            log.warning("catalog warm-up failed: %s", exc)

    threading.Thread(target=_warm_catalog, daemon=True, name="pp-vouchers-warm").start()

    serve(
        app,
        host=host,
        port=port,
        threads=threads,
        channel_timeout=channel_timeout,
    )


if __name__ == "__main__":
    main()
