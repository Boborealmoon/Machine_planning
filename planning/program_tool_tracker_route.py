"""Prototype: match process sheet ops to Program / Tool List rows."""
from __future__ import annotations

import re
from typing import Any

from flask import Blueprint, jsonify, redirect, render_template, request

from program_tools_lookup import (
    build_program_tools_lookup,
    lookup_program_tools,
    normalize_bom_code,
    normalize_op_no,
    normalize_part_no,
    normalize_ps_id,
    part_bom_op_key,
    part_op_key,
    ps_op_key,
)
from .helpers import planner_db
from .process_sheets import list_process_sheets_payload
from .program_tool_list_route import _enrich_rows_for_display
from .utils import compact_text, shipped_quantity_completed

program_tool_tracker_bp = Blueprint("program_tool_tracker", __name__)

_CNC_OP_PREFIXES = ("turning", "milling", "turnmill")
_EXCLUDED_OP_PREFIXES = (
    "deburr",
    "pack",
    "inspect",
    "inspection",
    "final inspection",
    "shipping",
    "delivery",
    "wash",
    "clean",
    "assemble",
    "assembly",
    "mark",
    "engrav",
)
_PS_TYPE_RE = re.compile(r"^([A-Z]+)", re.IGNORECASE)


def _to_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _is_active_outstanding_ps(ps: dict[str, Any]) -> bool:
    """Active PS still open on production and/or shipment (SO qty > shipped, ops not done)."""
    if bool(ps.get("is_completed")):
        return False

    so_qty = ps.get("so_det_qty")
    qty_shipped = _to_float(ps.get("qty_shipped"))
    if so_qty is not None and _to_float(so_qty) > qty_shipped + 0.0001:
        return True

    if bool(ps.get("pending_do")):
        return True
    if not bool(ps.get("shipped_completed")):
        return True
    if not bool(ps.get("production_completed")):
        return True
    if not bool(ps.get("execution_completed")):
        return True

    remaining = _to_float(ps.get("remaining_qty"))
    if remaining > 0.0001:
        return True

    if so_qty is not None and not shipped_quantity_completed(so_qty, qty_shipped):
        return True

    return True


def _ps_type(ps: dict[str, Any]) -> str:
    ps_id = compact_text(ps.get("ps_id") or "")
    if ps_id.upper().startswith("[TEMP]"):
        return "TEMP"
    raw = compact_text(ps.get("source_ps_id") or ps.get("display_ps_id") or ps_id).split("::", 1)[0]
    if re.search(r"\[sr\]", raw, re.IGNORECASE):
        return "SR"
    match = _PS_TYPE_RE.match(raw.upper())
    if not match:
        return ""
    prefix = match.group(1).upper()
    if prefix in {"MPS", "APS", "NPS", "PPS", "CPS", "SR"}:
        return prefix
    return prefix


def _requires_programme_tool_list(op: dict[str, Any]) -> bool:
    """Only Turning / Milling / Turnmill need programme + tool-list coverage."""
    label = compact_text(op.get("op_type") or op.get("stage_desc") or "").lower()
    if not label:
        return False
    if any(label.startswith(prefix) for prefix in _EXCLUDED_OP_PREFIXES):
        return False
    return any(label.startswith(prefix) for prefix in _CNC_OP_PREFIXES)


def _is_cnc_op(op: dict[str, Any]) -> bool:
    return _requires_programme_tool_list(op)


def _tool_row_part(row: dict[str, Any]) -> str:
    return normalize_part_no(row.get("part_no_erp") or row.get("part_number") or "")


def _tool_row_ps(row: dict[str, Any]) -> str:
    return normalize_ps_id(row.get("ps_no") or row.get("process_sheet_no") or "")


def _tool_row_op_sig(row: dict[str, Any]) -> tuple[str, str]:
    op_no = normalize_op_no(row.get("operation_no"), row.get("operation_no_2"))
    op_type = compact_text(row.get("operation_type") or "").lower()
    return op_no, op_type


