"""Program / tool list page, Google Sheet sync, and planner_program_tools Supabase push."""
from __future__ import annotations

import logging
import json as _json
import os
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from urllib.parse import urlparse

from flask import Blueprint, jsonify, render_template, request

program_tool_list_bp = Blueprint("program_tool_list", __name__)

# Bump when sync response shape changes (visible in Network tab).
SYNC_API_VERSION = 2

_PTL_SHEET_ID = "1e7_ahcp15jLHOKhX6W1b6TLUvbZr-wM5H_MzMzYXIXg"
_PTL_SHEET_GID = 606390196

DEFAULT_SET_UP_TIME = 180

SUPABASE_COLUMNS = (
    "part_no_erp",
    "cnc_machine_no",
    "operation_no",
    "program_file",
    "tool_list_files",
    "programmer_name",
    "wo_machine",
    "set_up_time",
    "cycle_time",
)


def _db_query(sql, params=(), fetchall=False):
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if fetchall:
                return cur.fetchall()
            return None
    finally:
        release_conn(conn)


def _part_no_erp_map_for_ps_nos(ps_nos: list[str]) -> dict[str, str]:
    if not ps_nos:
        return {}
    try:
        erp_rows = _db_query(
            """
            SELECT DISTINCT process_sheet_no, inventory_code
            FROM public.mfg_process_sheet_info_v1_view
            WHERE process_sheet_no = ANY(%s)
            """,
            (ps_nos,),
            fetchall=True,
        )
        return {er[0]: er[1] for er in erp_rows} if erp_rows else {}
    except Exception:
        return {}


def _actual_machine_map_for_parts(part_no_erp_list: list[str]) -> dict[tuple[str, str], str]:
    if not part_no_erp_list:
        return {}
    try:
        wo_rows = _db_query(
            """
            WITH wt_raw AS (
                SELECT t2.inventory_code, t1.voucher_no, t1.machine_no,
                       t2.stage_desc, t3.total_acc_qty_produced,
                       CASE WHEN t1.status = 'H' THEN 1 ELSE 0 END AS status_rank
                FROM mfg_wo_comp_vch t1
                LEFT JOIN mfg_mps_vch t2 ON t1.voucher_no = t2.wo_voucher_no
                LEFT JOIN mfg_wo_vch t3 ON t1.voucher_no = t3.voucher_no
                WHERE t2.inventory_code = ANY(%s)
                  AND (
                      t2.stage_desc LIKE 'Turning%%'
                   OR t2.stage_desc LIKE 'Milling%%'
                   OR t2.stage_desc LIKE 'Turnmill%%'
                  )
            ),
            wt_ranked AS (
                SELECT *,
                    ROW_NUMBER() OVER (
                        PARTITION BY voucher_no
                        ORDER BY total_acc_qty_produced DESC, status_rank DESC
                    ) AS rn
                FROM wt_raw
            ),
            workorder_tracker AS (
                SELECT inventory_code, machine_no, stage_desc
                FROM wt_ranked
                WHERE rn = 1
            )
            SELECT inventory_code, stage_desc, MIN(machine_no) AS machine_no
            FROM workorder_tracker
            GROUP BY inventory_code, stage_desc
            """,
            (part_no_erp_list,),
            fetchall=True,
        )
        return {(wr[0], wr[1]): wr[2] for wr in wo_rows} if wo_rows else {}
    except Exception:
        return {}


def _enrich_rows_for_display(rows: list[dict[str, Any]]) -> None:
    ps_nos = list({r.get("ps_no") for r in rows if r.get("ps_no")})
    part_no_erp_map = _part_no_erp_map_for_ps_nos(ps_nos)
    for row in rows:
        row["part_no_erp"] = part_no_erp_map.get(row.get("ps_no") or "", "") or row.get("part_number") or ""

    part_no_erp_list = list({row["part_no_erp"] for row in rows if row.get("part_no_erp")})
    actual_machine_map = _actual_machine_map_for_parts(part_no_erp_list)
    for row in rows:
        part_no_erp = row.get("part_no_erp") or ""
        op_type = row.get("operation_type") or ""
        op_no = row.get("operation_no") or row.get("operation_no_2") or ""
        stage = f"{op_type} {op_no}".strip() if op_no else op_type
        row["actual_machine_no"] = actual_machine_map.get((part_no_erp, stage), "")


# ── Supabase payload (planner_program_tools) ───────────────────────────────


