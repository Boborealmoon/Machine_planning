"""Refresh AUK_ACCESS_TOKEN by signing in to Auk.

Reads AUK_USERNAME and AUK_PASSWORD from .env. Writes the new token back to
.env. Safe to run every 6 hours; a refresh from the last 5 hours is skipped
unless the stored token is already expired.

  python scripts/refresh_auk_token.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env", encoding="utf-8-sig")

from planning.auk_auth import credentials_configured, refresh_auk_token  # noqa: E402


def main() -> int:
    if not credentials_configured():
        print("Skipped: set AUK_USERNAME and AUK_PASSWORD in .env")
        return 0
    token = refresh_auk_token(force=True)
    if not token:
        print("Auk login did not return a token")
        return 1
    print("Auk access token is up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
