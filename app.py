import logging
import os
import threading
import time
from flask import Flask, render_template, jsonify, request, redirect, url_for
from dotenv import load_dotenv

log = logging.getLogger(__name__)

load_dotenv()

app = Flask(__name__)

# ── Planning blueprints ────────────────────────────────────────────────────
from planning.process_sheets import process_sheets_bp
from planning.summary import trial_summary_bp
from planning.flows import flows_bp, trial_prefixed_flows_bp
from planning.gantt_route import trial_gantt_bp
from planning.materials_route import materials_route_bp
from planning.planner_routes import trial_bp

app.register_blueprint(process_sheets_bp)
app.register_blueprint(trial_summary_bp)
app.register_blueprint(flows_bp)
app.register_blueprint(trial_prefixed_flows_bp)
app.register_blueprint(trial_gantt_bp)
app.register_blueprint(materials_route_bp)
app.register_blueprint(trial_bp)
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


@app.get("/planning-data/program-tool-list")
def program_tool_list():
    return render_template("planning_data/program_tool_list.html", active="planning_data")


@app.get("/planning-data/machines")
def machines_page():
    return render_template("planning_data/machines.html", active="planning_data")


@app.get("/planning-data/materials")
def materials():
    return render_template("planning_data/materials.html", active="planning_data")


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
    "bom_code", "status", "execution_status",
    "stage_no", "stage_desc", "op_no",
]


