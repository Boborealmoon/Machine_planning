#!/usr/bin/env python3
"""Send the daily planner Excel snapshot when the scheduled time is reached."""

from __future__ import annotations

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from dotenv import load_dotenv

load_dotenv(os.path.join(_REPO_ROOT, ".env"))


def main() -> int:
    from planning.planner_email_service import send_planner_email, should_send_scheduled_now

    force = "--force" in sys.argv or "-f" in sys.argv
    if not force and not should_send_scheduled_now():
        print("Daily planner email skipped (disabled, already sent, or not scheduled time).")
        return 0
    try:
        result = send_planner_email(force=force)
    except ValueError as exc:
        print(f"Daily planner email skipped: {exc}")
        return 0
    except Exception as exc:
        print(f"Daily planner email FAILED: {exc}")
        return 1
    print(result.get("message") or "Daily planner email sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
