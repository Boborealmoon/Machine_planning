import logging
import os
import threading
import time
from flask import Flask, render_template, jsonify, request, redirect, url_for
from dotenv import load_dotenv

log = logging.getLogger(__name__)

load_dotenv()

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

# ── Planning blueprints ────────────────────────────────────────────────────
from planning.process_sheets import process_sheets_bp
from planning.summary import trial_summary_bp
from planning.flows import flows_bp, trial_prefixed_flows_bp
from planning.gantt_route import trial_gantt_bp
from planning.materials_route import materials_route_bp
from planning.planner_routes import trial_bp
from planning.program_tool_list_route import program_tool_list_bp
from planning.utils import pending_delivery_order, shipped_quantity_completed

app.register_blueprint(process_sheets_bp)
app.register_blueprint(trial_summary_bp)
app.register_blueprint(flows_bp)
app.register_blueprint(trial_prefixed_flows_bp)
app.register_blueprint(trial_gantt_bp)
app.register_blueprint(materials_route_bp)
app.register_blueprint(trial_bp)
app.register_blueprint(program_tool_list_bp)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret")


@app.get("/favicon.ico")
def favicon():
    return "", 204


# ── DB helper ──────────────────────────────────────────────────────────────

def db_query(sql, params=(), fetchone=False, fetchall=False, commit=False):
    from db import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            result = None
            if fetchone:
                result = cur.fetchone()
            elif fetchall:
                result = cur.fetchall()
            if commit:
                conn.commit()
            return result
    except Exception:
        if commit:
            conn.rollback()
        raise
    finally:
        release_conn(conn)


def supabase_query(sql, params=(), fetchone=False, fetchall=False, commit=False):
    # Legacy shim — only the pp_vouchers_cache SELECT still calls this path.
    # New syncs write via REST (sync.py); reads below go via REST too.
    from db import get_supa_conn, release_supa_conn
    conn = get_supa_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            result = None
            if fetchone:
                result = cur.fetchone()
            elif fetchall:
                result = cur.fetchall()
            if commit:
                conn.commit()
            return result
    except Exception:
        if commit:
            conn.rollback()
        raise
    finally:
        release_supa_conn(conn)


# ── Pages ──────────────────────────────────────────────────────────────────

@app.get("/")
@app.get("/scheduler")
def scheduler():
    return render_template("scheduler.html", active="scheduler")


@app.get("/actual-production")
def actual_production():
    return render_template("actual_production.html", active="actual_production")


@app.get("/process-sheets")
def process_sheets():
    return render_template("process_sheets.html", active="process_sheets")


@app.get("/machine-schedule")
def machine_schedule():
    return render_template("machine_schedule.html", active="machine_schedule")


@app.get("/summary")
def summary():
    return render_template("summary.html", active="summary")


@app.get("/planning-data")
def planning_data():
    return redirect(url_for("inventory_bom"))


@app.get("/planning-data/inventory-bom")
def inventory_bom():
    return render_template("planning_data/inventory_bom.html", active="planning_data")


@app.get("/planning-data/machines")
def machines_page():
    return render_template("planning_data/machines.html", active="planning_data")


@app.get("/planning-data/materials")
def materials():
    return render_template("planning_data/materials.html", active="planning_data")


@app.get("/planning-data/cycle-times")
def cycle_times_page():
    return render_template("planning_data/cycle_times.html", active="planning_data")


@app.get("/operations")
def operations():
    return render_template("operations.html", active="operations")


@app.get("/system")
def system():
    return render_template("system.html", active="system")


# ── API: PP Vouchers ───────────────────────────────────────────────────────

_PP_VOUCHERS_COLS = [
    "ps_id", "pp_partial_no", "part_no", "description",
    "total_qty", "partial_qty", "due_date", "order_date",
    "bom_code", "source_voucher_no", "source_line_item_no",
    "qty_shipped", "so_det_qty", "status", "execution_status",
    "wo_qty_required", "wo_qty_produced", "wo_qty_rejected",
    "stage_no", "stage_desc", "op_no",
    "current_stage_no", "current_stage_desc", "current_stage_status",
]

_PP_VOUCHERS_WITH_OPS_CACHE: dict[str, dict] = {}
_PP_VOUCHERS_WITH_OPS_CACHE_LOCK = threading.Lock()
_PP_VOUCHERS_WITH_OPS_TTL_SECS = 60


def _pp_vouchers_include_completed() -> bool:
    """Include jobs fully shipped (qty_shipped >= so_det_qty). PP voucher History is ignored."""
    flag = str(
        request.args.get("show_completed")
        or request.args.get("include_completed")
        or request.args.get("include_history")  # legacy alias
        or ""
    ).lower()
    return flag in {"1", "true", "yes"}


def _pp_vouchers_cache_scope(include_completed: bool) -> str:
    return "all" if include_completed else "open"


def _fetch_pp_vouchers_cache_rows(include_completed: bool):
    from planning.helpers import planner_db, rows as _db_rows

    from planning.utils import SHIPPED_QTY_TOLERANCE

    cols = ", ".join(_PP_VOUCHERS_COLS)
    # Completed = fully shipped on the SO line, not PP voucher status (H/History).
    shipped_complete = (
        "so_det_qty IS NOT NULL "
        f"AND COALESCE(qty_shipped, 0) >= so_det_qty - {SHIPPED_QTY_TOLERANCE}"
    )
    where = "" if include_completed else f" WHERE NOT ({shipped_complete})"
    order = " ORDER BY ps_id, pp_partial_no, stage_no"
    with planner_db() as _con:
        return _db_rows(_con.execute(f"SELECT {cols} FROM pp_vouchers_cache{where}{order}"))


def _invalidate_pp_vouchers_with_ops_cache():
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        _PP_VOUCHERS_WITH_OPS_CACHE.clear()


def _pp_voucher_search_haystack(entry: dict) -> str:
    parts = [
        entry.get("ps_id"),
        entry.get("source_ps_id"),
        entry.get("display_ps_id"),
        entry.get("part_no"),
        entry.get("part_name"),
        entry.get("part_desc"),
        entry.get("source_voucher_no"),
        entry.get("bom_code"),
        entry.get("execution_status"),
        entry.get("current_stage_desc"),
    ]
    for op in entry.get("ops") or []:
        parts.extend(
            [
                op.get("operation_name"),
                op.get("stage_desc"),
                op.get("source_op_no"),
                op.get("execution_status"),
            ]
        )
    return " ".join(str(part) for part in parts if part).lower()


def _entry_matches_search_term(entry: dict, term: str) -> bool:
    term = term.strip().lower()
    if not term:
        return True
    ps_ids = [
        str(entry.get(key) or "").lower()
        for key in ("ps_id", "source_ps_id", "display_ps_id")
        if entry.get(key)
    ]
    if ps_ids and any(term in ps_id for ps_id in ps_ids):
        return True
    return term in _pp_voucher_search_haystack(entry)


def _filter_pp_vouchers_by_search(data: list, raw_search: str) -> list:
    terms = [term.strip().lower() for term in str(raw_search or "").replace(";", ",").split(",") if term.strip()]
    if not terms:
        return data
    matched = [
        entry
        for entry in data
        if any(_entry_matches_search_term(entry, term) for term in terms)
    ]
    bases = {
        str(entry.get("source_ps_id") or "").strip().lower()
        for entry in matched
        if entry.get("source_ps_id")
    }
    if not bases:
        return matched
    by_id = {id(entry): entry for entry in matched}
    for entry in data:
        base = str(entry.get("source_ps_id") or "").strip().lower()
        if base and base in bases:
            by_id[id(entry)] = entry
    return list(by_id.values())


def _normalize_execution_status(value):
    return str(value or "").strip().upper().replace("-", "_").replace(" ", "_")


