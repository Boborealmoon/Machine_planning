"""Programme checklist: inventory BOM machining parts vs Program / Tool Tracker."""
from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Any

from program_tools_lookup import normalize_bom_code, normalize_op_no, normalize_part_no

from .helpers import one, planner_db, planner_try_savepoint, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

_CNC_PREFIXES = ("turnmill", "turning", "milling")
_STATUS_RANK = {"missing": 0, "partial": 1, "have": 2}


def clean_prefix(value: Any) -> str:
    """Part-number prefix. ``*`` / ``all`` / blank means every part."""
    text = compact_text(value).upper()
    if text in {"*", "ALL"}:
        return ""
    return re.sub(r"[^A-Z0-9]", "", text)[:12]


def _op_text(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, float):
        if value != value:
            return ""
        if value == int(value):
            return str(int(value))
    if isinstance(value, int):
        return str(value)
    text = compact_text(value)
    if re.fullmatch(r"\d+\.0+", text):
        return str(int(float(text)))
    return text


def _op_type(stage_desc: Any) -> str:
    text = compact_text(stage_desc).lower()
    for name in _CNC_PREFIXES:
        if text.startswith(name):
            return name
    return ""


def _is_machining_stage(stage_desc: Any) -> bool:
    return bool(_op_type(stage_desc))


def _include_programme(operation_type: str) -> bool:
    label = compact_text(operation_type).lower()
    if not label:
        return True
    return any(label.startswith(name) for name in _CNC_PREFIXES)


