import os
from flask import Flask, render_template, jsonify, request, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret")


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


# ── API: parts ─────────────────────────────────────────────────────────────

@app.get("/api/parts")
def api_parts():
    search = request.args.get("search", "").strip()
    try:
        if search:
            rows = db_query(
                """
                SELECT p.id, p.part_number, p.description, COUNT(f.id) AS flow_count
                FROM parts p
                LEFT JOIN flows f ON f.part_id = p.id
                WHERE p.part_number ILIKE %s OR p.description ILIKE %s
                GROUP BY p.id
                ORDER BY p.part_number
                """,
                (f"%{search}%", f"%{search}%"),
                fetchall=True,
            )
        else:
            rows = db_query(
                """
                SELECT p.id, p.part_number, p.description, COUNT(f.id) AS flow_count
                FROM parts p
                LEFT JOIN flows f ON f.part_id = p.id
                GROUP BY p.id
                ORDER BY p.part_number
                """,
                fetchall=True,
            )
        return jsonify([
            {"id": r[0], "part_number": r[1], "description": r[2] or "", "flow_count": r[3]}
            for r in (rows or [])
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/parts")
def api_create_part():
    data = request.get_json()
    part_number = (data.get("part_number") or "").strip()
    description = (data.get("description") or "").strip()
    if not part_number:
        return jsonify({"error": "part_number is required"}), 400
    try:
        row = db_query(
            "INSERT INTO parts (part_number, description) VALUES (%s, %s) RETURNING id, part_number, description",
            (part_number, description),
            fetchone=True,
            commit=True,
        )
        return jsonify({"id": row[0], "part_number": row[1], "description": row[2] or "", "flow_count": 0}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.put("/api/parts/<int:part_id>")
def api_update_part(part_id):
    data = request.get_json()
    part_number = (data.get("part_number") or "").strip()
    description = (data.get("description") or "").strip()
    if not part_number:
        return jsonify({"error": "part_number is required"}), 400
    try:
        db_query(
            "UPDATE parts SET part_number = %s, description = %s WHERE id = %s",
            (part_number, description, part_id),
            commit=True,
        )
        return jsonify({"id": part_id, "part_number": part_number, "description": description})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.delete("/api/parts/<int:part_id>")
def api_delete_part(part_id):
    try:
        db_query("DELETE FROM parts WHERE id = %s", (part_id,), commit=True)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: flows ─────────────────────────────────────────────────────────────

@app.get("/api/parts/<int:part_id>/flows")
def api_part_flows(part_id):
    try:
        rows = db_query(
            "SELECT id, name, sort_order FROM flows WHERE part_id = %s ORDER BY sort_order, id",
            (part_id,),
            fetchall=True,
        )
        return jsonify([
            {"id": r[0], "name": r[1], "sort_order": r[2]}
            for r in (rows or [])
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/parts/<int:part_id>/flows")
def api_create_flow(part_id):
    data = request.get_json()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    try:
        row = db_query(
            "INSERT INTO flows (part_id, name) VALUES (%s, %s) RETURNING id, name, sort_order",
            (part_id, name),
            fetchone=True,
            commit=True,
        )
        return jsonify({"id": row[0], "name": row[1], "sort_order": row[2]}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.delete("/api/flows/<int:flow_id>")
def api_delete_flow(flow_id):
    try:
        db_query("DELETE FROM flows WHERE id = %s", (flow_id,), commit=True)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: other stubs ───────────────────────────────────────────────────────

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