def _execution_status_rank(value) -> int:
    normalized = _normalize_execution_status(value)
    ranks = {
        "I": 0,
        "IN_PROCESS": 0,
        "R": 1,
        "READY_TO_START": 1,
        "P": 2,
        "PENDING_SI": 2,
        "C": 3,
        "COMPLETED": 3,
    }
    return ranks.get(normalized, 4)


def _execution_status_label(value) -> str:
    normalized = _normalize_execution_status(value)
    labels = {
        "P": "Pending SI",
        "PENDING_SI": "Pending SI",
        "R": "Ready to Start",
        "READY_TO_START": "Ready to Start",
        "I": "In Process",
        "IN_PROCESS": "In Process",
        "C": "Completed",
        "COMPLETED": "Completed",
    }
    return labels.get(normalized, str(value or "").strip())


def _summarize_execution_status(statuses):
    normalized = [_normalize_execution_status(status) for status in statuses if _normalize_execution_status(status)]
    if not normalized:
        return ""
    if any(status in {"I", "IN_PROCESS"} for status in normalized):
        return "In Process"
    if any(status in {"R", "READY_TO_START"} for status in normalized):
        return "Ready to Start"
    if any(status in {"P", "PENDING_SI"} for status in normalized):
        return "Pending SI"
    if all(status in {"C", "COMPLETED"} for status in normalized):
        return "Completed"
    return _execution_status_label(statuses[0]) if statuses else ""


def _pp_vouchers_with_ops_payload(cache_rows):
    # Group cache rows by (ps_id, pp_partial_no) — one cache row per stage
    grouped = {}
    for row in cache_rows:
        pp_partial = int(row.get("pp_partial_no") or 1)
        ps_id_raw = row.get("ps_id") or ""
        ps_key = (ps_id_raw, pp_partial)
        ps_id = f"{ps_id_raw}::{pp_partial}" if pp_partial > 1 else ps_id_raw

        if ps_key not in grouped:
            part_no = row.get("part_no") or ""
            source_total_qty = float(row.get("total_qty") or 0)
            partial_qty = float(row.get("partial_qty") or 0)
            display_qty = partial_qty or source_total_qty
            grouped[ps_key] = {
                "ps_id": ps_id,
                "source_ps_id": ps_id_raw,
                "display_ps_id": ps_id_raw,
                "pp_partial_no": pp_partial,
                "part_no": part_no,
                "part_name": part_no,
                "part_desc": row.get("description") or "",
                "due_date": str(row.get("due_date") or ""),
                "order_date": str(row.get("order_date") or ""),
                "bom_code": row.get("bom_code") or "",
                "erp_bom_code": row.get("bom_code") or "",
                "inventory_code": part_no,
                "source_voucher_no": row.get("source_voucher_no") or "",
                "source_line_item_no": row.get("source_line_item_no") or "",
                "qty_shipped": float(row.get("qty_shipped") or 0),
                "so_det_qty": float(row["so_det_qty"]) if row.get("so_det_qty") is not None else None,
                "total_qty": source_total_qty,
                "partial_qty": partial_qty,
                "wo_req_qty": partial_qty,
                "total_wo_qty": source_total_qty,
                "display_qty": display_qty,
                "status": row.get("status") or "",
                "execution_status": row.get("execution_status") or None,
                "planner_status": None,
                "planned_qty": 0.0,
                "finished_qty": 0.0,
                "reject_qty": 0.0,
                "wo_qty_required": 0.0,
                "remaining_qty": 0.0,
                "op_cards": [],
                "ops": [],
                "flow_options": [],
                "current_stage_no": None,
                "current_stage_desc": "",
                "current_stage_status": "",
            }

        entry = grouped[ps_key]
        if row.get("current_stage_desc"):
            new_rank = _execution_status_rank(row.get("current_stage_status"))
            old_rank = (
                _execution_status_rank(entry.get("current_stage_status"))
                if entry.get("current_stage_desc")
                else 99
            )
            if not entry.get("current_stage_desc") or new_rank < old_rank:
                entry["current_stage_no"] = row.get("current_stage_no")
                entry["current_stage_desc"] = row.get("current_stage_desc") or ""
                entry["current_stage_status"] = row.get("current_stage_status") or ""
        row_execution_status = row.get("execution_status") or ""
        required_qty = float(row.get("wo_qty_required") or 0)
        produced_qty = float(row.get("wo_qty_produced") or 0)
        rejected_qty = float(row.get("wo_qty_rejected") or 0)
        entry["wo_qty_required"] = max(float(entry.get("wo_qty_required") or 0), required_qty)
        entry["finished_qty"] = max(float(entry.get("finished_qty") or 0), produced_qty)
        entry["reject_qty"] = max(float(entry.get("reject_qty") or 0), rejected_qty)
        entry["remaining_qty"] = max(0.0, entry["wo_qty_required"] - entry["finished_qty"])
        stage_desc = row.get("stage_desc") or ""
        op_no = str(row.get("op_no") or "")
        stage_no = int(row.get("stage_no") or 0)
        if not op_no and stage_no:
            op_no = str(stage_no)

        if stage_desc:
            partial_qty = float(row.get("partial_qty") or entry.get("partial_qty") or 0)
            display_qty = partial_qty or float(entry.get("display_qty") or entry.get("total_qty") or 0)
            qty = display_qty if display_qty > 0 else required_qty
            remaining_qty = max(0.0, qty - produced_qty)
            machine_group = stage_desc.split()[0].upper() if stage_desc else ""
            op_card = {
                "card_kind": "single",
                "card_id": None,
                "ps_id": entry["ps_id"],
                "operation_label": op_no or stage_desc,
                "operation_name": stage_desc,
                "op_type": stage_desc,
                "stage_no": stage_no,
                "stage_desc": stage_desc,
                "execution_status": row_execution_status,
                "target_qty": qty,
                "required_qty": required_qty,
                "wo_qty_required": required_qty,
                "wo_qty_produced": produced_qty,
                "wo_qty_rejected": rejected_qty,
                "qty_shipped": float(row.get("qty_shipped") or 0),
                "planned_qty": 0.0,
                "finished_qty": produced_qty,
                "reject_qty": rejected_qty,
                "remaining_qty": remaining_qty,
                "source_ps_id": entry["ps_id"],
                "source_op_seq_id": stage_no,
                "source_op_no": op_no,
                "part_no": entry.get("part_no") or "",
                "job_no": entry["ps_id"],
                "planning_status": "UNSCHEDULED",
                "card_type": "SINGLE",
                "is_scheduled": False,
                "setup_minutes": 180.0,
                "cycle_minutes_per_qty": 20.0,
                "compatible_machine_group": machine_group,
            }
            entry["op_cards"].append(op_card)
            entry["ops"].append(op_card)

    for entry in grouped.values():
        current_code = entry.get("current_stage_status")
        if current_code:
            entry["execution_status"] = _execution_status_label(current_code)
        else:
            stage_statuses = [op.get("execution_status") for op in entry.get("ops", [])]
            summary_status = _summarize_execution_status(stage_statuses)
            if summary_status:
                entry["execution_status"] = summary_status
        so_qty = entry.get("so_det_qty")
        entry["shipped_completed"] = (
            so_qty is not None
            and shipped_quantity_completed(so_qty, entry.get("qty_shipped"))
        )
        entry["is_completed"] = entry["shipped_completed"]
        entry["execution_completed"] = entry["shipped_completed"]
        entry["pending_do"] = pending_delivery_order(entry)
        bom_code = str(entry.get("bom_code") or "").strip()
        entry["erp_bom_code"] = bom_code
        entry["inventory_code"] = str(entry.get("inventory_code") or entry.get("part_no") or "").strip()
    return list(grouped.values())


