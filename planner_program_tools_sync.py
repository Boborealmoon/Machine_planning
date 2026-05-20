"""Build and push planner_program_tools rows to Supabase."""
from __future__ import annotations

from typing import Any

# Columns exposed by PostgREST on planner_program_tools (no ps_no on live table).
SUPABASE_COLUMNS = (
    "part_no_erp",
    "cnc_machine_no",
    "operation_no",
    "program_file",
    "tool_list_files",
    "programmer_name",
    "wo_machine",
)


def _row_fill_score(row: dict[str, Any]) -> int:
    return sum(1 for f in SUPABASE_COLUMNS if str(row.get(f) or "").strip())


def dedupe_planner_program_tools_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per part + machine + operation (sheet often has repeats)."""
    merged: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (
            str(row.get("part_no_erp") or "").strip(),
            str(row.get("cnc_machine_no") or "").strip(),
            str(row.get("operation_no") or "").strip(),
        )
        if not key[0]:
            continue
        existing = merged.get(key)
        if not existing or _row_fill_score(row) > _row_fill_score(existing):
            merged[key] = row
    return list(merged.values())


def build_planner_program_tools_payload(
    rows: list[dict[str, Any]],
    *,
    part_no_erp_map: dict[str, str] | None = None,
    actual_machine_map: dict[tuple[str, str], str] | None = None,
) -> list[dict[str, Any]]:
    part_no_erp_map = part_no_erp_map or {}
    actual_machine_map = actual_machine_map or {}
    payload: list[dict[str, Any]] = []

    for r in rows:
        ps_no = r.get("ps_no") or ""
        part_no_erp = (part_no_erp_map.get(ps_no) or (r.get("part_number") or "")).strip()
        if not part_no_erp and ps_no:
            part_no_erp = ps_no.strip()
        cnc_machine = (r.get("cnc_machine_no") or "").strip()
        op_no = (r.get("operation_no") or r.get("operation_no_2") or "").strip()
        op_type = (r.get("operation_type") or "").strip()
        stage = f"{op_type} {op_no}".strip() if op_no else op_type
        wo_machine = (actual_machine_map.get((part_no_erp, stage)) or "").strip()
        program_file = (r.get("program_file") or "").strip()
        tool_list_files = (r.get("tool_list_files") or "").strip()
        programmer_name = (r.get("programmer_name") or "").strip()

        if not any(
            [program_file, tool_list_files, part_no_erp, programmer_name, cnc_machine, wo_machine, op_no]
        ):
            continue

        payload.append(
            {
                "part_no_erp": part_no_erp,
                "cnc_machine_no": cnc_machine,
                "operation_no": op_no,
                "program_file": program_file,
                "tool_list_files": tool_list_files,
                "programmer_name": programmer_name,
                "wo_machine": wo_machine,
            }
        )

    return dedupe_planner_program_tools_payload(payload)


def push_planner_program_tools_to_supabase(payload: list[dict[str, Any]]) -> dict[str, Any]:
    """Replace table contents (delete all, then insert deduped rows)."""
    import requests as req

    from db import supa_headers, supa_url

    if not payload:
        return {"synced": 0, "message": "No valid rows to sync"}

    url = f"{supa_url()}/planner_program_tools"
    hdrs = supa_headers(write=True)
    batch_size = 500

    req.delete(url, headers=hdrs, params={"id": "gt.0"}, timeout=30)

    synced = 0
    for i in range(0, len(payload), batch_size):
        batch = payload[i : i + batch_size]
        r = req.post(
            url,
            headers={**hdrs, "Prefer": "return=minimal"},
            json=batch,
            timeout=120,
        )
        if not r.ok:
            detail = (r.text or r.reason or "").strip()
            if len(detail) > 500:
                detail = detail[:500] + "…"
            raise RuntimeError(f"Supabase insert failed ({r.status_code}): {detail or 'Bad Request'}")
        synced += len(batch)

    return {"synced": synced}
