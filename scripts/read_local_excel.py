#!/usr/bin/env python3
"""Read a local Excel workbook and print JSON to stdout.

Examples:
  python scripts/read_local_excel.py --path "C:\\data\\orders.xlsx"
  python scripts/read_local_excel.py --path data/orders.xlsx --sheet "Sheet1"
  python scripts/read_local_excel.py --path data/orders.xlsx --all-sheets
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from planning.excel_local import read_workbook  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract a local Excel sheet as JSON")
    parser.add_argument(
        "--path",
        default=os.getenv("LOCAL_EXCEL_PATH", ""),
        help="Workbook path (absolute or relative to app root). Defaults to LOCAL_EXCEL_PATH.",
    )
    parser.add_argument("--sheet", default=os.getenv("LOCAL_EXCEL_SHEET", "") or None, help="Sheet name")
    parser.add_argument("--all-sheets", action="store_true", help="Return every sheet")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = parser.parse_args()

    if not args.path:
        parser.error("Provide --path or set LOCAL_EXCEL_PATH in .env")

    try:
        payload = read_workbook(args.path, sheet=args.sheet, all_sheets=args.all_sheets)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    indent = 2 if args.pretty else None
    print(json.dumps(payload, indent=indent, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