def _enrich_pp_vouchers_planner_data(entries):
    """Attach planner BOM routes and selected flow to ERP catalog entries."""
    if not entries:
        return entries

    from planning.helpers import planner_db, rows as db_rows
    from planning.utils import compact_text

    source_ids = set()
    inventory_codes = set()
    for entry in entries:
        source_ps_id = compact_text(entry.get("source_ps_id"))
        if not source_ps_id:
            ps_id = compact_text(entry.get("ps_id"))
            source_ps_id = ps_id.split("::", 1)[0] if ps_id else ""
        if source_ps_id:
            source_ids.add(source_ps_id)
        inv = compact_text(entry.get("inventory_code") or entry.get("part_no"))
        if inv:
            inventory_codes.add(inv)

    planner_rows = {}
    flow_cache = {}
    bom_code_by_id = {}

    with planner_db() as con:
        if source_ids:
            for row in db_rows(
                con.execute(
                    """
                    SELECT source_ps_id, pp_partial_no, inventory_code, selected_bom_id
                    FROM planner_process_sheet
                    WHERE source_ps_id = ANY(%s)
                    """,
                    (list(source_ids),),
                )
            ):
                key = (compact_text(row["source_ps_id"]), int(row.get("pp_partial_no") or 1))
                planner_rows[key] = row

        if inventory_codes:
            for row in db_rows(
                con.execute(
                    """
                    SELECT bom_id, inventory_code, bom_code, bom_desc, is_default
                    FROM planner_bom_variation
                    WHERE inventory_code = ANY(%s)
                    ORDER BY is_default DESC, bom_id
                    """,
                    (list(inventory_codes),),
                )
            ):
                inv = compact_text(row["inventory_code"])
                flow_cache.setdefault(inv, []).append(
                    {
                        "bom_id": int(row["bom_id"]),
                        "bom_code": compact_text(row["bom_code"]),
                        "bom_desc": compact_text(row.get("bom_desc")),
                        "is_default": bool(row.get("is_default")),
                    }
                )

        bom_ids = [
            int(row["selected_bom_id"])
            for row in planner_rows.values()
            if int(row.get("selected_bom_id") or 0) > 0
        ]
        if bom_ids:
            for row in db_rows(
                con.execute(
                    """
                    SELECT bom_id, bom_code
                    FROM planner_bom_variation
                    WHERE bom_id = ANY(%s)
                    """,
                    (bom_ids,),
                )
            ):
                bom_code_by_id[int(row["bom_id"])] = compact_text(row["bom_code"])

    for entry in entries:
        bom_code = compact_text(entry.get("erp_bom_code") or entry.get("bom_code"))
        entry["erp_bom_code"] = bom_code
        source_ps_id = compact_text(entry.get("source_ps_id"))
        if not source_ps_id:
            ps_id = compact_text(entry.get("ps_id"))
            source_ps_id = ps_id.split("::", 1)[0] if ps_id else ""
        partial_no = int(entry.get("pp_partial_no") or 1)
        planner_row = planner_rows.get((source_ps_id, partial_no))
        if planner_row:
            inv = compact_text(planner_row.get("inventory_code"))
            if inv:
                entry["inventory_code"] = inv
            bom_id = int(planner_row.get("selected_bom_id") or 0)
            if bom_id:
                entry["selected_bom_id"] = bom_id
                entry["selected_bom_code"] = bom_code_by_id.get(bom_id, entry.get("selected_bom_code") or "")
        inv = compact_text(entry.get("inventory_code") or entry.get("part_no"))
        entry["inventory_code"] = inv
        entry["flow_options"] = flow_cache.get(inv, entry.get("flow_options") or [])

    return entries


@app.get("/api/pp-vouchers")
def api_pp_vouchers():
    import requests as req
    from db import supa_url, supa_headers
    from sync import run_qty_shipped_sync, run_so_detail_sync, run_sync, is_sync_needed
    try:
        if is_sync_needed():
            _ensure_pp_staging_schema()
            run_qty_shipped_sync()
            run_so_detail_sync()
            run_sync()
        from sync import _supa_fetch_all
        cache_rows = _supa_fetch_all(
            f"{supa_url()}/pp_vouchers_cache",
            headers=supa_headers(write=True),
            params={"select": ",".join(_PP_VOUCHERS_COLS), "order": "ps_id,pp_partial_no"},
        )
        return jsonify(cache_rows)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/api/pp-vouchers/with-ops")
def api_pp_vouchers_with_ops():
    """PP vouchers from cache, grouped by PS, with op cards built from stage columns."""
    from sync import is_sync_needed
    include_completed = _pp_vouchers_include_completed()
    scope = _pp_vouchers_cache_scope(include_completed)
    raw_search = str(request.args.get("search") or "").strip()
    try:
        refresh = str(request.args.get("refresh") or "").lower() in {"1", "true", "yes"}
        use_cache = not refresh and not raw_search
        now = time.monotonic()
        with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
            bucket = _PP_VOUCHERS_WITH_OPS_CACHE.get(scope) or {}
            cached_data = bucket.get("data")
            if use_cache and cached_data is not None and now < float(bucket.get("expires_at") or 0):
                return jsonify(_filter_pp_vouchers_by_search(cached_data, raw_search))

        # Trigger sync in background — serve cached data immediately
        if is_sync_needed():
            from sync import run_sync, run_mfg_wo_status_sync, run_qty_shipped_sync
            def _bg_sync():
                try:
                    _ensure_pp_staging_schema()
                except Exception:
                    return
                try:
                    from sync import run_pp_partial_sync

                    run_pp_partial_sync()
                except Exception:
                    pass
                try:
                    run_mfg_wo_status_sync()
                except Exception:
                    pass
                try:
                    run_qty_shipped_sync()
                except Exception:
                    pass
                try:
                    run_sync()
                except Exception:
                    pass
            threading.Thread(target=_bg_sync, daemon=True).start()

        cache_rows = _fetch_pp_vouchers_cache_rows(include_completed)
        data = _enrich_pp_vouchers_planner_data(_pp_vouchers_with_ops_payload(cache_rows))
        if not include_completed:
            data = [entry for entry in data if not entry.get("shipped_completed")]
        if use_cache:
            with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
                _PP_VOUCHERS_WITH_OPS_CACHE[scope] = {
                    "data": data,
                    "expires_at": time.monotonic() + _PP_VOUCHERS_WITH_OPS_TTL_SECS,
                }
        return jsonify(_filter_pp_vouchers_by_search(data, raw_search))
    except Exception as e:
        # Fall back to REST if direct DB query fails
        try:
            from db import supa_url, supa_headers
            from sync import _supa_fetch_all
            params = {
                "select": ",".join(_PP_VOUCHERS_COLS),
                "order": "ps_id,pp_partial_no,stage_no",
            }
            cache_rows = _supa_fetch_all(
                f"{supa_url()}/pp_vouchers_cache",
                headers=supa_headers(write=True),
                params=params,
            )
            data = _enrich_pp_vouchers_planner_data(_pp_vouchers_with_ops_payload(cache_rows))
            if not include_completed:
                data = [entry for entry in data if not entry.get("shipped_completed")]
            if use_cache:
                with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
                    _PP_VOUCHERS_WITH_OPS_CACHE[scope] = {
                        "data": data,
                        "expires_at": time.monotonic() + _PP_VOUCHERS_WITH_OPS_TTL_SECS,
                    }
            return jsonify(_filter_pp_vouchers_by_search(data, raw_search))
        except Exception as e2:
            return jsonify({"error": str(e2)}), 500