def _pct(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(1000 * numerator / denominator) / 10


def programme_entries_from_tool_rows(tool_rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Tracker rows that count as a collected machining programme."""
    entries: list[dict[str, Any]] = []
    for row in tool_rows or []:
        if not isinstance(row, dict):
            continue
        operation_type = compact_text(row.get("operation_type"))
        if not _include_programme(operation_type):
            continue
        program_no = compact_text(row.get("program_no"))
        program_file = compact_text(row.get("program_file"))
        if not program_no and not program_file:
            continue
        part_norms = []
        for raw in (row.get("part_no_erp"), row.get("part_number")):
            norm = normalize_part_no(raw)
            if norm and norm not in part_norms:
                part_norms.append(norm)
        if not part_norms:
            continue
        op_raw = _op_text(row.get("operation_no")) or _op_text(row.get("operation_no_2"))
        entries.append(
            {
                "parts": part_norms,
                "bom_norm": normalize_bom_code(row.get("bom_code") or row.get("erp_bom_code") or ""),
                "bom_code": compact_text(row.get("bom_code") or row.get("erp_bom_code") or ""),
                "op_norm": normalize_op_no(op_raw),
                "op_no": op_raw,
                "op_type": _op_type(operation_type) or compact_text(operation_type).lower(),
                "operation_type": operation_type,
                "program_no": program_no,
                "program_file": program_file,
                "programmer_name": compact_text(row.get("programmer_name")),
            }
        )
    return entries


def _bom_op(row: dict[str, Any]) -> dict[str, Any] | None:
    stage_desc = compact_text(row.get("stage_desc"))
    if not _is_machining_stage(stage_desc):
        return None
    op_raw = _op_text(row.get("op_no")) or _op_text(normalize_op_no(stage_desc))
    op_norm = normalize_op_no(op_raw, stage_desc)
    return {
        "bom_code": compact_text(row.get("bom_code")),
        "bom_norm": normalize_bom_code(row.get("bom_code")),
        "stage_desc": stage_desc,
        "stage_no": row.get("stage_no"),
        "op_no": op_norm or op_raw,
        "op_norm": op_norm,
        "op_type": _op_type(stage_desc),
    }


def _stage_sort_key(op: dict[str, Any]) -> tuple:
    digits = op.get("op_norm") or ""
    number = int(digits) if str(digits).isdigit() else 10**9
    stage_no = op.get("stage_no")
    try:
        stage_number = float(stage_no)
    except (TypeError, ValueError):
        stage_number = 10**9
    return (number, stage_number, op.get("stage_desc") or "")


def _cover_ops(ops: list[dict[str, Any]], programmes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], set[int]]:
    used: set[int] = set()
    covered: list[dict[str, Any]] = []
    for op in ops:
        choice: int | None = None
        choice_rank: tuple | None = None
        for index, prog in enumerate(programmes):
            if index in used:
                continue
            if op["op_norm"]:
                if prog["op_norm"] != op["op_norm"]:
                    continue
            elif op["op_type"] and prog["op_type"] and prog["op_type"] != op["op_type"]:
                continue
            if prog["bom_norm"] and op["bom_norm"] and prog["bom_norm"] != op["bom_norm"]:
                continue
            rank = (
                1 if prog["program_file"] else 0,
                1 if prog["program_no"] else 0,
                1 if prog["bom_norm"] and prog["bom_norm"] == op["bom_norm"] else 0,
            )
            if choice is None or rank > choice_rank:
                choice = index
                choice_rank = rank
        hit = programmes[choice] if choice is not None else None
        if choice is not None:
            used.add(choice)
        covered.append(
            {
                "stage_desc": op["stage_desc"],
                "op_no": op["op_no"],
                "op_type": op["op_type"],
                "collected": hit is not None,
                "program_no": (hit or {}).get("program_no") or "",
                "program_file": (hit or {}).get("program_file") or "",
                "programmer_name": (hit or {}).get("programmer_name") or "",
            }
        )
    return covered, used


def assemble_programme_checklist(
    bom_rows: list[dict[str, Any]] | None,
    programmes: list[dict[str, Any]] | None,
    descriptions: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """One row per part. Coverage is against that part's latest BOM code."""
    desc_map = descriptions or {}
    by_part: dict[str, list[dict[str, Any]]] = {}
    raw_names: dict[str, list[str]] = {}
    for row in bom_rows or []:
        if not isinstance(row, dict):
            continue
        part_raw = compact_text(row.get("inventory_code") or row.get("part_no"))
        part_norm = normalize_part_no(part_raw)
        op = _bom_op(row)
        if not part_norm or op is None:
            continue
        by_part.setdefault(part_norm, []).append(op)
        raw_names.setdefault(part_norm, []).append(part_raw)

    programmes_by_part: dict[str, list[dict[str, Any]]] = {}
    for prog in programmes or []:
        for part_norm in prog.get("parts") or []:
            programmes_by_part.setdefault(part_norm, []).append(prog)

    checklist: list[dict[str, Any]] = []
    for part_norm, ops in by_part.items():
        bom_groups: dict[str, dict[str, Any]] = {}
        for op in ops:
            group = bom_groups.setdefault(
                op["bom_norm"],
                {"bom_code": op["bom_code"], "codes": [], "ops": []},
            )
            if op["bom_code"]:
                group["codes"].append(op["bom_code"])
            group["ops"].append(op)
        if not bom_groups:
            continue
        for group in bom_groups.values():
            if group["codes"]:
                group["bom_code"] = Counter(group["codes"]).most_common(1)[0][0]
            group["ops"] = sorted(group["ops"], key=_stage_sort_key)
            seen: set[tuple[str, str]] = set()
            unique_ops = []
            for op in group["ops"]:
                key = (op["op_norm"] or op["stage_desc"], op["stage_desc"])
                if key in seen:
                    continue
                seen.add(key)
                unique_ops.append(op)
            group["ops"] = unique_ops

        current_key = max(bom_groups, key=lambda key: (bom_groups[key]["bom_code"] or "").upper())
        part_programmes = programmes_by_part.get(part_norm) or []
        bom_payloads = []
        current_payload = None
        for key, group in bom_groups.items():
            covered, _used = _cover_ops(group["ops"], part_programmes)
            collected = sum(1 for op in covered if op["collected"])
            payload = {
                "bom_code": group["bom_code"],
                "current": key == current_key,
                "ops_required": len(covered),
                "ops_collected": collected,
                "ops": covered,
            }
            bom_payloads.append(payload)
            if key == current_key:
                current_payload = payload
        bom_payloads.sort(key=lambda item: (not item["current"], (item["bom_code"] or "").upper()))
        if current_payload is None:
            continue

        current_ops = current_payload["ops"]
        _, used_on_current = _cover_ops(
            bom_groups[current_key]["ops"],
            part_programmes,
        )
        required = current_payload["ops_required"]
        collected = current_payload["ops_collected"]
        if collected == required and required > 0:
            status = "have"
        elif collected == 0 and not part_programmes:
            status = "missing"
        else:
            status = "partial"
        programme_nos = []
        for op in current_ops:
            if op["program_no"] and op["program_no"] not in programme_nos:
                programme_nos.append(op["program_no"])
        missing_ops = [op["stage_desc"] or op["op_no"] for op in current_ops if not op["collected"]]
        other = []
        for index, prog in enumerate(part_programmes):
            if index in used_on_current:
                continue
            other.append(
                {
                    "bom_code": prog["bom_code"],
                    "op_no": prog["op_no"],
                    "operation_type": prog["operation_type"],
                    "program_no": prog["program_no"],
                    "program_file": prog["program_file"],
                    "programmer_name": prog["programmer_name"],
                }
            )
        display = Counter(raw_names.get(part_norm) or [part_norm]).most_common(1)[0][0]
        checklist.append(
            {
                "part_no": display,
                "description": compact_text(desc_map.get(part_norm) or desc_map.get(display) or ""),
                "status": status,
                "bom_code": current_payload["bom_code"],
                "bom_count": len(bom_payloads),
                "ops_required": required,
                "ops_collected": collected,
                "programme_nos": programme_nos,
                "missing_ops": missing_ops,
                "other_programmes": other,
                "boms": bom_payloads,
            }
        )

    checklist.sort(key=lambda item: (_STATUS_RANK.get(item["status"], 9), item["part_no"]))
    have = sum(1 for item in checklist if item["status"] == "have")
    partial = sum(1 for item in checklist if item["status"] == "partial")
    missing = sum(1 for item in checklist if item["status"] == "missing")
    ops_required = sum(item["ops_required"] for item in checklist)
    ops_collected = sum(item["ops_collected"] for item in checklist)
    stats = {
        "parts": len(checklist),
        "have": have,
        "partial": partial,
        "missing": missing,
        "ops_required": ops_required,
        "ops_collected": ops_collected,
        "pct_parts": _pct(have, len(checklist)),
        "pct_programmes": _pct(ops_collected, ops_required),
    }
    return checklist, stats


def _prefix_clause(prefix: str) -> tuple[str, tuple]:
    if not prefix:
        return "", ()
    return " AND inventory_code ILIKE %s", (prefix + "%",)


def _load_planner_machining(prefix: str) -> list[dict[str, Any]] | None:
    clause, params = _prefix_clause(prefix)
    sql = f"""
        SELECT
            BTRIM(inventory_code) AS inventory_code,
            BTRIM(COALESCE(bom_code, '')) AS bom_code,
            stage_no,
            BTRIM(COALESCE(stage_desc, '')) AS stage_desc,
            op_no
        FROM public.bom_op_stage
        WHERE BTRIM(COALESCE(inventory_code, '')) <> ''
          AND (
              stage_desc ILIKE 'Turning%%'
           OR stage_desc ILIKE 'Milling%%'
           OR stage_desc ILIKE 'Turnmill%%'
          )
        {clause}
    """
    try:
        with planner_db() as con:
            total = one(con.execute("SELECT COUNT(*)::int AS n FROM public.bom_op_stage"))
            if not total or int(total.get("n") or 0) <= 0:
                return None
            return rows(con.execute(sql, params))
    except Exception:
        logger.exception("programme list bom_op_stage lookup failed")
        return None


def _load_live_machining(prefix: str) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    clause, params = _prefix_clause(prefix)
    sql = f"""
        SELECT
            BTRIM(inventory_code) AS inventory_code,
            BTRIM(COALESCE(bom_code, '')) AS bom_code,
            stage_no,
            BTRIM(COALESCE(stage_desc, '')) AS stage_desc,
            CASE
                WHEN stage_desc ~ ' [0-9]+$'
                THEN substring(stage_desc FROM ' ([0-9]+)$')
                ELSE NULL
            END AS op_no
        FROM public.mt_inventory_bom_stage
        WHERE inventory_code IS NOT NULL
          AND BTRIM(inventory_code) <> ''
          AND (
              stage_desc ILIKE 'Turning%%'
           OR stage_desc ILIKE 'Milling%%'
           OR stage_desc ILIKE 'Turnmill%%'
          )
        {clause}
    """
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            found = cur.fetchall() or []
        return [
            {
                "inventory_code": compact_text(row[0]),
                "bom_code": compact_text(row[1]),
                "stage_no": row[2],
                "stage_desc": compact_text(row[3]),
                "op_no": row[4],
            }
            for row in found
        ]
    finally:
        release_conn(conn)


def _descriptions_for(codes: list[str]) -> dict[str, str]:
    wanted = sorted({compact_text(code) for code in codes if compact_text(code)})
    if not wanted:
        return {}
    found: dict[str, str] = {}

    try:
        with planner_db() as con:
            def _read_planner():
                return rows(
                    con.execute(
                        """
                        SELECT BTRIM(inventory_code) AS inventory_code,
                               BTRIM(COALESCE(main_desc, '')) AS description
                        FROM public.part_desc
                        WHERE BTRIM(inventory_code) = ANY(%s)
                        """,
                        (wanted,),
                    )
                )

            desc_rows = planner_try_savepoint(con, "programme_list_part_desc", _read_planner, default=None)
        for row in desc_rows or []:
            key = normalize_part_no(row.get("inventory_code"))
            text = compact_text(row.get("description"))
            if key and text:
                found[key] = text
    except Exception:
        logger.exception("programme list part_desc lookup failed")

    missing = [code for code in wanted if normalize_part_no(code) not in found]
    if not missing:
        return found
    try:
        from db import get_conn, release_conn

        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT BTRIM(inventory_code), BTRIM(COALESCE(main_desc, ''))
                    FROM public.mt_inventory
                    WHERE BTRIM(inventory_code) = ANY(%s)
                    """,
                    (missing,),
                )
                live_rows = cur.fetchall() or []
        finally:
            release_conn(conn)
        for code, description in live_rows:
            key = normalize_part_no(code)
            text = compact_text(description)
            if key and text and key not in found:
                found[key] = text
    except Exception:
        logger.exception("programme list inventory description lookup failed")
    return found


def _load_programmes() -> tuple[list[dict[str, Any]], str | None]:
    from tool_list_db import fetch_all, init_db, last_synced

    from .program_tool_list_route import _enrich_rows_for_display

    init_db()
    tool_rows = fetch_all()
    try:
        _enrich_rows_for_display(tool_rows)
    except Exception:
        logger.exception("programme list tool-list enrich failed")
    return programme_entries_from_tool_rows(tool_rows), last_synced()


def programme_list_payload(prefix: str | None = "BB") -> dict[str, Any]:
    """Machining parts from inventory BOM, crossed with the programme tracker."""
    part_prefix = "BB" if prefix is None else clean_prefix(prefix)
    bom_rows = _load_planner_machining(part_prefix)
    source = "bom_op_stage"
    if bom_rows is None:
        bom_rows = _load_live_machining(part_prefix)
        source = "inventory_bom"
    descriptions = _descriptions_for([row.get("inventory_code") for row in bom_rows])
    programmes, last_synced = _load_programmes()
    checklist, stats = assemble_programme_checklist(bom_rows, programmes, descriptions)
    return {
        "ok": True,
        "prefix": part_prefix,
        "source": source,
        "last_synced": last_synced,
        "stats": stats,
        "rows": checklist,
    }
