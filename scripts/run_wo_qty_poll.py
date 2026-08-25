"""5-minute WO qty poll: COMAIN Postgres read + jump inserts only.

Does not reload mfg_wo_status, rebuild caches, or start the Flask app.

Run from repo root:
  python -u scripts/run_wo_qty_poll.py
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("WERKZEUG_RUN_MAIN", "false")

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO))

from planning.erp_scanned_output_service import run_wo_qty_poll  # noqa: E402


def _log_dir() -> Path:
    path = _REPO / "logs"
    path.mkdir(exist_ok=True)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Poll COMAIN WO qty and record ERP scanned-output jumps")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run even outside weekdays 07:00-19:00",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger("wo_qty_poll")
    stamp = datetime.now().strftime("%Y-%m-%d")
    log_path = _log_dir() / f"wo-qty-poll-{stamp}.log"
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger().addHandler(file_handler)

    started = datetime.now(timezone.utc).isoformat()
    logger.info("WO qty poll start")
    try:
        result = run_wo_qty_poll(force=args.force)
    except Exception:
        logger.exception("WO qty poll failed")
        return 1
    logger.info("WO qty poll result %s", json.dumps(result, default=str))
    if result.get("skipped"):
        logger.info("WO qty poll skipped: %s (started %s)", result.get("reason"), started)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