def _parse_pp_staging_sync_args():
    """steps and force from query string or JSON body."""
    from sync import resolve_pp_staging_steps

    body = request.get_json(silent=True) or {}
    steps_raw = request.args.get("steps") or body.get("steps")
    if isinstance(steps_raw, str):
        steps_raw = [s.strip() for s in steps_raw.split(",") if s.strip()]
    elif steps_raw is not None and not isinstance(steps_raw, list):
        raise ValueError("steps must be a list or comma-separated string")

    force_raw = request.args.get("force", body.get("force", True))
    if isinstance(force_raw, str):
        force = force_raw.lower() not in ("0", "false", "no")
    else:
        force = bool(force_raw)

    steps = resolve_pp_staging_steps(steps_raw)
    return steps, force


@app.post("/api/pp-vouchers/sync")
def api_pp_vouchers_sync():
    """Force full COMAIN → Supabase staging + cache rebuild (manual Sync ERP)."""
    return api_pp_staging_sync()


# ── API: one-shot fix — update vw_pp_vouchers join + resync ──────────────

_VW_PP_VOUCHERS_SQL = """
CREATE OR REPLACE VIEW public.vw_pp_vouchers AS
WITH
joined AS (
    SELECT
        b.pp_voucher_no,
        b.inventory_code,
        b.bom_code,
        b.pp_qty,
        b.source_voucher_no,
        b.source_rsd,
        regexp_replace(b.source_line_item_no::TEXT, '\\.0+$', '') AS source_line_item_no,
        b.status,
        b.stage_no,
        b.stage_desc,
        b.op_no,
        ps.process_sheet_no                                 AS ps_id_raw,
        ps.inventory_code                                   AS ps_inventory_code,
        ps.total_qty                                        AS ps_total_qty,
        ps.sales_order_date                                 AS ps_order_date,
        COALESCE(ps.process_sheet_no, b.pp_voucher_no)      AS ps_id,
        CASE WHEN ps.process_sheet_no IS NOT NULL
             THEN ps.inventory_code
             ELSE b.inventory_code
        END                                                 AS final_inventory_code
    FROM public.pp_voucher b
    LEFT JOIN public.mfg_process_sheet_info ps
           ON b.pp_voucher_no = ps.pp_voucher_no
),
filtered AS (
    SELECT *
    FROM joined
    WHERE ps_id LIKE '%MPS%'
       OR ps_id LIKE '%APS%'
       OR ps_id LIKE '%NPS%'
       OR ps_id LIKE '%PPS%'
       OR ps_id LIKE '%CPS%'
       OR ps_id LIKE '%[SR]%'
),
with_workorder AS (
    SELECT
        f.*,
        wa.ws_item_qty,
        wa.ws_status
    FROM filtered f
    LEFT JOIN (
        SELECT
            source_voucher_no,
            source_voucher_line_item_no,
            MIN(item_qty) AS ws_item_qty,
            MIN(status)   AS ws_status
        FROM public.workorder_status
        GROUP BY source_voucher_no, source_voucher_line_item_no
    ) wa
           ON f.source_voucher_no  = wa.source_voucher_no
          AND f.source_line_item_no = wa.source_voucher_line_item_no
),
with_shipped AS (
    SELECT
        ww.*,
        sq.qty_shipped
    FROM with_workorder ww
    LEFT JOIN public.sum_qty_shipped_by_sales_order sq
           ON ww.source_voucher_no = sq.sales_order_no
          AND regexp_replace(ww.source_line_item_no::TEXT, '\\.0+$', '') = regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
),
so_detail_by_line AS (
    SELECT
        sales_order_no,
        regexp_replace(line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        MAX(qty) AS so_qty
    FROM public.so_detail
    WHERE sales_order_no IS NOT NULL
      AND line_item_no IS NOT NULL
    GROUP BY sales_order_no, regexp_replace(line_item_no::TEXT, '\\.0+$', '')
),
with_so_detail AS (
    SELECT
        ww.*,
        sd.so_qty
    FROM with_shipped ww
    LEFT JOIN so_detail_by_line sd
           ON sd.sales_order_no = ww.source_voucher_no
          AND sd.line_item_no = regexp_replace(ww.source_line_item_no::TEXT, '\\.0+$', '')
),
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw
    FROM with_so_detail ww
    LEFT JOIN public.pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.main_desc AS description
    FROM with_partial wp
    LEFT JOIN public.part_desc pd ON wp.final_inventory_code = pd.inventory_code
),
current_execution_stage AS (
    -- Active stage: prefer In Process with the most output (skips stale admin stages
    -- like Stock Issue that stay I while Turning is running). Else first open stage.
    SELECT DISTINCT ON (source_mps_no, pp_partial_no)
        source_mps_no,
        pp_partial_no,
        stage_no         AS current_stage_no,
        stage_desc       AS current_stage_desc,
        execution_status AS current_stage_status
    FROM public.mfg_wo_status
    WHERE COALESCE(execution_status, '') <> 'C'
      AND stage_no IS NOT NULL
    ORDER BY
        source_mps_no,
        pp_partial_no,
        CASE execution_status
            WHEN 'I' THEN 0
            WHEN 'R' THEN 1
            WHEN 'P' THEN 2
            ELSE 3
        END,
        COALESCE(total_acc_qty_produced, 0) DESC,
        stage_no ASC
),
with_wo_status AS (
    SELECT
        wd.*,
        ws.execution_status,
        ws.wo_qty_required,
        ws.total_acc_qty_produced,
        ws.total_rej_qty_produced
    FROM with_desc wd
    LEFT JOIN public.mfg_wo_status ws
           ON ws.source_mps_no = wd.ps_id
          AND ws.pp_partial_no = wd.pp_partial_no
          AND ws.stage_no = wd.stage_no
),
with_current_stage AS (
    SELECT
        w.*,
        ces.current_stage_no,
        ces.current_stage_desc,
        ces.current_stage_status
    FROM with_wo_status w
    LEFT JOIN current_execution_stage ces
           ON ces.source_mps_no = w.ps_id
          AND ces.pp_partial_no = w.pp_partial_no
),
computed AS (
    SELECT DISTINCT
        ps_id,
        pp_partial_no,
        final_inventory_code    AS part_no,
        description,
        CASE
            WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
            WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
            ELSE ws_item_qty
        END                     AS total_qty,
        COALESCE(
            NULLIF(partial_qty_raw, 0),
            CASE
                WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
                ELSE ws_item_qty
            END
        )                       AS partial_qty,
        so_qty                  AS so_det_qty,
        source_rsd              AS due_date,
        ps_order_date           AS order_date,
        bom_code,
        source_voucher_no,
        source_line_item_no,
        qty_shipped,
        CASE
            WHEN status = 'H'          THEN 'History'
            WHEN ws_status IS NOT NULL THEN ws_status
            WHEN status = 'O'          THEN 'Outstanding'
            ELSE status
        END                     AS status,
        CASE execution_status
            WHEN 'P' THEN 'Pending SI'
            WHEN 'R' THEN 'Ready to Start'
            WHEN 'I' THEN 'In Process'
            WHEN 'C' THEN 'Completed'
            ELSE execution_status
        END                     AS execution_status,
        wo_qty_required,
        total_acc_qty_produced  AS wo_qty_produced,
        total_rej_qty_produced  AS wo_qty_rejected,
        stage_no,
        stage_desc,
        op_no,
        current_stage_no,
        current_stage_desc,
        current_stage_status
    FROM with_current_stage
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no, stage_no;
"""