@app.get("/api/pp-vouchers")
def api_pp_vouchers():
    import requests as req
    from db import supa_url, supa_headers
    from sync import run_sync, is_sync_needed
    try:
        if is_sync_needed():
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
    import requests as req
    from db import supa_url, supa_headers
    from sync import is_sync_needed
    try:
        # Trigger sync in background — serve cached data immediately
        if is_sync_needed():
            from sync import run_sync, run_mfg_wo_status_sync
            def _bg_sync():
                try:
                    run_mfg_wo_status_sync()
                except Exception:
                    pass
                try:
                    run_sync()
                except Exception:
                    pass
            threading.Thread(target=_bg_sync, daemon=True).start()

        from sync import _supa_fetch_all
        cache_rows = _supa_fetch_all(
            f"{supa_url()}/pp_vouchers_cache",
            headers=supa_headers(write=True),
            params={"select": ",".join(_PP_VOUCHERS_COLS), "order": "ps_id,pp_partial_no,stage_no"},
        )

        # Group cache rows by (ps_id, pp_partial_no) — one cache row per stage
        grouped = {}
        for row in cache_rows:
            pp_partial = int(row.get("pp_partial_no") or 1)
            ps_id_raw = row.get("ps_id") or ""
            ps_key = (ps_id_raw, pp_partial)
            ps_id = f"{ps_id_raw}::{pp_partial}" if pp_partial > 1 else ps_id_raw

            if ps_key not in grouped:
                part_no = row.get("part_no") or ""
                grouped[ps_key] = {
                    "ps_id": ps_id,
                    "part_no": part_no,
                    "part_name": part_no,
                    "part_desc": row.get("description") or "",
                    "due_date": str(row.get("due_date") or ""),
                    "order_date": str(row.get("order_date") or ""),
                    "bom_code": row.get("bom_code") or "",
                    "total_qty": float(row.get("total_qty") or 0),
                    "partial_qty": float(row.get("partial_qty") or 0),
                    "status": row.get("status") or "",
                    "execution_status": row.get("execution_status") or None,
                    "planner_status": None,
                    "op_cards": [],
                    "ops": [],
                    "flow_options": [],
                }

            entry = grouped[ps_key]
            stage_desc = row.get("stage_desc") or ""
            op_no = str(row.get("op_no") or "")
            stage_no = int(row.get("stage_no") or 0)

            if stage_desc:
                qty = float(row.get("partial_qty") or row.get("total_qty") or 0)
                machine_group = stage_desc.split()[0].upper() if stage_desc else ""
                op_card = {
                    "card_kind": "single",
                    "card_id": None,
                    "ps_id": entry["ps_id"],
                    "operation_label": op_no or stage_desc,
                    "operation_name": stage_desc,
                    "op_type": stage_desc,
                    "target_qty": qty,
                    "remaining_qty": qty,
                    "source_ps_id": entry["ps_id"],
                    "source_op_seq_id": stage_no,
                    "source_op_no": op_no,
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

        return jsonify(list(grouped.values()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/pp-vouchers/sync")
def api_pp_vouchers_sync():
    """Force a sync regardless of cooldown (manual trigger)."""
    from sync import run_sync
    try:
        result = run_sync(force=True)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
        b.source_line_item_no,
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
    WHERE ps_id LIKE '%APS%'
       OR ps_id LIKE '%NPS%'
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
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw
    FROM with_workorder ww
    LEFT JOIN public.pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.main_desc AS description
    FROM with_partial wp
    LEFT JOIN public.part_desc pd ON wp.final_inventory_code = pd.inventory_code
),
with_wo_status AS (
    SELECT
        wd.*,
        ws.execution_status
    FROM with_desc wd
    LEFT JOIN public.mfg_wo_status ws ON ws.source_mps_no = wd.ps_id
),
computed AS (
    SELECT DISTINCT
        ps_id,
        pp_partial_no,
        final_inventory_code    AS part_no,
        description,
        CASE
            WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
            WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
            ELSE pp_qty
        END                     AS total_qty,
        CASE
            WHEN partial_qty_raw IS NULL
              OR partial_qty_raw = 0
              OR partial_qty_raw >= CASE
                    WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                    WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
                    ELSE pp_qty END
              OR (length(ps_id) - length(replace(ps_id, '-', ''))) > 1
            THEN CASE
                    WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                    WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
                    ELSE pp_qty END
            ELSE partial_qty_raw
        END                     AS partial_qty,
        source_rsd              AS due_date,
        ps_order_date           AS order_date,
        bom_code,
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
        stage_no,
        stage_desc,
        op_no
    FROM with_wo_status
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no, stage_no;
"""

@app.post("/api/admin/fix-execution-status")
def api_admin_fix_execution_status():
    from db import planner_get_conn, planner_release_conn
    from sync import run_mfg_wo_status_sync, run_sync
    results = {}
    conn = planner_get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(_VW_PP_VOUCHERS_SQL)
        conn.commit()
        results["view_updated"] = True
    except Exception as e:
        conn.rollback()
        return jsonify({"error": f"view update failed: {e}"}), 500
    finally:
        planner_release_conn(conn)

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


@app.post("/api/pp-staging/sync")
def api_pp_staging_sync():
    """Run all 5 PP staging syncs then rebuild the pp_vouchers_cache."""
    from sync import (
        run_pp_voucher_sync, run_process_sheet_sync, run_workorder_status_sync,
        run_part_desc_sync, run_pp_partial_sync, run_sync,
    )
    try:
        results = {
            "pp_voucher":            run_pp_voucher_sync(force=True),
            "mfg_process_sheet_info": run_process_sheet_sync(force=True),
            "workorder_status":      run_workorder_status_sync(force=True),
            "part_desc":             run_part_desc_sync(force=True),
            "pp_partial":            run_pp_partial_sync(force=True),
            "pp_vouchers_cache":     run_sync(force=True),
        }
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: health ────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    try:
        from db import get_conn, release_conn
        conn = get_conn()
        release_conn(conn)
        return jsonify({"status": "ok", "db": "connected"})
    except Exception as e:
        return jsonify({"status": "ok", "db": "disconnected", "error": str(e)})


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


# ── API: Program / Tool List ───────────────────────────────────────────────

_PTL_SHEET_ID  = "1e7_ahcp15jLHOKhX6W1b6TLUvbZr-wM5H_MzMzYXIXg"
_PTL_SHEET_GID = 606390196


@app.post("/api/program-tool-list/sync")
def api_ptl_sync():
    import urllib.request
    import urllib.parse
    import urllib.error
    import json as _json
    from tool_list_db import init_db, replace_all, COLUMNS

    api_key = os.getenv("tool_list_secret_key", "").strip()

    def sheets_get(url, params):
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
            raise RuntimeError(f"Google API {e.code}: {msg}")

    try:
        if not api_key:
            return jsonify({"error": "tool_list_secret_key is not set in .env"}), 500
        # Resolve tab name from GID (Sheets API needs the name, not the numeric GID)
        meta = sheets_get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{_PTL_SHEET_ID}",
            {"key": api_key, "fields": "sheets(properties(sheetId,title))"},
        )
        sheet_name = next(
            (s["properties"]["title"]
             for s in meta.get("sheets", [])
             if s["properties"]["sheetId"] == _PTL_SHEET_GID),
            None,
        )
        if not sheet_name:
            return jsonify({"error": f"Tab with gid={_PTL_SHEET_GID} not found in spreadsheet"}), 400

        data = sheets_get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{_PTL_SHEET_ID}/values/{urllib.parse.quote(sheet_name)}",
            {"key": api_key},
        )
        values = data.get("values", [])
        if not values:
            return jsonify({"synced": 0, "message": "Sheet is empty"})

        n = len(COLUMNS)
        # Skip two header rows (row1 = form question text, row2 = short labels)
        rows = [tuple((list(r) + [""] * n)[:n]) for r in values[2:]]

        init_db()
        replace_all(rows)
        return jsonify({"synced": len(rows)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/api/program-tool-list")
def api_ptl_data():
    from tool_list_db import init_db, fetch_all, last_synced
    search = request.args.get("search", "").strip()
    try:
        init_db()
        rows = fetch_all(search)

        # Enrich with ERP part number from PostgreSQL using ps_no as key
        ps_nos = list({r["ps_no"] for r in rows if r.get("ps_no")})
        part_no_erp_map = {}
        if ps_nos:
            try:
                erp_rows = db_query(
                    """
                    SELECT DISTINCT process_sheet_no, inventory_code
                    FROM public.mfg_process_sheet_info_v1_view
                    WHERE process_sheet_no = ANY(%s)
                    """,
                    (ps_nos,), fetchall=True
                )
                if erp_rows:
                    for er in erp_rows:
                        part_no_erp_map[er[0]] = er[1]
            except Exception:
                pass  # PostgreSQL unavailable — leave column blank

        for row in rows:
            row["part_no_erp"] = part_no_erp_map.get(row.get("ps_no") or "", "") or ""

        # Enrich with actual machine_no from WO completion history (by part_no_erp + stage_desc)
        actual_machine_map = {}
        part_no_erp_list = list({row["part_no_erp"] for row in rows if row.get("part_no_erp")})
        if part_no_erp_list:
            try:
                wo_rows = db_query(
                    """
                    WITH wt_raw AS (
                        SELECT
                            t2.inventory_code,
                            t1.voucher_no,
                            t1.machine_no,
                            t2.stage_desc,
                            t3.total_acc_qty_produced,
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
                    (part_no_erp_list,), fetchall=True
                )
                if wo_rows:
                    for wr in wo_rows:
                        actual_machine_map[(wr[0], wr[1])] = wr[2]
            except Exception:
                pass  # PostgreSQL unavailable — leave blank

        for row in rows:
            part_no_erp = row.get("part_no_erp") or ""
            op_type     = row.get("operation_type") or ""
            op_no       = row.get("operation_no") or row.get("operation_no_2") or ""
            stage       = f"{op_type} {op_no}".strip() if op_no else op_type
            row["actual_machine_no"] = actual_machine_map.get((part_no_erp, stage), "")

        return jsonify({"rows": rows, "last_synced": last_synced()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.post("/api/program-tool-list/sync-to-supabase")
def api_ptl_sync_to_supabase():
    try:
        from tool_list_db import init_db, fetch_all
        import requests as req
        from db import supa_url, supa_headers

        init_db()
        rows = fetch_all()
        if not rows:
            return jsonify({"synced": 0, "message": "No rows in tool list"})

        # Enrich part_no_erp
        part_no_erp_map = {}
        ps_nos = list({r.get("ps_no") for r in rows if r.get("ps_no")})
        if ps_nos:
            try:
                erp_rows = db_query(
                    "SELECT DISTINCT process_sheet_no, inventory_code FROM public.mfg_process_sheet_info_v1_view WHERE process_sheet_no = ANY(%s)",
                    (ps_nos,), fetchall=True
                )
                if erp_rows:
                    part_no_erp_map = {er[0]: er[1] for er in erp_rows}
            except Exception:
                pass

        # Enrich wo_machine
        actual_machine_map = {}
        part_no_erp_list = list(set(part_no_erp_map.values()))
        if part_no_erp_list:
            try:
                wo_rows = db_query(
                    """
                    WITH wt_raw AS (
                        SELECT t2.inventory_code, t1.voucher_no, t1.machine_no,
                               t2.stage_desc, t3.total_acc_qty_produced,
                               CASE WHEN t1.status = 'H' THEN 1 ELSE 0 END AS status_rank
                        FROM mfg_wo_comp_vch t1
                        LEFT JOIN mfg_mps_vch t2 ON t1.voucher_no = t2.wo_voucher_no
                        LEFT JOIN mfg_wo_vch t3 ON t1.voucher_no = t3.voucher_no
                        WHERE t2.inventory_code = ANY(%s)
                          AND (t2.stage_desc LIKE 'Turning%%' OR t2.stage_desc LIKE 'Milling%%' OR t2.stage_desc LIKE 'Turnmill%%')
                    ),
                    wt_ranked AS (
                        SELECT *, ROW_NUMBER() OVER(PARTITION BY voucher_no ORDER BY total_acc_qty_produced DESC, status_rank DESC) AS rn
                        FROM wt_raw
                    )
                    SELECT inventory_code, stage_desc, MIN(machine_no) AS machine_no
                    FROM wt_ranked WHERE rn = 1
                    GROUP BY inventory_code, stage_desc
                    """,
                    (part_no_erp_list,), fetchall=True
                )
                if wo_rows:
                    actual_machine_map = {(wr[0], wr[1]): wr[2] for wr in wo_rows}
            except Exception:
                pass

        # Build payload (your 6 fields + operation_no)
        payload = []
        for r in rows:
            ps_no = r.get("ps_no") or ""
            part_no_erp = (part_no_erp_map.get(ps_no) or "").strip()
            cnc_machine = (r.get("cnc_machine_no") or "").strip()
            op_no = (r.get("operation_no") or r.get("operation_no_2") or "").strip()
            op_type = (r.get("operation_type") or "").strip()
            stage = f"{op_type} {op_no}".strip() if op_no else op_type
            wo_machine = (actual_machine_map.get((part_no_erp, stage)) or "").strip()
            program_file = (r.get("program_file") or "").strip()
            tool_list_files = (r.get("tool_list_files") or "").strip()
            programmer_name = (r.get("programmer_name") or "").strip()

            # Skip completely empty rows
            if not any([program_file, tool_list_files, part_no_erp, programmer_name, cnc_machine, wo_machine, op_no]):
                continue

            payload.append({
                "program_file": program_file,
                "tool_list_files": tool_list_files,
                "part_no_erp": part_no_erp,
                "programmer_name": programmer_name,
                "cnc_machine_no": cnc_machine,
                "wo_machine": wo_machine,
                "operation_no": op_no,  # ✅ Added
            })

        if not payload:
            return jsonify({"synced": 0, "message": "No valid rows to sync"})

        # DELETE all + INSERT fresh (no conflicts)
        hdrs = supa_headers(write=True)
        req.delete(f"{supa_url()}/planner_program_tools", headers=hdrs, params={"id": "gt.0"}, timeout=30)
        
        # Batch insert (Supabase limit: 1000 rows/request)
        BATCH_SIZE = 1000
        for i in range(0, len(payload), BATCH_SIZE):
            batch = payload[i:i+BATCH_SIZE]
            r = req.post(f"{supa_url()}/planner_program_tools", headers={**hdrs, "Prefer": "return=representation"}, json=batch, timeout=60)
            r.raise_for_status()
        
        return jsonify({"synced": len(payload)})

    except Exception as e:
        import traceback, sys
        print(f"❌ SYNC ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return jsonify({"error": str(e)}), 500

# ── API: stubs ─────────────────────────────────────────────────────────────

@app.get("/api/machine-schedule")
def api_machine_schedule():
    return jsonify([])


@app.get("/api/operations")
def api_operations():
    return jsonify([])


# ── API: Planner — Machines ────────────────────────────────────────────────

def _supa_get(path, params=None):
    import requests as req
    from db import supa_url, supa_headers
    r = req.get(f"{supa_url()}/{path}", headers=supa_headers(), params=params, timeout=15)
    r.raise_for_status()
    return r.json()

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


# ── Background auto-sync ──────────────────────────────────────────────────────
# Runs the full PP staging pipeline every AUTO_SYNC_INTERVAL seconds.
# daemon=True so the thread dies cleanly when Flask exits.
# WERKZEUG_RUN_MAIN guard prevents double-start in Flask's debug reloader.

AUTO_SYNC_INTERVAL = int(os.getenv("AUTO_SYNC_INTERVAL", 900))  # default 15 min


def _auto_sync_loop():
    from sync import (
        run_pp_voucher_sync, run_process_sheet_sync, run_workorder_status_sync,
        run_part_desc_sync, run_pp_partial_sync, run_mfg_wo_status_sync, run_sync,
    )
    log.info("auto-sync thread started, interval=%ds", AUTO_SYNC_INTERVAL)
    while True:
        try:
            run_pp_voucher_sync(force=True)
            run_process_sheet_sync(force=True)
            run_workorder_status_sync(force=True)
            run_part_desc_sync(force=True)
            run_pp_partial_sync(force=True)
            run_mfg_wo_status_sync(force=True)
            run_sync(force=True)
            log.info("auto-sync complete")
        except Exception as e:
            log.error("auto-sync error: %s", e)
        time.sleep(AUTO_SYNC_INTERVAL)


if os.environ.get("WERKZEUG_RUN_MAIN") != "false":
    _t = threading.Thread(target=_auto_sync_loop, daemon=True, name="auto-sync")
    _t.start()


if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", 5000))
    debug = os.getenv("FLASK_ENV") == "development"
    app.run(host="0.0.0.0", port=port, debug=debug)