def _parse_optional_int(val: Any) -> int | None:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _row_fill_score(row: dict[str, Any]) -> int:
    n = 0
    for f in SUPABASE_COLUMNS:
        v = row.get(f)
        if v is None:
            continue
        if isinstance(v, bool):
            n += 1 if v else 0
        elif isinstance(v, (int, float)):
            n += 1
        elif str(v).strip():
            n += 1
    return n


def _row_quality_score(row: dict[str, Any]) -> int:
    score = _row_fill_score(row)
    if row.get("cycle_time") is not None:
        score += 100
    return score


def _cycle_time_from_row(r: dict[str, Any]) -> int | None:
    """Minutes/pc from sheet column cycle_time (col 12 in tool_list)."""
    ct = _parse_optional_int(r.get("cycle_time"))
    if ct is not None:
        return ct
    # Some sheet rows only fill the trailing original_setup_time cell with the same value.
    return _parse_optional_int(r.get("original_setup_time"))


def _set_up_time_from_row(r: dict[str, Any]) -> int:
    raw = _parse_optional_int(r.get("setup_time"))
    return raw if raw is not None else DEFAULT_SET_UP_TIME


def _merge_dedupe_row(existing: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    """Keep the richer row but never drop cycle_time from a duplicate sheet line."""
    winner = row if _row_quality_score(row) > _row_quality_score(existing) else existing
    loser = existing if winner is row else row
    merged = dict(winner)
    if merged.get("cycle_time") is None and loser.get("cycle_time") is not None:
        merged["cycle_time"] = loser["cycle_time"]
    if merged.get("set_up_time") is None and loser.get("set_up_time") is not None:
        merged["set_up_time"] = loser["set_up_time"]
    return merged


def _dedupe_planner_program_tools_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
        if not existing:
            merged[key] = row
        else:
            merged[key] = _merge_dedupe_row(existing, row)
    return list(merged.values())


def _coerce_row_for_supabase_insert(row: dict[str, Any]) -> dict[str, Any]:
    """Exact PostgREST body: ints for times, cycle_time included when known."""
    cycle_time = row.get("cycle_time")
    if cycle_time is not None:
        cycle_time = int(cycle_time)

    out: dict[str, Any] = {
        "part_no_erp": str(row.get("part_no_erp") or "").strip(),
        "cnc_machine_no": str(row.get("cnc_machine_no") or "").strip(),
        "operation_no": str(row.get("operation_no") or "").strip(),
        "program_file": str(row.get("program_file") or "").strip(),
        "tool_list_files": str(row.get("tool_list_files") or "").strip(),
        "programmer_name": str(row.get("programmer_name") or "").strip(),
        "wo_machine": str(row.get("wo_machine") or "").strip(),
        "set_up_time": int(row.get("set_up_time") or DEFAULT_SET_UP_TIME),
        "cycle_time": cycle_time,
    }
    return out


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
        set_up_time = _set_up_time_from_row(r)
        cycle_time = _cycle_time_from_row(r)

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
                "set_up_time": set_up_time,
                "cycle_time": cycle_time,
            }
        )

    return _dedupe_planner_program_tools_payload(payload)