_PP_STAGING_SCHEMA_SQL = """
ALTER TABLE public.pp_voucher
    ADD COLUMN IF NOT EXISTS source_voucher_no TEXT;

ALTER TABLE public.pp_voucher
    ADD COLUMN IF NOT EXISTS source_line_item_no TEXT;

ALTER TABLE public.pp_voucher
    ALTER COLUMN source_voucher_no TYPE TEXT USING source_voucher_no::TEXT;

ALTER TABLE public.pp_voucher
    ALTER COLUMN source_line_item_no TYPE TEXT USING source_line_item_no::TEXT;

CREATE INDEX IF NOT EXISTS idx_pp_voucher_source_voucher
    ON public.pp_voucher (source_voucher_no, source_line_item_no);

CREATE TABLE IF NOT EXISTS public.sum_qty_shipped_by_sales_order (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    qty_shipped     NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no)
);

ALTER TABLE public.sum_qty_shipped_by_sales_order
    ALTER COLUMN sales_order_no TYPE TEXT USING sales_order_no::TEXT;

ALTER TABLE public.sum_qty_shipped_by_sales_order
    ALTER COLUMN line_item_no TYPE TEXT USING line_item_no::TEXT;

CREATE INDEX IF NOT EXISTS idx_qty_shipped_sales_order
    ON public.sum_qty_shipped_by_sales_order (sales_order_no, line_item_no);

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS source_voucher_no TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS source_line_item_no TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS qty_shipped NUMERIC;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS so_det_qty NUMERIC;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_no INTEGER;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_desc TEXT;

ALTER TABLE public.pp_vouchers_cache
    ADD COLUMN IF NOT EXISTS current_stage_status TEXT;

CREATE TABLE IF NOT EXISTS public.so_detail (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    inventory_code  TEXT        NOT NULL,
    item_code       TEXT,
    qty             NUMERIC,
    item_qty        NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no, inventory_code)
);

CREATE INDEX IF NOT EXISTS idx_so_detail_sales_order
    ON public.so_detail (sales_order_no, line_item_no);
"""


def _ensure_pp_staging_schema():
    from db import planner_get_conn, planner_release_conn

    conn = planner_get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DROP VIEW IF EXISTS public.vw_pp_vouchers")
            cur.execute(_PP_STAGING_SCHEMA_SQL)
            cur.execute(_VW_PP_VOUCHERS_SQL)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        planner_release_conn(conn)


@app.post("/api/admin/fix-execution-status")
def api_admin_fix_execution_status():
    from sync import run_mfg_wo_status_sync, run_sync
    results = {}
    try:
        _ensure_pp_staging_schema()
        results["view_updated"] = True
    except Exception as e:
        return jsonify({"error": f"view update failed: {e}"}), 500

    try:
        results["mfg_wo_status_sync"] = run_mfg_wo_status_sync(force=True)
    except Exception as e:
        return jsonify({"error": f"mfg_wo_status sync failed: {e}", **results}), 500

    try:
        results["pp_vouchers_sync"] = run_sync(force=True)
    except Exception as e:
        return jsonify({"error": f"pp_vouchers sync failed: {e}", **results}), 500

    return jsonify(results)


# ── API: mfg_wo_status sync ───────────────────────────────────────────────

@app.post("/api/mfg-wo-status/sync")
def api_mfg_wo_status_sync():
    from sync import run_mfg_wo_status_sync
    try:
        result = run_mfg_wo_status_sync(force=True)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: material_per_bom sync ────────────────────────────────────────────

@app.post("/api/material-per-bom/sync")
def api_material_per_bom_sync():
    from sync import run_material_per_bom_sync
    try:
        result = run_material_per_bom_sync(force=True)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: bom_op_stage sync ────────────────────────────────────────────────

@app.post("/api/bom-op-stage/sync")
def api_bom_op_stage_sync():
    from sync import run_bom_op_stage_sync
    try:
        result = run_bom_op_stage_sync(force=True)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: PP staging table syncs (COMAIN → Supabase) ───────────────────────

