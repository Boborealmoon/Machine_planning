"""Match ERP / scheduler ops to Program / Tool List rows (Google Sheets → tool_list.db)."""
from __future__ import annotations

import re
from typing import Any


def normalize_ps_id(value: str) -> str:
    text = str(value or "").strip().upper()
    if "::" in text:
        text = text.split("::", 1)[0]
    return re.sub(r"\s+", "", text)


def normalize_part_no(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().upper())


def normalize_op_no(*candidates: str) -> str:
    for raw in candidates:
        text = str(raw or "").strip()
        if not text:
            continue
        tail = re.search(r"(\d+)\s*$", text)
        if tail:
            digits = tail.group(1).lstrip("0")
            return digits or "0"
        head = re.match(r"^(\d+)", text)
        if head:
            digits = head.group(1).lstrip("0")
            return digits or "0"
    return ""


def ps_op_key(ps_id: str, *op_candidates: str) -> str:
    ps = normalize_ps_id(ps_id)
    op = normalize_op_no(*op_candidates)
    if not ps or not op:
        return ""
    return f"{ps}|{op}"


def normalize_bom_code(value: str) -> str:
    text = re.sub(r"\s+", "", str(value or "").strip().upper())
    return re.sub(r"[^A-Z0-9]+", "", text) if text else ""


def part_bom_op_key(part_no: str, bom_code: str, *op_candidates: str) -> str:
    part = normalize_part_no(part_no)
    bom = normalize_bom_code(bom_code)
    op = normalize_op_no(*op_candidates)
    if not part or not bom or not op:
        return ""
    return f"PART|{part}|{bom}|{op}"


def part_op_key(part_no: str, *op_candidates: str) -> str:
    part = normalize_part_no(part_no)
    op = normalize_op_no(*op_candidates)
    if not part or not op:
        return ""
    return f"PART|{part}|{op}"


def _row_links(row: dict[str, Any]) -> dict[str, str]:
    return {
        "program_no": str(row.get("program_no") or "").strip(),
        "program_file": str(row.get("program_file") or "").strip(),
        "tool_list_files": str(row.get("tool_list_files") or "").strip(),
        "programmer_name": str(row.get("programmer_name") or "").strip(),
    }


def _prefer_row(current: dict[str, str] | None, candidate: dict[str, str]) -> dict[str, str]:
    if not current:
        return candidate
    cur_score = sum(1 for v in current.values() if v)
    new_score = sum(1 for v in candidate.values() if v)
    if new_score > cur_score:
        return candidate
    return current


def build_program_tools_lookup(rows: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    """Build lookup maps keyed by ps|op, PART|part|bom|op, and PART|part|op."""
    by_ps_op: dict[str, dict[str, str]] = {}
    by_part_bom_op: dict[str, dict[str, str]] = {}
    by_part_op: dict[str, dict[str, str]] = {}

    for row in rows:
        links = _row_links(row)
        if not any(links.values()):
            continue

        ps_values = [
            row.get("ps_no"),
            row.get("process_sheet_no"),
        ]
        op_values = [
            row.get("operation_no"),
            row.get("operation_no_2"),
        ]
        part_values = [
            row.get("part_number"),
            row.get("part_no_erp"),
        ]
        bom_code = str(
            row.get("bom_code") or row.get("erp_bom_code") or ""
        ).strip()

        for ps in ps_values:
            key = ps_op_key(ps, *op_values)
            if key:
                by_ps_op[key] = _prefer_row(by_ps_op.get(key), links)

        part = next((str(p or "").strip() for p in part_values if p), "")
        if part and bom_code:
            pbkey = part_bom_op_key(part, bom_code, *op_values)
            if pbkey:
                by_part_bom_op[pbkey] = _prefer_row(by_part_bom_op.get(pbkey), links)

        pkey = part_op_key(part, *op_values)
        if pkey:
            by_part_op[pkey] = _prefer_row(by_part_op.get(pkey), links)

    return {
        "by_ps_op": by_ps_op,
        "by_part_bom_op": by_part_bom_op,
        "by_part_op": by_part_op,
    }


def lookup_program_tools(
    lookup: dict[str, dict[str, dict[str, str]]] | None,
    *,
    ps_id: str,
    part_no: str = "",
    bom_code: str = "",
    source_op_no: str = "",
    operation_label: str = "",
    operation_name: str = "",
) -> dict[str, str] | None:
    if not lookup:
        return None
    op_candidates = (source_op_no, operation_label, operation_name)
    key = ps_op_key(ps_id, *op_candidates)
    hit = lookup.get("by_ps_op", {}).get(key)
    if hit:
        return hit
    pbkey = part_bom_op_key(part_no, bom_code, *op_candidates)
    if pbkey:
        hit = lookup.get("by_part_bom_op", {}).get(pbkey)
        if hit:
            return hit
    pkey = part_op_key(part_no, *op_candidates)
    return lookup.get("by_part_op", {}).get(pkey)