def push_planner_program_tools_to_supabase(payload: list[dict[str, Any]]) -> dict[str, Any]:
    import requests as req

    from db import supa_headers, supa_service_role_key, supa_url

    base = supa_url().rstrip("/")
    if not base:
        raise RuntimeError(
            "Supabase URL is not configured. Set Supa_base_url to your REST base "
            "(e.g. https://YOUR_REF.supabase.co/rest/v1) or set SUPABASE_URL "
            "(e.g. https://YOUR_REF.supabase.co) in .env."
        )

    url = f"{base}/planner_program_tools"
    hdrs = supa_headers(write=True)

    out: dict[str, Any] = {
        "sync_api_version": SYNC_API_VERSION,
        "synced": 0,
        "payload_columns": list(SUPABASE_COLUMNS),
        "supabase_host": urlparse(base).netloc or "",
        "using_service_role": bool(supa_service_role_key()),
    }
    warnings: list[str] = []
    if not out["using_service_role"]:
        warnings.append(
            "Service role key is not set (supa_base_secret_key or SUPABASE_SERVICE_ROLE_KEY). "
            "Using the anon/publishable key — RLS may block DELETE/INSERT so the Table Editor will not update. "
            "Add the service_role secret from Supabase → Project Settings → API."
        )

    if not payload:
        out["message"] = "No valid rows to sync"
        if warnings:
            out["warnings"] = warnings
        return out

    insert_rows = [_coerce_row_for_supabase_insert(r) for r in payload]
    out["sample_payload"] = insert_rows[0] if insert_rows else None

    read_hdrs = {k: v for k, v in hdrs.items() if k.lower() != "prefer"}
    read_hdrs.setdefault("Accept", "application/json")
    col_probe = req.get(
        f"{url}?select=cycle_time,set_up_time&limit=1",
        headers=read_hdrs,
        timeout=30,
    )
    if not col_probe.ok:
        detail = (col_probe.text or col_probe.reason or "").strip()
        if "cycle_time" in detail.lower():
            raise RuntimeError(
                "Supabase table planner_program_tools is missing cycle_time (and/or set_up_time). "
                "Run migrations/add_planner_program_tools_set_up_cycle_time.sql in the SQL editor, "
                "then reload the API schema (Project Settings → API → Reload schema)."
            )
        raise RuntimeError(
            f"Cannot read planner_program_tools ({col_probe.status_code}): {detail[:400]}"
        )

    del_r = req.delete(url, headers=hdrs, params={"id": "gt.0"}, timeout=120)
    if del_r.status_code not in (200, 204):
        detail = (del_r.text or del_r.reason or "").strip()
        if len(detail) > 500:
            detail = detail[:500] + "…"
        raise RuntimeError(
            f"Supabase DELETE failed ({del_r.status_code}): {detail or 'check RLS and API key'}"
        )

    batch_size = 500
    synced = 0
    for i in range(0, len(insert_rows), batch_size):
        batch = insert_rows[i : i + batch_size]
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
            if "cycle_time" in detail.lower():
                raise RuntimeError(
                    f"Supabase rejected cycle_time ({r.status_code}): {detail}. "
                    "Apply migrations/add_planner_program_tools_set_up_cycle_time.sql and reload API schema."
                )
            raise RuntimeError(f"Supabase insert failed ({r.status_code}): {detail or 'Bad Request'}")
        synced += len(batch)

    out["synced"] = synced

    peek_r = req.get(
        f"{url}?select=cycle_time,set_up_time,part_no_erp&cycle_time=not.is.null&limit=5",
        headers=read_hdrs,
        timeout=30,
    )
    read_back: dict[str, Any] = {"ok": peek_r.ok, "status": peek_r.status_code}
    if peek_r.ok:
        try:
            rows_rb = peek_r.json()
            if isinstance(rows_rb, list):
                read_back["rows_with_cycle_time"] = len(rows_rb)
                read_back["sample"] = rows_rb[:3]
            else:
                read_back["error"] = "unexpected JSON shape"
        except Exception as ex:  # noqa: BLE001
            read_back["error"] = str(ex)
    else:
        read_back["error"] = (peek_r.text or "")[:300]
    out["read_back"] = read_back

    if warnings:
        out["warnings"] = warnings

    try:
        from sync import schedule_rebuild_stg_cycle_time_comparison

        out["stg_cycle_time_comparison"] = schedule_rebuild_stg_cycle_time_comparison()
    except Exception as ex:  # noqa: BLE001
        out["stg_cycle_time_comparison"] = {"error": str(ex)}

    return out


# ── Callable from HTTP and background auto-sync ─────────────────────────────


def sync_tool_list_sheet_to_sqlite() -> dict[str, Any]:
    """Pull the program tool Google Sheet into local tool_list SQLite.

    Raises RuntimeError if the API key is missing or Google Sheets fails.
    Raises ValueError for invalid tab (HTTP 400 equivalent for the route).
    """
    from tool_list_db import COLUMNS, init_db, replace_all

    api_key = os.getenv("tool_list_secret_key", "").strip()
    if not api_key:
        raise RuntimeError("tool_list_secret_key is not set in .env")

    def sheets_get(url: str, params: dict[str, str]) -> dict[str, Any]:
        full = url + "?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(full, timeout=30) as r:
                return _json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            try:
                msg = _json.loads(body)["error"]["message"]
            except Exception:
                msg = body or str(e)
            raise RuntimeError(f"Google API {e.code}: {msg}") from e

    meta = sheets_get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{_PTL_SHEET_ID}",
        {"key": api_key, "fields": "sheets(properties(sheetId,title))"},
    )
    sheet_name = next(
        (
            s["properties"]["title"]
            for s in meta.get("sheets", [])
            if s["properties"]["sheetId"] == _PTL_SHEET_GID
        ),
        None,
    )
    if not sheet_name:
        raise ValueError(f"Tab with gid={_PTL_SHEET_GID} not found in spreadsheet")

    data = sheets_get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{_PTL_SHEET_ID}/values/{urllib.parse.quote(sheet_name)}",
        {"key": api_key},
    )
    values = data.get("values", [])
    if not values:
        return {"synced": 0, "message": "Sheet is empty"}

    n = len(COLUMNS)
    rows = [tuple((list(r) + [""] * n)[:n]) for r in values[2:]]

    init_db()
    replace_all(rows)
    return {"synced": len(rows)}