@app.post("/api/pp-voucher/sync")
def api_pp_voucher_sync():
    from sync import run_pp_voucher_sync
    try:
        return jsonify(run_pp_voucher_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/qty-shipped/sync")
def api_qty_shipped_sync():
    from sync import run_qty_shipped_sync
    try:
        _ensure_pp_staging_schema()
        return jsonify(run_qty_shipped_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/process-sheet/sync")
def api_process_sheet_sync():
    from sync import run_process_sheet_sync
    try:
        return jsonify(run_process_sheet_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/workorder-status/sync")
def api_workorder_status_sync():
    from sync import run_workorder_status_sync
    try:
        return jsonify(run_workorder_status_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/part-desc/sync")
def api_part_desc_sync():
    from sync import run_part_desc_sync
    try:
        return jsonify(run_part_desc_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/pp-partial/sync")
def api_pp_partial_sync():
    from sync import run_pp_partial_sync
    try:
        return jsonify(run_pp_partial_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/so-detail/sync")
def api_so_detail_sync():
    from sync import run_so_detail_sync
    try:
        _ensure_pp_staging_schema()
        return jsonify(run_so_detail_sync(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/api/pp-staging/status")
def api_pp_staging_status():
    from sync import get_pp_staging_status
    return jsonify(get_pp_staging_status())


@app.post("/api/pp-vouchers-cache/rebuild")
def api_pp_vouchers_cache_rebuild():
    """Rebuild pp_vouchers_cache from vw_pp_vouchers (no COMAIN staging)."""
    from sync import run_pp_staging_sync
    try:
        results = run_pp_staging_sync(steps=["pp_vouchers_cache"], force=True)
        _invalidate_pp_vouchers_with_ops_cache()
        failed = results.get("_failed_at")
        if failed:
            step_result = results.get(failed, {})
            err = step_result.get("error") or step_result.get("reason") or "cache rebuild failed"
            return jsonify({"error": err, **results}), 500
        return jsonify(results)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/pp-staging/sync")
def api_pp_staging_sync():
    """Run PP staging syncs; optional ?steps= or JSON {\"steps\": [...]}."""
    from db import domain_db_endpoint, domain_sync_likely_unreachable, domain_sync_unreachable
    from sync import run_pp_staging_sync
    try:
        steps, force = _parse_pp_staging_sync_args()
        staging_only = [s for s in steps if s != "pp_vouchers_cache"]
        if staging_only and domain_sync_unreachable():
            host, port = domain_db_endpoint()
            hint = (
                " Run ERP sync on a machine that can reach COMAIN "
                "(scripts/run_pp_staging_sync.py), or use VPN/tunnel and point DB_HOST "
                "at that endpoint."
            )
            if domain_sync_likely_unreachable():
                hint = (
                    " DB_HOST is on a private LAN; this server cannot open a TCP connection "
                    "to it." + hint
                )
            else:
                hint = f" Could not connect to {host}:{port}." + hint
            return jsonify({
                "error": "COMAIN (ERP database) is not reachable from this server." + hint,
                "db_host": host,
                "db_port": port,
            }), 503
        if staging_only:
            _ensure_pp_staging_schema()
        results = {"schema": {"updated": bool(staging_only)}}
        sync_results = run_pp_staging_sync(steps=steps, force=force)
        results.update(sync_results)
        if "pp_vouchers_cache" in steps or staging_only:
            _invalidate_pp_vouchers_with_ops_cache()
        failed = results.get("_failed_at")
        if failed:
            step_result = results.get(failed, {})
            err = step_result.get("error") or step_result.get("reason") or f"sync failed at {failed}"
            return jsonify({"error": err, **results}), 500
        return jsonify(results)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: health ────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    from db import domain_db_endpoint, domain_sync_likely_unreachable, domain_sync_unreachable
    host, port = domain_db_endpoint()
    payload = {
        "status": "ok",
        "db_host": host,
        "db_port": port,
        "db_host_private_lan": domain_sync_likely_unreachable(),
        "domain_sync_unreachable": domain_sync_unreachable(),
    }
    if domain_sync_unreachable():
        payload["db"] = "disconnected"
        if domain_sync_likely_unreachable():
            payload["note"] = (
                "DB_HOST is a private LAN address and TCP probe failed from this host."
            )
        return jsonify(payload)
    try:
        from db import get_conn, release_conn
        conn = get_conn()
        release_conn(conn)
        payload["db"] = "connected"
        return jsonify(payload)
    except Exception as e:
        payload["db"] = "disconnected"
        payload["domain_sync_unreachable"] = True
        payload["error"] = str(e)
        return jsonify(payload)


# ── API: Inventory BOM — sources (left panel) ──────────────────────────────

@app.get("/api/bom/sources")
def api_bom_sources():
    search = request.args.get("search", "").strip()
    try:
        search_clause = "AND s.inventory_code ILIKE %s" if search else ""
        params = (f"%{search}%",) if search else ()
        rows = db_query(
            f"""
            SELECT
                s.inventory_code AS source_code,
                COUNT(DISTINCT s.bom_code) AS bom_count
            FROM public.mt_inventory_bom_stage s
            WHERE s.bom_code IS NOT NULL
              AND (
                  s.stage_desc LIKE 'Turning%%'
               OR s.stage_desc LIKE 'Milling%%'
               OR s.stage_desc LIKE 'Turnmill%%'
              )
            {search_clause}
            GROUP BY s.inventory_code
            ORDER BY s.inventory_code
            """,
            params, fetchall=True
        )
        return jsonify([
            {"source_code": r[0], "bom_count": r[1]}
            for r in (rows or [])
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: Inventory BOM — bom codes for a source (tabs) ────────────────────

@app.get("/api/bom/sources/<path:source>/boms")
def api_source_boms(source):
    try:
        rows = db_query(
            """
            SELECT DISTINCT bom_code
            FROM public.mt_inventory_bom_stage
            WHERE inventory_code = %s
              AND bom_code IS NOT NULL
              AND (
                  stage_desc LIKE 'Turning%%'
               OR stage_desc LIKE 'Milling%%'
               OR stage_desc LIKE 'Turnmill%%'
              )
            ORDER BY bom_code
            """,
            (source,), fetchall=True
        )
        bom_codes = [r[0] for r in (rows or [])]
        return jsonify({"bom_codes": bom_codes})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: Inventory BOM — materials for source + bom (steps table) ──────────

# SELECT *
# FROM public.mt_inventory_item_view;

@app.get("/api/bom/materials")
def api_bom_materials():
    source = request.args.get("source", "").strip()
    if not source:
        return jsonify({"error": "source is required"}), 400
    try:
        rows = db_query(
            """
            SELECT DISTINCT
                source_inventory_code,
                material_inventory_code,
                description
            FROM public.inventory_bom_listing
            WHERE material_inventory_code NOT IN (
                SELECT source_inventory_code
                FROM public.inventory_bom_listing
                WHERE source_inventory_code IS NOT NULL
            )
            AND source_inventory_code = %s
            ORDER BY material_inventory_code
            """,
            (source,), fetchall=True
        )
        return jsonify([
            {
                "source_inventory_code": r[0],
                "material_inventory_code": r[1],
                "description": r[2] or "",
            }
            for r in (rows or [])
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500




# ── API: BOM operations (PostgreSQL) ──────────────────────────────────────

@app.get("/api/bom/operations")
def api_bom_operations():
    source = request.args.get("source", "").strip()
    bom    = request.args.get("bom",    "").strip()
    if not source or not bom:
        return jsonify({"error": "source and bom are required"}), 400
    try:
        rows = db_query(
            """
            WITH bom_machining AS (
                SELECT
                    inventory_code,
                    bom_code,
                    stage_no,
                    stage_desc,
                    CASE
                        WHEN SPLIT_PART(stage_desc, ' ', 2) ~ '^\\d+$'
                        THEN SPLIT_PART(stage_desc, ' ', 2)::INTEGER
                        ELSE NULL
                    END AS op_no
                FROM public.mt_inventory_bom_stage
                WHERE stage_desc IS NOT NULL
                  AND (
                      stage_desc LIKE 'Turning%%'
                   OR stage_desc LIKE 'Milling%%'
                   OR stage_desc LIKE 'Turnmill%%'
                  )
                  AND inventory_code = %s
                  AND bom_code = %s
            ),

            wt_raw AS (
                SELECT
                    t2.inventory_code,
                    t1.voucher_no,
                    t1.machine_no,
                    t2.stage_desc,
                    t3.total_acc_qty_produced,
                    CASE WHEN t1.status = 'H' THEN 1 ELSE 0 END AS status_rank
                FROM mfg_wo_comp_vch t1
                LEFT JOIN mfg_mps_vch t2 ON t1.voucher_no = t2.wo_voucher_no
                LEFT JOIN mfg_wo_vch  t3 ON t1.voucher_no = t3.voucher_no
                WHERE t2.inventory_code = %s
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

            wo_machines AS (
                SELECT inventory_code, stage_desc, MIN(machine_no) AS machine_no
                FROM wt_ranked
                WHERE rn = 1
                GROUP BY inventory_code, stage_desc
            )

            SELECT
                b.inventory_code,
                b.bom_code,
                b.stage_no,
                b.stage_desc,
                b.op_no,
                w.machine_no
            FROM bom_machining b
            LEFT JOIN wo_machines w
                ON  w.inventory_code = b.inventory_code
                AND w.stage_desc     = b.stage_desc
            ORDER BY
                b.stage_no  ASC,
                b.op_no     ASC NULLS LAST
            """,
            (source, bom, source), fetchall=True
        )
        return jsonify([
            {
                "inventory_code": r[0],
                "bom_code":       r[1],
                "stage_no":       r[2],
                "stage_desc":     r[3] or "",
                "op_no":          r[4],
                "machine_no":     r[5] or "",
            }
            for r in (rows or [])
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: stubs ─────────────────────────────────────────────────────────────

@app.get("/api/machine-schedule")
def api_machine_schedule():
    return jsonify([])


@app.get("/api/operations")
def api_operations():
    return jsonify([])


# ── API: Planner — Machines ────────────────────────────────────────────────

def _supa_get(path, params=None, *, service=False):
    import requests as req
    from db import supa_url, supa_headers
    r = req.get(
        f"{supa_url()}/{path}",
        headers=supa_headers(write=service),
        params=params,
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def _supa_fetch_all(path, params=None, *, service=False):
    """Paginated GET for tables that may exceed PostgREST's default row cap."""
    from sync import _supa_fetch_all as _fetch_all
    from db import supa_url, supa_headers

    return _fetch_all(
        f"{supa_url()}/{path}",
        headers=supa_headers(write=service),
        params=params or {},
    )

def _supa_post(path, payload):
    import requests as req
    from db import supa_url, supa_headers
    hdrs = {**supa_headers(write=True), "Prefer": "return=representation"}
    r = req.post(f"{supa_url()}/{path}", headers=hdrs, json=payload, timeout=15)
    r.raise_for_status()
    return r.json()

def _supa_patch(path, params, payload):
    import requests as req
    from db import supa_url, supa_headers
    hdrs = {**supa_headers(write=True), "Prefer": "return=representation"}
    r = req.patch(f"{supa_url()}/{path}", headers=hdrs, params=params, json=payload, timeout=15)
    r.raise_for_status()
    return r.json()

def _supa_delete(path, params):
    import requests as req
    from db import supa_url, supa_headers
    r = req.delete(f"{supa_url()}/{path}", headers=supa_headers(write=True), params=params, timeout=15)
    r.raise_for_status()


_MACHINE_CATEGORIES = ["TURNING", "MILLING", "TURNMILL", "MPP"]
_SHIFT_PROFILES     = ["STANDARD", "24HR"]


@app.get("/api/planner/machines")
def api_planner_machines_list():
    try:
        rows = _supa_get("planner_machines", {
            "select": "machine_id,machine_no,machine_category,shift_profile,active,notes",
            "order":  "machine_no",
        })
        return jsonify({
            "machines":           rows or [],
            "machine_categories": _MACHINE_CATEGORIES,
            "shift_profiles":     _SHIFT_PROFILES,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/machines")
def api_planner_machines_create():
    data = request.get_json(silent=True) or {}
    machine_no       = (data.get("machine_no") or "").strip()
    machine_category = (data.get("machine_category") or "").strip().upper()
    shift_profile    = (data.get("shift_profile") or "STANDARD").strip().upper()
    notes            = (data.get("notes") or "").strip()

    if not machine_no:
        return jsonify({"error": "machine_no is required"}), 400
    if machine_category not in _MACHINE_CATEGORIES:
        return jsonify({"error": f"machine_category must be one of {_MACHINE_CATEGORIES}"}), 400
    if shift_profile not in _SHIFT_PROFILES:
        return jsonify({"error": f"shift_profile must be one of {_SHIFT_PROFILES}"}), 400

    try:
        result = _supa_post("planner_machines", {
            "machine_no":       machine_no,
            "machine_category": machine_category,
            "shift_profile":    shift_profile,
            "active":           True,
            "notes":            notes,
        })
        return jsonify(result[0] if isinstance(result, list) else result), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.patch("/api/planner/machines/<int:machine_id>")
def api_planner_machines_update(machine_id):
    data = request.get_json(silent=True) or {}
    payload = {}

    if "machine_no" in data:
        val = (data["machine_no"] or "").strip()
        if not val:
            return jsonify({"error": "machine_no cannot be empty"}), 400
        payload["machine_no"] = val

    if "machine_category" in data:
        val = (data["machine_category"] or "").strip().upper()
        if val not in _MACHINE_CATEGORIES:
            return jsonify({"error": f"machine_category must be one of {_MACHINE_CATEGORIES}"}), 400
        payload["machine_category"] = val

    if "shift_profile" in data:
        val = (data["shift_profile"] or "").strip().upper()
        if val not in _SHIFT_PROFILES:
            return jsonify({"error": f"shift_profile must be one of {_SHIFT_PROFILES}"}), 400
        payload["shift_profile"] = val

    if "active" in data:
        payload["active"] = bool(data["active"])

    if "notes" in data:
        payload["notes"] = (data["notes"] or "").strip()

    if not payload:
        return jsonify({"error": "No fields to update"}), 400

    payload["updated_at"] = "now()"

    try:
        result = _supa_patch(
            "planner_machines",
            {"machine_id": f"eq.{machine_id}"},
            payload,
        )
        return jsonify(result[0] if isinstance(result, list) else result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.delete("/api/planner/machines/<int:machine_id>")
def api_planner_machines_delete(machine_id):
    try:
        _supa_delete("planner_machines", {"machine_id": f"eq.{machine_id}"})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: Planner — Master cycle times (Supabase) ─────────────────────────────

_CT_MASTER_SELECT = (
    "id,bom_code,part_no,part_description,stage_no,stage_name,op_no,op_type,"
    "program_no,program_file,tool_list_file,cycle_time,set_up_time,updated_at"
)


def _non_negative_number(value, default=0.0):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return float(default)


@app.get("/api/planner/cycle-times")
def api_planner_cycle_times_list():
    """List master cycle times. Uses service role (RLS on this table blocks anon reads)."""
    try:
        rows = _supa_fetch_all(
            "planner_cycle_time_master",
            {
                "select": _CT_MASTER_SELECT,
                "order": "id",
            },
            service=True,
        )
        return jsonify({"rows": rows or [], "count": len(rows or [])})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times")
def api_planner_cycle_times_create():
    data = request.get_json(silent=True) or {}
    bom_code = (data.get("bom_code") or "").strip()
    part_no = (data.get("part_no") or "").strip()
    part_description = (data.get("part_description") or "").strip()
    stage_name = (data.get("stage_name") or "").strip()
    op_type = (data.get("op_type") or "").strip()
    program_no = (data.get("program_no") or "").strip()
    program_file = (data.get("program_file") or "").strip()
    tool_list_file = (data.get("tool_list_file") or "").strip()

    if not part_no:
        return jsonify({"error": "part_no (inventory code) is required"}), 400

    try:
        stage_no = int(data.get("stage_no"))
    except (TypeError, ValueError):
        return jsonify({"error": "stage_no must be an integer"}), 400

    op_raw = data.get("op_no")
    op_no = None
    if op_raw is not None and str(op_raw).strip() != "":
        try:
            op_no = int(op_raw)
        except (TypeError, ValueError):
            return jsonify({"error": "op_no must be an integer when provided"}), 400

    payload = {
        "bom_code": bom_code,
        "part_no": part_no,
        "part_description": part_description,
        "stage_no": stage_no,
        "stage_name": stage_name,
        "op_no": op_no,
        "op_type": op_type,
        "program_no": program_no,
        "program_file": program_file,
        "tool_list_file": tool_list_file,
        "cycle_time": _non_negative_number(data.get("cycle_time"), 0),
        "set_up_time": _non_negative_number(data.get("set_up_time"), 0),
    }

    try:
        result = _supa_post("planner_cycle_time_master", payload)
        return jsonify(result[0] if isinstance(result, list) else result), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.patch("/api/planner/cycle-times/<int:row_id>")
def api_planner_cycle_times_update(row_id):
    data = request.get_json(silent=True) or {}
    payload = {}

    if "bom_code" in data:
        payload["bom_code"] = (data.get("bom_code") or "").strip()
    if "part_no" in data:
        v = (data["part_no"] or "").strip()
        if not v:
            return jsonify({"error": "part_no cannot be empty"}), 400
        payload["part_no"] = v
    if "part_description" in data:
        payload["part_description"] = (data["part_description"] or "").strip()
    if "op_type" in data:
        payload["op_type"] = (data["op_type"] or "").strip()
    if "stage_no" in data:
        try:
            payload["stage_no"] = int(data["stage_no"])
        except (TypeError, ValueError):
            return jsonify({"error": "stage_no must be an integer"}), 400
    if "stage_name" in data:
        payload["stage_name"] = (data.get("stage_name") or "").strip()
    if "op_no" in data:
        raw = data["op_no"]
        if raw is None or str(raw).strip() == "":
            payload["op_no"] = None
        else:
            try:
                payload["op_no"] = int(raw)
            except (TypeError, ValueError):
                return jsonify({"error": "op_no must be an integer when provided"}), 400
    if "cycle_time" in data:
        payload["cycle_time"] = _non_negative_number(data.get("cycle_time"), 0)
    if "set_up_time" in data:
        payload["set_up_time"] = _non_negative_number(data.get("set_up_time"), 0)
    if "program_no" in data:
        payload["program_no"] = (data.get("program_no") or "").strip()
    if "program_file" in data:
        payload["program_file"] = (data.get("program_file") or "").strip()
    if "tool_list_file" in data:
        payload["tool_list_file"] = (data.get("tool_list_file") or "").strip()

    if not payload:
        return jsonify({"error": "No fields to update"}), 400

    payload["updated_at"] = "now()"

    try:
        result = _supa_patch(
            "planner_cycle_time_master",
            {"id": f"eq.{row_id}"},
            payload,
        )
        return jsonify(result[0] if isinstance(result, list) else result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.delete("/api/planner/cycle-times/<int:row_id>")
def api_planner_cycle_times_delete(row_id):
    try:
        _supa_delete("planner_cycle_time_master", {"id": f"eq.{row_id}"})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/import-new")
def api_planner_cycle_times_import_new():
    """
    Insert new master rows from planner_program_tools only.
    Existing master rows are never updated or overwritten.
    """
    from planning.cycle_time_master_import import import_new_from_program_tools

    try:
        result = import_new_from_program_tools()
        if result.get("error"):
            return jsonify(result), 503
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/sync")
def api_planner_cycle_times_sync():
    """
    Incremental sync (default): sheet -> planner_program_tools upsert,
    then insert-only new master rows. Never truncates master; never wipes program tools.
    """
    from planning.cycle_time_master_import import sync_cycle_times_incremental

    try:
        result = sync_cycle_times_incremental()
        if result.get("program_tools", {}).get("error"):
            return jsonify(result), 500
        if result.get("master", {}).get("error"):
            return jsonify(result), 503
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/reload-from-program-tools")
def api_planner_cycle_times_reload():
    """DESTRUCTIVE: truncate master and reload. Requires ALLOW_MASTER_TRUNCATE=1."""
    if os.getenv("ALLOW_MASTER_TRUNCATE", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return jsonify({
            "error": (
                "Master truncate is disabled. Use POST /api/planner/cycle-times/sync "
                "(upsert + insert new only). Set ALLOW_MASTER_TRUNCATE=1 only for one-off admin rebuilds."
            ),
        }), 403
    from planning.cycle_time_master_import import reload_master_from_program_tools

    try:
        result = reload_master_from_program_tools()
        if result.get("error"):
            return jsonify(result), 503
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/full-reload")
def api_planner_cycle_times_full_reload():
    """DESTRUCTIVE admin rebuild. Requires ALLOW_MASTER_TRUNCATE=1."""
    if os.getenv("ALLOW_MASTER_TRUNCATE", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return jsonify({
            "error": (
                "Full reload is disabled. Use POST /api/planner/cycle-times/sync instead. "
                "Set ALLOW_MASTER_TRUNCATE=1 only for one-off admin rebuilds."
            ),
        }), 403
    from planning.cycle_time_master_import import reload_master_from_program_tools
    from planning.program_tool_list_route import (
        sync_program_tool_list_to_supabase,
        sync_tool_list_sheet_to_sqlite,
    )

    out: dict = {}
    try:
        if os.getenv("tool_list_secret_key", "").strip():
            out["program_tools_sheet"] = sync_tool_list_sheet_to_sqlite()
        else:
            out["program_tools_sheet"] = {"skipped": True, "reason": "no tool_list_secret_key"}

        out["program_tools_supabase"] = sync_program_tool_list_to_supabase(full_refresh=True)
        if out["program_tools_supabase"].get("error"):
            return jsonify(out), 500

        out["master"] = reload_master_from_program_tools()
        if out["master"].get("error"):
            return jsonify(out), 503
        return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e), **out}), 500


# ── Background auto-sync ──────────────────────────────────────────────────────
# Runs the full PP staging pipeline every AUTO_SYNC_INTERVAL seconds, then
# program-tool-list (Google Sheet → SQLite → planner_program_tools on Supabase)
# unless DISABLE_AUTO_PROGRAM_TOOL_LIST_SYNC is set.
# daemon=True so the thread dies cleanly when Flask exits.
# WERKZEUG_RUN_MAIN guard prevents double-start in Flask's debug reloader.

AUTO_SYNC_INTERVAL = int(os.getenv("AUTO_SYNC_INTERVAL", 900))  # default 15 min


def _auto_sync_loop():
    from db import domain_sync_unreachable
    from sync import (
        run_pp_voucher_sync, run_process_sheet_sync, run_workorder_status_sync,
        run_part_desc_sync, run_pp_partial_sync, run_mfg_wo_status_sync,
        run_qty_shipped_sync, run_so_detail_sync, run_sync,
    )
    log.info("auto-sync thread started, interval=%ds", AUTO_SYNC_INTERVAL)
    while True:
        if domain_sync_unreachable():
            log.warning(
                "auto-sync skipped: cannot reach COMAIN at %s:%s from this host",
                os.getenv("DB_HOST"),
                os.getenv("DB_PORT", 5432),
            )
            time.sleep(AUTO_SYNC_INTERVAL)
            continue
        try:
            run_pp_voucher_sync(force=True)
            run_process_sheet_sync(force=True)
            run_workorder_status_sync(force=True)
            run_qty_shipped_sync(force=True)
            run_so_detail_sync(force=True)
            run_part_desc_sync(force=True)
            run_pp_partial_sync(force=True)
            run_mfg_wo_status_sync(force=True)
            run_sync(force=True)
            try:
                from planning.program_tool_list_route import run_auto_program_tool_list_sync

                run_auto_program_tool_list_sync(log)
            except Exception as e:
                log.error("program-tool-list auto-sync error: %s", e)
            log.info("auto-sync complete")
        except Exception as e:
            log.error("auto-sync error: %s", e)
        time.sleep(AUTO_SYNC_INTERVAL)


_disable_auto_sync = os.getenv("DISABLE_AUTO_SYNC", "").strip().lower() in {
    "1", "true", "yes", "on",
}
if os.environ.get("WERKZEUG_RUN_MAIN") != "false" and not _disable_auto_sync:
    _t = threading.Thread(target=_auto_sync_loop, daemon=True, name="auto-sync")
    _t.start()
elif _disable_auto_sync:
    log.info("background auto-sync disabled (DISABLE_AUTO_SYNC)")


# ── Background auto-unschedule (done ops leave machine lane, anchor kept) ───
# NOT related to ERP sync — only updates planner DB (move DONE blocks off lanes).
#
# How it runs:
#   1. Full scheduler page reload → GET /api/trial/schedule (main path; works when hosted).
#   2. Saving actuals in the UI (planning/actuals.py) — immediate when a block becomes DONE.
#   3. This thread + OS cron scripts — optional backup if nobody has the page open.
#
# ERP sync is unrelated (COMAIN → cache). Auto-unschedule only touches planner DB rows.

AUTO_UNSCHEDULE_INTERVAL = int(os.getenv("AUTO_UNSCHEDULE_INTERVAL", 120))


def _auto_unschedule_loop():
    from planning.auto_unschedule import (
        auto_unschedule_enabled,
        ensure_saved_anchor_column,
        run_auto_unschedule_sweep,
    )
    from planning.helpers import planner_db

    log.info("auto-unschedule thread started, interval=%ds", AUTO_UNSCHEDULE_INTERVAL)
    migration_done = False
    while True:
        if not auto_unschedule_enabled():
            time.sleep(AUTO_UNSCHEDULE_INTERVAL)
            continue
        try:
            with planner_db() as con:
                if not migration_done:
                    ensure_saved_anchor_column(con)
                    migration_done = True
                summary = run_auto_unschedule_sweep(con, dry_run=False)
            unscheduled = int(summary.get("unscheduled") or 0)
            if unscheduled:
                log.info(
                    "auto-unschedule: returned %d done block(s) to catalog (anchor preserved)",
                    unscheduled,
                )
        except Exception as e:
            log.error("auto-unschedule error: %s", e)
        time.sleep(AUTO_UNSCHEDULE_INTERVAL)


_disable_auto_unschedule = os.getenv("DISABLE_AUTO_UNSCHEDULE_DONE_OPS", "").strip().lower() in {
    "1", "true", "yes", "on",
}
if os.environ.get("WERKZEUG_RUN_MAIN") != "false" and not _disable_auto_unschedule:
    _unsched_t = threading.Thread(target=_auto_unschedule_loop, daemon=True, name="auto-unschedule")
    _unsched_t.start()
elif _disable_auto_unschedule:
    log.info("background auto-unschedule disabled (DISABLE_AUTO_UNSCHEDULE_DONE_OPS)")


if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", 5001))
    debug = os.getenv("FLASK_ENV") == "development"
    app.run(host="0.0.0.0", port=port, debug=debug)
