import os
from flask import Flask, render_template, jsonify
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret")


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
    return render_template("planning_data.html", active="planning_data")


@app.get("/operations")
def operations():
    return render_template("operations.html", active="operations")


@app.get("/system")
def system():
    return render_template("system.html", active="system")


# ── API ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    try:
        from db import get_conn, release_conn
        conn = get_conn()
        release_conn(conn)
        return jsonify({"status": "ok", "db": "connected"})
    except Exception as e:
        return jsonify({"status": "ok", "db": "disconnected", "error": str(e)})


@app.get("/api/process-sheets")
def api_process_sheets():
    return jsonify([])


@app.get("/api/machine-schedule")
def api_machine_schedule():
    return jsonify([])


@app.get("/api/summary")
def api_summary():
    return jsonify({})


@app.get("/api/planning-data")
def api_planning_data():
    return jsonify([])


@app.get("/api/operations")
def api_operations():
    return jsonify([])


@app.get("/api/system")
def api_system():
    return jsonify([])


if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", 5000))
    debug = os.getenv("FLASK_ENV") == "development"
    app.run(host="0.0.0.0", port=port, debug=debug)