def sync_program_tool_list_to_supabase() -> dict[str, Any]:
    """Build planner_program_tools rows from SQLite and push to Supabase (same as POST handler)."""
    from tool_list_db import init_db, fetch_all

    init_db()
    rows = fetch_all()
    if not rows:
        return {
            "synced": 0,
            "message": "No rows in tool list",
            "sync_api_version": SYNC_API_VERSION,
        }

    ps_nos = list({r.get("ps_no") for r in rows if r.get("ps_no")})
    part_no_erp_map = _part_no_erp_map_for_ps_nos(ps_nos)
    part_no_erp_list = list(set(part_no_erp_map.values()))
    actual_machine_map = _actual_machine_map_for_parts(part_no_erp_list)

    payload = build_planner_program_tools_payload(
        rows,
        part_no_erp_map=part_no_erp_map,
        actual_machine_map=actual_machine_map,
    )
    if not payload:
        return {
            "synced": 0,
            "message": "No valid rows to sync",
            "sync_api_version": SYNC_API_VERSION,
        }

    with_cycle_time = sum(1 for p in payload if p.get("cycle_time") is not None)
    result = push_planner_program_tools_to_supabase(payload)
    result["sync_api_version"] = SYNC_API_VERSION
    result["with_cycle_time"] = with_cycle_time
    result["without_cycle_time"] = len(payload) - with_cycle_time
    if result.get("sample_payload") is None and payload:
        result["sample_payload"] = _coerce_row_for_supabase_insert(payload[0])

    rb = result.get("read_back") or {}
    if (
        with_cycle_time >= 10
        and rb.get("ok")
        and rb.get("rows_with_cycle_time", 0) == 0
        and not rb.get("error")
    ):
        result.setdefault("warnings", []).append(
            "The tool list has many cycle_time values, but Supabase returned zero rows with "
            "cycle_time set after sync. Add the cycle_time column (see migrations/"
            "add_planner_program_tools_set_up_cycle_time.sql), use the service_role API key "
            "(supa_base_secret_key / SUPABASE_SERVICE_ROLE_KEY), and confirm RLS allows "
            "the service role to write planner_program_tools."
        )

    return result