def _build_tool_list_indexes(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_ps_op: set[str] = set()
    by_part_op: set[str] = set()
    by_part_bom_op: set[str] = set()
    ps_ops: dict[str, set[tuple[str, str]]] = {}
    part_ops: dict[str, set[tuple[str, str]]] = {}
    part_bom_ops: dict[tuple[str, str], set[tuple[str, str]]] = {}

    for row in rows:
        part = _tool_row_part(row)
        ps = _tool_row_ps(row)
        bom = normalize_bom_code(row.get("bom_code") or row.get("erp_bom_code") or "")
        op_no, op_type = _tool_row_op_sig(row)
        if not op_no:
            continue

        if ps:
            by_ps_op.add(ps_op_key(ps, op_no))
            ps_ops.setdefault(ps, set()).add((op_no, op_type))

        if part:
            by_part_op.add(part_op_key(part, op_no))
            part_ops.setdefault(part, set()).add((op_no, op_type))
            if bom:
                by_part_bom_op.add(part_bom_op_key(part, bom, op_no))
                part_bom_ops.setdefault((part, bom), set()).add((op_no, op_type))

    return {
        "by_ps_op": by_ps_op,
        "by_part_op": by_part_op,
        "by_part_bom_op": by_part_bom_op,
        "ps_ops": ps_ops,
        "part_ops": part_ops,
        "part_bom_ops": part_bom_ops,
    }


def _match_status(
    *,
    hit: dict[str, str] | None,
    part_match: bool,
    bom_aligned: bool,
) -> str:
    programme_ready = bool((hit or {}).get("program_file"))
    tool_ready = bool((hit or {}).get("tool_list_files"))

    if programme_ready and tool_ready and part_match and bom_aligned:
        return "full"
    if programme_ready or tool_ready or part_match or bom_aligned:
        return "partial"
    return "missing"


def _evaluate_op_match(
    ps: dict[str, Any],
    op: dict[str, Any],
    lookup: dict[str, dict[str, dict[str, str]]],
    indexes: dict[str, Any],
) -> dict[str, Any]:
    ps_id = compact_text(ps.get("display_ps_id") or ps.get("source_ps_id") or ps.get("ps_id"))
    source_ps_id = compact_text(ps.get("source_ps_id") or ps_id).split("::", 1)[0]
    part_no = compact_text(ps.get("inventory_code") or ps.get("part_no") or ps.get("part_name"))
    part_norm = normalize_part_no(part_no)
    bom_code = compact_text(
        ps.get("selected_flow_code") or ps.get("erp_bom_code") or ps.get("route_label") or ""
    )
    bom_norm = normalize_bom_code(bom_code)
    ps_norm = normalize_ps_id(source_ps_id)
    op_no = compact_text(op.get("op_no") or "")
    op_norm = normalize_op_no(op_no, op.get("stage_desc"), op.get("op_type"))
    op_type = compact_text(op.get("op_type") or op.get("stage_desc") or "")

    hit = lookup_program_tools(
        lookup,
        ps_id=ps_id,
        part_no=part_no,
        bom_code=bom_code,
        source_op_no=op_no,
        operation_label=op.get("stage_desc") or "",
        operation_name=op.get("op_type") or "",
    )

    ps_key = ps_op_key(ps_norm, op_norm) if ps_norm and op_norm else ""
    part_key = part_op_key(part_norm, op_norm) if part_norm and op_norm else ""
    part_bom_key = (
        part_bom_op_key(part_norm, bom_norm, op_norm)
        if part_norm and bom_norm and op_norm
        else ""
    )
    part_match = bool(part_bom_key and part_bom_key in indexes["by_part_bom_op"])
    if not part_match:
        part_match = bool(part_key and part_key in indexes["by_part_op"])

    via = "none"
    if hit and part_bom_key and lookup.get("by_part_bom_op", {}).get(part_bom_key) is hit:
        via = "part_bom_op"
    elif hit and part_key and lookup.get("by_part_op", {}).get(part_key) is hit:
        via = "part_op"
    elif hit and ps_key and lookup.get("by_ps_op", {}).get(ps_key) is hit:
        via = "ps_op"

    bom_aligned = False
    if part_norm and bom_norm and op_norm:
        part_sig = (op_norm, op_type.lower())
        bom_aligned = part_sig in indexes["part_bom_ops"].get((part_norm, bom_norm), set())
    elif part_norm and op_norm:
        part_sig = (op_norm, op_type.lower())
        bom_aligned = part_sig in indexes["part_ops"].get(part_norm, set())

    programme_ready = bool((hit or {}).get("program_file"))
    tool_ready = bool((hit or {}).get("tool_list_files"))
    status = _match_status(
        hit=hit,
        part_match=part_match,
        bom_aligned=bom_aligned,
    )

    return {
        "op_no": op_no,
        "op_type": op_type,
        "stage_desc": compact_text(op.get("stage_desc") or ""),
        "execution_status": compact_text(op.get("execution_status") or ""),
        "is_cnc": True,
        "match": {
            "status": status,
            "via": via,
            "part_match": part_match,
            "bom_aligned": bom_aligned,
            "programme_ready": programme_ready,
            "tool_list_ready": tool_ready,
            "program_no": (hit or {}).get("program_no") or "",
            "program_file": (hit or {}).get("program_file") or "",
            "tool_list_files": (hit or {}).get("tool_list_files") or "",
            "programmer_name": (hit or {}).get("programmer_name") or "",
        },
    }


def _bom_tool_coverage(cnc_ops: list[dict[str, Any]]) -> str:
    if not cnc_ops:
        return "na"
    matched = sum(1 for op in cnc_ops if op["match"]["status"] in {"full", "partial"})
    if matched == 0:
        return "none"
    if matched == len(cnc_ops):
        return "full"
    return "partial"


def _tracker_sort_key(item: dict[str, Any]) -> tuple:
    return (
        -int(item.get("cnc_ops_missing") or 0),
        -int(item.get("cnc_ops_partial") or 0),
        compact_text(item.get("due_date") or "9999-99-99"),
        compact_text(item.get("display_ps_id") or ""),
        int(item.get("pp_partial_no") or 1),
    )


def build_program_tool_tracker_payload(
    *,
    search: str = "",
    show_completed: bool = False,
    match_filter: str = "",
    ps_type: str = "NPS",
) -> dict[str, Any]:
    from tool_list_db import fetch_all, init_db, last_synced

    init_db()
    tool_rows = fetch_all()
    _enrich_rows_for_display(tool_rows)
    lookup = build_program_tools_lookup(tool_rows)
    indexes = _build_tool_list_indexes(tool_rows)

    with planner_db() as con:
        ps_items = list_process_sheets_payload(
            con,
            search=search or None,
            show_completed=True,
        )

    items: list[dict[str, Any]] = []
    summary = {
        "process_sheets": 0,
        "cnc_ops": 0,
        "programme_ready": 0,
        "tool_list_ready": 0,
        "fully_matched": 0,
        "partial_matched": 0,
        "missing": 0,
    }

    match_filter = compact_text(match_filter).lower()
    ps_type_filter = compact_text(ps_type).upper()

    for ps in ps_items:
        item_ps_type = _ps_type(ps)
        if ps_type_filter and item_ps_type != ps_type_filter:
            continue
        if not show_completed and not _is_active_outstanding_ps(ps):
            continue
        ops = list(ps.get("ops") or [])
        tracked_ops = [op for op in ops if _requires_programme_tool_list(op)]
        evaluated_ops = [_evaluate_op_match(ps, op, lookup, indexes) for op in tracked_ops]
        cnc_ops = evaluated_ops

        for op in evaluated_ops:
            status = op["match"]["status"]
            summary["cnc_ops"] += 1
            if op["match"]["programme_ready"]:
                summary["programme_ready"] += 1
            if op["match"]["tool_list_ready"]:
                summary["tool_list_ready"] += 1
            if status == "full":
                summary["fully_matched"] += 1
            elif status == "partial":
                summary["partial_matched"] += 1
            else:
                summary["missing"] += 1

        coverage = _bom_tool_coverage(cnc_ops)
        missing_cnc = sum(1 for op in cnc_ops if op["match"]["status"] == "missing")
        partial_cnc = sum(1 for op in cnc_ops if op["match"]["status"] == "partial")
        full_cnc = sum(1 for op in cnc_ops if op["match"]["status"] == "full")

        item = {
            "ps_id": compact_text(ps.get("ps_id") or ""),
            "source_ps_id": compact_text(ps.get("source_ps_id") or ""),
            "display_ps_id": compact_text(ps.get("display_ps_id") or ps.get("ps_id") or ""),
            "pp_partial_no": int(ps.get("pp_partial_no") or 1),
            "ps_type": item_ps_type,
            "part_no": compact_text(ps.get("part_no") or ps.get("part_name") or ""),
            "inventory_code": compact_text(ps.get("inventory_code") or ""),
            "part_desc": compact_text(ps.get("part_desc") or ""),
            "route_label": compact_text(ps.get("route_label") or ""),
            "selected_flow_code": compact_text(ps.get("selected_flow_code") or ""),
            "erp_bom_code": compact_text(ps.get("erp_bom_code") or ""),
            "planner_status": compact_text(ps.get("planner_status") or ""),
            "current_stage_desc": compact_text(ps.get("current_stage_desc") or ""),
            "due_date": compact_text(ps.get("due_date") or ""),
            "display_qty": ps.get("display_qty"),
            "so_det_qty": _to_float(ps.get("so_det_qty")) if ps.get("so_det_qty") is not None else None,
            "qty_shipped": _to_float(ps.get("qty_shipped")),
            "shipped_completed": bool(ps.get("shipped_completed")),
            "is_completed": bool(ps.get("is_completed")),
            "production_completed": bool(ps.get("production_completed")),
            "execution_completed": bool(ps.get("execution_completed")),
            "pending_do": bool(ps.get("pending_do")),
            "is_outstanding": _is_active_outstanding_ps(ps),
            "bom_tool_coverage": coverage,
            "cnc_ops_total": len(cnc_ops),
            "cnc_ops_full": full_cnc,
            "cnc_ops_partial": partial_cnc,
            "cnc_ops_missing": missing_cnc,
            "ops": evaluated_ops,
        }

        if match_filter == "missing" and missing_cnc == 0:
            continue
        if match_filter == "partial" and partial_cnc == 0:
            continue
        if match_filter == "full" and (len(cnc_ops) == 0 or full_cnc != len(cnc_ops)):
            continue
        if match_filter == "any_gap" and missing_cnc == 0 and partial_cnc == 0:
            continue

        items.append(item)
        summary["process_sheets"] += 1

    items.sort(key=_tracker_sort_key)

    return {
        "ok": True,
        "last_synced": last_synced(),
        "tool_list_rows": len(tool_rows),
        "filters": {
            "ps_type": ps_type_filter or "ALL",
            "show_completed": show_completed,
            "match": match_filter or "all",
            "outstanding_only": not show_completed,
        },
        "summary": summary,
        "items": items,
    }


def _part_bom_map(ps_items: list[dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, set[str]] = {}
    for ps in ps_items:
        part = normalize_part_no(ps.get("inventory_code") or ps.get("part_no") or "")
        bom = compact_text(
            ps.get("selected_flow_code") or ps.get("erp_bom_code") or ps.get("route_label") or ""
        )
        if not part or not bom:
            continue
        out.setdefault(part, set()).add(bom)
    return {part: sorted(codes) for part, codes in out.items()}


def _catalogue_stage_label(row: dict[str, Any]) -> str:
    op_type = compact_text(row.get("operation_type") or "")
    op_no = compact_text(row.get("operation_no") or row.get("operation_no_2") or "")
    return f"{op_type} {op_no}".strip() if op_no else op_type


def build_program_tool_catalogue_payload(*, search: str = "") -> dict[str, Any]:
    """Browse synced programme / tool-list rows by part, BOM, and stage."""
    from tool_list_db import fetch_all, init_db, last_synced

    init_db()
    tool_rows = fetch_all()
    _enrich_rows_for_display(tool_rows)

    with planner_db() as con:
        ps_items = list_process_sheets_payload(con, show_completed=True)

    search_l = compact_text(search).lower()
    catalogue_rows: list[dict[str, Any]] = []

    for row in tool_rows:
        pseudo_op = {
            "op_type": row.get("operation_type") or "",
            "stage_desc": row.get("operation_type") or "",
        }
        if not _requires_programme_tool_list(pseudo_op):
            continue

        part_norm = _tool_row_part(row) or normalize_part_no(row.get("part_number") or "")
        part_no = compact_text(row.get("part_no_erp") or row.get("part_number") or "")
        bom_code = compact_text(row.get("bom_code") or row.get("erp_bom_code") or "")
        kit_bom = compact_text(row.get("kit_assembly_number") or row.get("kit_assembly_no") or "")
        bom_label = bom_code or kit_bom
        stage_label = _catalogue_stage_label(row)
        op_no = compact_text(row.get("operation_no") or row.get("operation_no_2") or "")

        entry = {
            "part_no": part_no,
            "part_no_norm": part_norm,
            "bom_code": bom_code,
            "bom_label": bom_label,
            "bom_codes": [bom_code] if bom_code else [],
            "operation_no": op_no,
            "operation_type": compact_text(row.get("operation_type") or ""),
            "stage_label": stage_label,
            "program_no": compact_text(row.get("program_no") or ""),
            "program_file": compact_text(row.get("program_file") or ""),
            "tool_list_files": compact_text(row.get("tool_list_files") or ""),
            "programmer_name": compact_text(row.get("programmer_name") or ""),
            "cnc_machine_no": compact_text(row.get("cnc_machine_no") or row.get("cnc_machine_no_2") or ""),
            "cycle_time": compact_text(row.get("cycle_time") or ""),
            "setup_time": compact_text(row.get("setup_time") or ""),
            "has_programme": bool(compact_text(row.get("program_file") or "")),
            "has_tool_list": bool(compact_text(row.get("tool_list_files") or "")),
        }

        if search_l:
            haystack = " ".join(
                [
                    entry["part_no"],
                    entry["bom_label"],
                    entry["stage_label"],
                    entry["operation_type"],
                    entry["operation_no"],
                    entry["program_no"],
                    entry["programmer_name"],
                    entry["cnc_machine_no"],
                ]
            ).lower()
            if search_l not in haystack:
                continue

        catalogue_rows.append(entry)

    catalogue_rows.sort(
        key=lambda r: (
            r.get("part_no_norm") or "",
            compact_text(r.get("operation_type")).lower(),
            normalize_op_no(r.get("operation_no") or ""),
        )
    )

    parts = len({r.get("part_no_norm") for r in catalogue_rows if r.get("part_no_norm")})

    return {
        "ok": True,
        "last_synced": last_synced(),
        "count": len(catalogue_rows),
        "parts": parts,
        "rows": catalogue_rows,
    }


@program_tool_tracker_bp.get("/planning-data/program-tool-tracker")
def program_tool_tracker_page():
    initial_view = request.args.get("view", "").strip().lower()
    if initial_view not in {"catalogue", "list"}:
        initial_view = "tracker"
    elif initial_view == "list":
        initial_view = "catalogue"
    return render_template(
        "planning_data/program_tool_tracker.html",
        active="program_tool_tracker",
        initial_view=initial_view,
    )


@program_tool_tracker_bp.get("/archive/program-tool-tracker")
def program_tool_tracker_archive_redirect():
    view = request.args.get("view", "").strip().lower()
    target = "/planning-data/program-tool-tracker"
    if view in {"catalogue", "list"}:
        return redirect(f"{target}?view=catalogue")
    return redirect(target)


@program_tool_tracker_bp.get("/api/planning-data/program-tool-tracker")
@program_tool_tracker_bp.get("/api/archive/program-tool-tracker")
def api_program_tool_tracker():
    search = request.args.get("search", "").strip()
    show_completed = request.args.get("show_completed", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    match_filter = request.args.get("match", "").strip()
    ps_type = request.args.get("ps_type", "NPS").strip()
    try:
        return jsonify(
            build_program_tool_tracker_payload(
                search=search,
                show_completed=show_completed,
                match_filter=match_filter,
                ps_type=ps_type,
            )
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@program_tool_tracker_bp.get("/api/archive/program-tool-catalogue")
def api_program_tool_catalogue():
    search = request.args.get("search", "").strip()
    try:
        return jsonify(build_program_tool_catalogue_payload(search=search))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
