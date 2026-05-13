import os
from flask import Flask, render_template, jsonify, request, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
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


# ── Pages ──────────────────────────────────────────────────────────────────

@app.get("/")
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
        search_clause = "AND source_inventory_code ILIKE %s" if search else ""
        params = (f"%{search}%",) if search else ()
        rows = db_query(
            f"""
            SELECT
                source_inventory_code,
                COUNT(DISTINCT bom_code) AS bom_count
            FROM public.inventory_bom_listing
            WHERE source_inventory_code IS NOT NULL
            {search_clause}
            AND material_inventory_code NOT IN (
                SELECT source_inventory_code
                FROM public.inventory_bom_listing
                WHERE source_inventory_code IS NOT NULL
            )
            GROUP BY source_inventory_code
            ORDER BY source_inventory_code
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
            FROM public.inventory_bom_listing
            WHERE source_inventory_code = %s
              AND bom_code IS NOT NULL
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
    bom = request.args.get("bom", "").strip()
    if not source or not bom:
        return jsonify({"error": "source and bom are required"}), 400
    try:
        rows = db_query(
            """
            SELECT DISTINCT
                bom_code,
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
            AND bom_code = %s
            ORDER BY material_inventory_code
            """,
            (source, bom), fetchall=True
        )
        return jsonify([
            {
                "bom_code": r[0],
                "source_inventory_code": r[1],
                "material_inventory_code": r[2],
                "description": r[3] or "",
            }
            for r in (rows or [])
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500



# ── API: BOM metadata (flow name) ──────────────────────────────────────────

@app.get("/api/bom/meta")
def api_bom_meta():
    source = request.args.get("source", "").strip()
    bom = request.args.get("bom", "").strip()
    if not source or not bom:
        return jsonify({"error": "source and bom are required"}), 400
    try:
        row = db_query(
            "SELECT flow_name FROM bom_metadata WHERE source_inventory_code = %s AND bom_code = %s",
            (source, bom), fetchone=True
        )
        return jsonify({"flow_name": row[0] if row else ""})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/bom/meta")
def api_save_bom_meta():
    data = request.get_json()
    source = (data.get("source") or "").strip()
    bom = (data.get("bom") or "").strip()
    flow_name = (data.get("flow_name") or "").strip()
    if not source or not bom:
        return jsonify({"error": "source and bom are required"}), 400
    try:
        db_query(
            """
            INSERT INTO bom_metadata (source_inventory_code, bom_code, flow_name)
            VALUES (%s, %s, %s)
            ON CONFLICT (source_inventory_code, bom_code)
            DO UPDATE SET flow_name = EXCLUDED.flow_name
            """,
            (source, bom, flow_name), commit=True
        )
        return jsonify({"ok": True})
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
            WITH wt_raw AS (
                SELECT
                    t2.source_pp_no,
                    t2.inventory_code,
                    t1.voucher_no,
                    t1.machine_no,
                    t2.stage_desc,
                    t3.total_acc_qty_produced,
                    t1.status AS raw_status
                FROM mfg_wo_comp_vch t1
                LEFT JOIN mfg_mps_vch t2
                    ON  t1.voucher_no = t2.wo_voucher_no
                LEFT JOIN mfg_wo_vch t3
                    ON  t1.voucher_no = t3.voucher_no
                WHERE t2.inventory_code = %s
                  AND (
                      t2.stage_desc LIKE 'Turning%%'
                   OR t2.stage_desc LIKE 'Milling%%'
                   OR t2.stage_desc LIKE 'Turnmill%%'
                  )
            ),

            wt_with_bom AS (
                SELECT
                    r.*,
                    p.bom_code
                FROM wt_raw r
                LEFT JOIN public.mfg_pp_vch p
                    ON  p.pp_voucher_no = r.source_pp_no
                WHERE p.bom_code = %s OR p.bom_code IS NULL
            ),

            wt_ranked AS (
                SELECT *,
                    ROW_NUMBER() OVER (
                        PARTITION BY voucher_no
                        ORDER BY
                            total_acc_qty_produced DESC,
                            CASE WHEN raw_status = 'H' THEN 1 ELSE 0 END DESC
                    ) AS rn
                FROM wt_with_bom
            ),

            workorder_tracker AS (
                SELECT source_pp_no, inventory_code, voucher_no, machine_no, stage_desc, bom_code
                FROM wt_ranked
                WHERE rn = 1
            ),

            workorder_tracker_slim AS (
                SELECT
                    inventory_code,
                    bom_code,
                    stage_desc,
                    MIN(machine_no) AS machine_no
                FROM workorder_tracker
                GROUP BY inventory_code, bom_code, stage_desc
            ),

            bom_machining AS (
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
            )

            SELECT
                b.inventory_code,
                b.bom_code,
                b.stage_no,
                b.stage_desc,
                b.op_no,
                w.machine_no
            FROM bom_machining b
            LEFT JOIN workorder_tracker_slim w
                ON  w.inventory_code = b.inventory_code
                AND w.bom_code       = b.bom_code
                AND w.stage_desc     = b.stage_desc
            ORDER BY
                b.stage_no  ASC,
                b.op_no     ASC NULLS LAST
            """,
            (source, bom, source, bom), fetchall=True
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


# ── API: stubs ─────────────────────────────────────────────────────────────

@app.get("/api/process-sheets")
def api_process_sheets():
    return jsonify([])


@app.get("/api/machine-schedule")
def api_machine_schedule():
    return jsonify([])


@app.get("/api/summary")
def api_summary():
    return jsonify({})


@app.get("/api/operations")
def api_operations():
    return jsonify([])


if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", 5000))
    debug = os.getenv("FLASK_ENV") == "development"
    app.run(host="0.0.0.0", port=port, debug=debug)