def run_auto_program_tool_list_sync(logger: logging.Logger | None = None) -> None:
    """Background hook: refresh sheet → SQLite, then push to Supabase.

    Runs on the same cadence as ERP auto-sync when invoked from that loop.
    Set DISABLE_AUTO_PROGRAM_TOOL_LIST_SYNC=1 to skip entirely.
    """
    log = logger or logging.getLogger(__name__)
    if os.getenv("DISABLE_AUTO_PROGRAM_TOOL_LIST_SYNC", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return

    if os.getenv("tool_list_secret_key", "").strip():
        try:
            r = sync_tool_list_sheet_to_sqlite()
            if r.get("message"):
                log.info("auto program-tool-list (sheet): %s", r["message"])
            log.info("auto program-tool-list (sheet): synced %s row(s)", r.get("synced", 0))
        except Exception as e:
            log.error("auto program-tool-list (sheet) failed: %s", e)
    else:
        log.debug("auto program-tool-list (sheet): skipped (no tool_list_secret_key)")

    try:
        from db import supa_url

        if not (supa_url() or "").strip():
            log.debug("auto program-tool-list (supabase): skipped (no Supabase URL)")
            return
        r = sync_program_tool_list_to_supabase()
        if r.get("message") and r.get("synced", 0) == 0:
            log.info("auto program-tool-list (supabase): %s", r["message"])
        else:
            log.info(
                "auto program-tool-list (supabase): synced=%s with_cycle_time=%s host=%s",
                r.get("synced"),
                r.get("with_cycle_time"),
                r.get("supabase_host") or "",
            )
        for w in r.get("warnings") or []:
            log.warning("auto program-tool-list (supabase): %s", w)
    except Exception as e:
        log.error("auto program-tool-list (supabase) failed: %s", e)


# ── Routes ─────────────────────────────────────────────────────────────────


@program_tool_list_bp.get("/planning-data/program-tool-list")
def program_tool_list_page():
    return render_template("planning_data/program_tool_list.html", active="planning_data")


@program_tool_list_bp.post("/api/program-tool-list/sync")
def api_ptl_sync():
    try:
        return jsonify(sync_tool_list_sheet_to_sqlite())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@program_tool_list_bp.get("/api/program-tool-list/lookup")
def api_ptl_lookup():
    from program_tools_lookup import build_program_tools_lookup
    from tool_list_db import init_db, fetch_all, last_synced

    try:
        init_db()
        rows = fetch_all()
        _enrich_rows_for_display(rows)
        lookup = build_program_tools_lookup(rows)
        return jsonify({
            "last_synced": last_synced(),
            "ps_op_count": len(lookup.get("by_ps_op") or {}),
            "part_op_count": len(lookup.get("by_part_op") or {}),
            **lookup,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@program_tool_list_bp.get("/api/program-tool-list")
def api_ptl_data():
    from tool_list_db import init_db, fetch_all, last_synced

    search = request.args.get("search", "").strip()
    try:
        init_db()
        rows = fetch_all(search)
        _enrich_rows_for_display(rows)
        return jsonify({"rows": rows, "last_synced": last_synced()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@program_tool_list_bp.get("/api/program-tool-list/supabase-target")
def api_ptl_supabase_target():
    import requests as req

    from db import (
        supa_headers,
        supa_publishable_key,
        supa_service_role_key,
        supa_url,
    )

    table_name = "planner_program_tools"
    base = (supa_url() or "").strip().rstrip("/")
    hostname = urlparse(base).netloc if base else ""
    resource = f"{base}/{table_name}" if base else ""

    out: dict = {
        "table": table_name,
        "payload_columns": list(SUPABASE_COLUMNS),
        "methods": ["DELETE (clear ids > 0)", "POST (bulk insert JSON array)"],
        "rest_base_url": base or None,
        "resource_url": resource or None,
        "hostname": hostname or None,
        "env_has_Supa_base_url": bool(os.getenv("Supa_base_url", "").strip()),
        "env_has_SUPABASE_URL": bool(os.getenv("SUPABASE_URL", "").strip()),
        "has_service_role_key": bool(supa_service_role_key()),
        "has_publishable_key": bool(supa_publishable_key()),
        "probe": None,
    }

    key_ok = bool(supa_service_role_key() or supa_publishable_key())
    if not resource:
        out["probe"] = {
            "ok": False,
            "hint": "Set Supa_base_url (…/rest/v1) or SUPABASE_URL on the machine running Flask.",
        }
    elif not key_ok:
        out["probe"] = {
            "ok": False,
            "hint": "Set supa_base_secret_key or Supa_base_publishable_key (or SUPABASE_* aliases).",
        }
    else:
        read_hdr = {k: v for k, v in supa_headers(write=True).items() if k.lower() != "prefer"}
        read_hdr["Accept"] = "application/json"
        read_hdr["Prefer"] = "count=exact"
        try:
            r = req.get(
                resource,
                headers=read_hdr,
                params={"select": "id"},
                timeout=15,
            )
            cr = (r.headers.get("Content-Range") or "").strip()
            tail = ""
            if "/" in cr:
                tail = cr.split("/")[-1].strip()
            row_total = None
            try:
                row_total = int(tail)
            except (TypeError, ValueError):
                pass
            snippet = (r.text or "")[:400] if not r.ok else ""
            out["probe"] = {
                "ok": r.ok,
                "get_status": r.status_code,
                "row_estimate_from_api": row_total,
                "content_range": cr or None,
                "response_snippet_if_error": snippet or None,
            }
        except Exception as ex:
            out["probe"] = {"ok": False, "error": str(ex)[:300]}

    return jsonify(out)


@program_tool_list_bp.post("/api/program-tool-list/sync-to-supabase")
def api_ptl_sync_to_supabase():
    try:
        return jsonify(sync_program_tool_list_to_supabase())

    except Exception as e:
        print(f"❌ SYNC ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return jsonify({"error": str(e)}), 500
