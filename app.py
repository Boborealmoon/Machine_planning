import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import quote

from flask import Flask, render_template, jsonify, request, redirect, session, url_for
from dotenv import load_dotenv
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

log = logging.getLogger(__name__)

_APP_ROOT = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_APP_ROOT, ".env"), encoding="utf-8-sig")

app = Flask(__name__)
_dev_mode = os.getenv("FLASK_ENV", "").strip().lower() == "development"
app.config["TEMPLATES_AUTO_RELOAD"] = _dev_mode
app.jinja_env.auto_reload = _dev_mode

# ── Planning blueprints ────────────────────────────────────────────────────
from planning.process_sheets import process_sheets_bp
from planning.summary import trial_summary_bp
from planning.flows import flows_bp, trial_prefixed_flows_bp
from planning.gantt_route import trial_gantt_bp
from planning.materials_route import materials_route_bp
from planning.material_bar_calc_route import material_bar_calc_bp
from planning.planner_routes import trial_bp
from planning.program_tool_list_route import program_tool_list_bp
from planning.new_orders_route import new_orders_bp
from planning.sales_orders_route import sales_orders_bp
from planning.pending_pp_route import pending_pp_bp
from planning.sales_report_route import sales_report_bp
from planning.job_ratio_route import job_ratio_bp
from planning.material_inspection_route import material_inspection_bp
from planning.qc_quality_queue_route import qc_quality_queue_bp
from planning.kobelco_mps_archive_route import kobelco_mps_archive_bp
from planning.machine_lane_calc_route import machine_lane_calc_bp
from planning.pr_status_enquiry_route import pr_status_enquiry_bp
from planning.program_tool_tracker_route import program_tool_tracker_bp
from planning.repeat_orders_route import repeat_orders_bp
from planning.auk_oee_route import auk_oee_bp
from planning.daily_output_route import (
    api_daily_output_get,
    api_daily_output_patch,
    api_daily_output_refresh_plan,
    api_daily_output_snapshot_detail,
    api_daily_output_unlock,
    daily_output_page,
)
from planning.bom_variation_route import bom_variation_bp
from planning.assembly_bom_route import assembly_bom_bp
from planning.assembly_parts_route import assembly_parts_bp
from planning.finishing_queue_route import (
    FINISHING_QUEUE_PATH,
    LEGACY_FINISHING_QUEUE_PATHS,
    finishing_queue_bp,
)
from planning.driver_view_route import (
    DRIVER_VIEW_PATH,
    _LEGACY_DRIVER_VIEW_PATH,
    driver_view_bp,
)
from planning.capacity_monthly_route import capacity_monthly_bp
from planning.preferred_machines_route import preferred_machines_bp
from planning.floor_plan_route import floor_plan_bp
from planning.queue_exit_history_route import queue_exit_history_bp
from planning.mpp_planner_route import mpp_planner_bp
from planning.inventory_enquiry_route import inventory_enquiry_bp
from planning.excel_local_route import excel_local_bp
from planning.frame_agreement_route import frame_agreement_bp
from planning.email_route import email_bp
from planning.mro_route import MRO_PATH, mro_bp
from planning.mro_auth import (
    is_mro_auth_public_path,
    mro_auth_bp,
    mro_user_authenticated,
)
from planning.accounts_route import ACCOUNTS_PATH, accounts_bp
from planning.notes_route import notes_bp
from planning.utils import pending_delivery_order, shipped_quantity_completed

app.register_blueprint(process_sheets_bp)
app.register_blueprint(trial_summary_bp)
app.register_blueprint(flows_bp)
app.register_blueprint(trial_prefixed_flows_bp)
app.register_blueprint(trial_gantt_bp)
app.register_blueprint(materials_route_bp)
app.register_blueprint(material_bar_calc_bp)
app.register_blueprint(trial_bp)
app.register_blueprint(program_tool_list_bp)
app.register_blueprint(new_orders_bp)
app.register_blueprint(sales_orders_bp)
app.register_blueprint(pending_pp_bp)
app.register_blueprint(sales_report_bp)
app.register_blueprint(job_ratio_bp)
app.register_blueprint(material_inspection_bp)
app.register_blueprint(qc_quality_queue_bp)
app.register_blueprint(kobelco_mps_archive_bp)
app.register_blueprint(machine_lane_calc_bp)
app.register_blueprint(pr_status_enquiry_bp)
app.register_blueprint(program_tool_tracker_bp)
app.register_blueprint(repeat_orders_bp)
app.register_blueprint(auk_oee_bp)
app.register_blueprint(bom_variation_bp)
app.register_blueprint(assembly_bom_bp)
app.register_blueprint(assembly_parts_bp)
app.register_blueprint(finishing_queue_bp)
app.register_blueprint(driver_view_bp)

for _legacy_fq_path in LEGACY_FINISHING_QUEUE_PATHS:
    if _legacy_fq_path.lower() == FINISHING_QUEUE_PATH.lower():
        continue

    def _finishing_queue_legacy_redirect(_target=FINISHING_QUEUE_PATH):
        return redirect(_target)

    app.add_url_rule(
        _legacy_fq_path,
        f"finishing_queue_legacy_{_legacy_fq_path.strip('/').replace('/', '_')}",
        _finishing_queue_legacy_redirect,
    )
app.register_blueprint(capacity_monthly_bp)
app.register_blueprint(preferred_machines_bp)
app.register_blueprint(floor_plan_bp)
app.register_blueprint(queue_exit_history_bp)
app.register_blueprint(mpp_planner_bp)
app.register_blueprint(inventory_enquiry_bp)
app.register_blueprint(excel_local_bp)
app.register_blueprint(frame_agreement_bp)
app.register_blueprint(email_bp)
app.register_blueprint(mro_bp)
app.register_blueprint(mro_auth_bp)
app.register_blueprint(accounts_bp)
app.register_blueprint(notes_bp)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret")


# Stock-in pill save — registered on app (not flows catch-all GET /process-sheets/<path:ps_id>).
@app.post("/api/process-sheets/stock-in-flag")
@app.post("/api/trial/process-sheets/stock-in-flag")
def api_process_sheet_stock_in_flag():
    from planning.process_sheets import material_in_post_response

    return material_in_post_response()


@app.post("/api/operations/tooling-flag")
@app.post("/api/trial/operations/tooling-flag")
def api_operation_tooling_flag():
    from planning.process_sheets import tooling_post_response

    return tooling_post_response()


# Delivery OK / exception flags — registered on app (same reason as stock-in-flag).
@app.post("/api/process-sheets/delivery-flags")
@app.post("/api/trial/delivery-schedule/flags")
def api_delivery_schedule_flags():
    from planning.delivery_planner_service import delivery_flags_post_response

    return delivery_flags_post_response()


@app.post("/api/process-sheets/delivery-flags/bulk")
@app.post("/api/trial/delivery-schedule/flags/bulk")
def api_delivery_schedule_flags_bulk():
    from planning.delivery_planner_service import delivery_flags_bulk_post_response

    return delivery_flags_bulk_post_response()

# Shop-floor machinist board (public — no passcode). Override via MACHINIST_BOARD_PATH in .env.
_DEFAULT_MACHINIST_BOARD_PATH = "/machine-queue"
_MACHINIST_BOARD_DECOY_PATHS = frozenset({
    "/s/x7k9m2p4w1n5q8r3",
    "/machinist-board",
    "/machinist",
    "/machine-queue-board",
    "/queue-board",
    "/shop-floor",
    "/shop-floor-board",
    "/floor-board",
})


def _machinist_board_path() -> str:
    raw = (os.getenv("MACHINIST_BOARD_PATH") or _DEFAULT_MACHINIST_BOARD_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


MACHINIST_BOARD_PATH = _machinist_board_path()

# Planner lives on a non-root path so shop-floor users hitting "/" do not reach it.
_DEFAULT_PLANNER_PATH = "/planner"
_PLANNER_LEGACY_PATHS = frozenset({"/scheduler"})


def _planner_path() -> str:
    raw = (os.getenv("PLANNER_PATH") or _DEFAULT_PLANNER_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    if raw == "/":
        raise RuntimeError("PLANNER_PATH cannot be '/' — root is reserved for the access gate.")
    return raw


PLANNER_PATH = _planner_path()

PLANNER_SESSION_KEY = "planner_access_ok"
LOCK_PLANNER_PATH = "/lock-planner"


def _planner_passcode() -> str:
    return (os.getenv("PLANNER_PASSCODE") or "").strip()


def _planner_gate_enabled() -> bool:
    return bool(_planner_passcode())


def _planner_authenticated() -> bool:
    return session.get(PLANNER_SESSION_KEY) is True


def _normalize_gate_path(path: str) -> str:
    return ((path or "/").lower().rstrip("/")) or "/"


_FINISHING_QUEUE_PUBLIC_PATHS = frozenset(
    {FINISHING_QUEUE_PATH.lower(), *(p.lower() for p in LEGACY_FINISHING_QUEUE_PATHS)}
)
_DRIVER_VIEW_PUBLIC_PATHS = frozenset(
    {DRIVER_VIEW_PATH.lower(), _LEGACY_DRIVER_VIEW_PATH.lower()}
)
_MRO_PUBLIC_PATHS = frozenset({MRO_PATH.lower(), "/mro"})
_ACCOUNTS_PUBLIC_PATHS = frozenset({ACCOUNTS_PATH.lower(), "/accounts"})


def _is_gate_public_path(path: str) -> bool:
    normalized = _normalize_gate_path(path)
    if normalized in (
        "/",
        MACHINIST_BOARD_PATH.lower(),
        LOCK_PLANNER_PATH.lower(),
        REPORTS_GATE_PATH.lower(),
        FINANCE_GATE_PATH.lower(),
        ADMIN_GATE_PATH.lower(),
        "/favicon.ico",
    ):
        return True
    if is_mro_auth_public_path(path):
        return True
    if normalized in _FINISHING_QUEUE_PUBLIC_PATHS:
        return True
    if normalized in _DRIVER_VIEW_PUBLIC_PATHS:
        return True
    if normalized in _MRO_PUBLIC_PATHS:
        return True
    if normalized in _ACCOUNTS_PUBLIC_PATHS:
        return True
    # Admin Hub uses ADMIN_PASSCODE when set; otherwise stays under the planner gate.
    if _admin_gate_enabled() and normalized in _ADMIN_PUBLIC_PATHS:
        return True
    return normalized.startswith("/static/") or normalized.startswith("/api/")


def _safe_next_path(raw: str) -> str:
    target = (raw or "").strip()
    if not target.startswith("/") or target.startswith("//"):
        return PLANNER_PATH
    return target


# ── Reports / Analytics passcode gate ───────────────────────────────────────
# Separate blanket lock in front of every REPORTS / ANALYTICS tab. Enabled only
# when REPORTS_PASSCODE is set in .env. Independent of the planner gate.
# Auth is a short-lived signed token per visit — refreshing the page requires
# the passcode again (no persistent session).
REPORTS_GATE_PATH = "/reports-gate"
REPORTS_TOKEN_SALT = "reports-analytics-gate"
REPORTS_TOKEN_MAX_AGE = 8 * 3600

# Page URLs behind the reports lock (must match the REPORTS / ANALYTICS dropdown).
_REPORTS_PAGE_PREFIXES = (
    "/sales-report",
    "/job-ratio",
    "/production-capacity",
    "/repeat-orders",
    "/planning-data/repeat-orders",
)
# API URLs that feed those pages — locked too so the data can't be fetched directly.
_REPORTS_API_PREFIXES = (
    "/api/sales-report",
    "/api/job-ratio",
    "/api/production-capacity",
    "/api/planning-data/repeat-orders",
)


def _reports_passcode() -> str:
    return (os.getenv("REPORTS_PASSCODE") or "").strip()


def _reports_gate_enabled() -> bool:
    return bool(_reports_passcode())


def _reports_token_serializer() -> URLSafeTimedSerializer:
    secret = _reports_passcode() or app.secret_key
    return URLSafeTimedSerializer(secret, salt=REPORTS_TOKEN_SALT)


def _issue_reports_token() -> str:
    return _reports_token_serializer().dumps({"v": 1})


def _reports_token_valid(token: str) -> bool:
    if not token:
        return False
    try:
        payload = _reports_token_serializer().loads(token, max_age=REPORTS_TOKEN_MAX_AGE)
        return isinstance(payload, dict) and payload.get("v") == 1
    except (BadSignature, SignatureExpired):
        return False


def _reports_request_token() -> str:
    return (request.args.get("rt") or request.headers.get("X-Reports-Token") or "").strip()


def _path_has_prefix(path: str, prefixes) -> bool:
    normalized = _normalize_gate_path(path)
    normalized_prefixes = tuple(_normalize_gate_path(p) for p in prefixes)
    return any(normalized == p or normalized.startswith(p + "/") for p in normalized_prefixes)


def _is_reports_page_path(path: str) -> bool:
    return _path_has_prefix(path, _REPORTS_PAGE_PREFIXES)


def _is_reports_api_path(path: str) -> bool:
    return _path_has_prefix(path, _REPORTS_API_PREFIXES)


FINANCE_GATE_PATH = "/finance-gate"
FINANCE_TOKEN_SALT = "finance-gate"
FINANCE_TOKEN_MAX_AGE = 8 * 3600
_FINANCE_PAGE_PREFIXES = (ACCOUNTS_PATH,)
_FINANCE_API_PREFIXES = ("/api/accounts",)

MRO_LOGIN_PATH = "/mro-login"
_MRO_PAGE_PREFIXES = (MRO_PATH,)
_MRO_API_PREFIXES = ("/api/mro",)

ADMIN_GATE_PATH = "/admin-gate"
ADMIN_TOKEN_SALT = "admin-hub-gate"
ADMIN_TOKEN_MAX_AGE = 8 * 3600
ADMIN_PATH = "/admin"
_ADMIN_PUBLIC_PATHS = frozenset({ADMIN_PATH.lower(), "/notes"})
_ADMIN_PAGE_PREFIXES = (ADMIN_PATH, "/notes")
_ADMIN_API_PREFIXES = ("/api/notes", "/api/admin/mro-users")


def _finance_passcode() -> str:
    return (os.getenv("FINANCE_PASSCODE") or "").strip()


def _finance_gate_enabled() -> bool:
    return bool(_finance_passcode())


def _admin_passcode() -> str:
    return (os.getenv("ADMIN_PASSCODE") or "").strip()


def _admin_gate_enabled() -> bool:
    return bool(_admin_passcode())


def _finance_token_serializer() -> URLSafeTimedSerializer:
    secret = _finance_passcode() or app.secret_key
    return URLSafeTimedSerializer(secret, salt=FINANCE_TOKEN_SALT)


def _issue_finance_token() -> str:
    return _finance_token_serializer().dumps({"v": 1})


def _admin_token_serializer() -> URLSafeTimedSerializer:
    secret = _admin_passcode() or app.secret_key
    return URLSafeTimedSerializer(secret, salt=ADMIN_TOKEN_SALT)


def _issue_admin_token() -> str:
    return _admin_token_serializer().dumps({"v": 1})


def _finance_token_valid(token: str) -> bool:
    if not token:
        return False
    try:
        payload = _finance_token_serializer().loads(token, max_age=FINANCE_TOKEN_MAX_AGE)
        return isinstance(payload, dict) and payload.get("v") == 1
    except (BadSignature, SignatureExpired):
        return False


def _admin_token_valid(token: str) -> bool:
    if not token:
        return False
    try:
        payload = _admin_token_serializer().loads(token, max_age=ADMIN_TOKEN_MAX_AGE)
        return isinstance(payload, dict) and payload.get("v") == 1
    except (BadSignature, SignatureExpired):
        return False


def _finance_request_token() -> str:
    return (request.args.get("ft") or request.headers.get("X-Finance-Token") or "").strip()


def _admin_request_token() -> str:
    return (request.args.get("at") or request.headers.get("X-Admin-Token") or "").strip()


def _is_finance_page_path(path: str) -> bool:
    return _path_has_prefix(path, _FINANCE_PAGE_PREFIXES)


def _is_finance_api_path(path: str) -> bool:
    return _path_has_prefix(path, _FINANCE_API_PREFIXES)


def _is_mro_page_path(path: str) -> bool:
    return _path_has_prefix(path, _MRO_PAGE_PREFIXES)


def _is_mro_api_path(path: str) -> bool:
    return _path_has_prefix(path, _MRO_API_PREFIXES)


def _is_admin_page_path(path: str) -> bool:
    return _path_has_prefix(path, _ADMIN_PAGE_PREFIXES)


def _is_admin_api_path(path: str) -> bool:
    return _path_has_prefix(path, _ADMIN_API_PREFIXES)


@app.before_request
def _require_planner_passcode():
    if not _planner_gate_enabled():
        return None
    path = request.path or "/"
    if _is_gate_public_path(path):
        return None
    # Reports / Analytics use REPORTS_PASSCODE only — not the planner passcode.
    if _is_reports_page_path(path) or _is_reports_api_path(path):
        return None
    # Finance pages use FINANCE_PASSCODE only — not the planner passcode.
    if _is_finance_page_path(path) or _is_finance_api_path(path):
        return None
    # MRO pages use per-user MRO login — not the planner passcode.
    if _is_mro_page_path(path) or _is_mro_api_path(path):
        return None
    if is_mro_auth_public_path(path):
        return None
    # Admin Hub uses ADMIN_PASSCODE only when that gate is enabled.
    if _admin_gate_enabled() and (_is_admin_page_path(path) or _is_admin_api_path(path)):
        return None
    if _planner_authenticated():
        return None
    return redirect(url_for("site_root_gate", next=path))


def _safe_reports_next(raw: str) -> str:
    target = (raw or "").strip()
    if _is_reports_page_path(target):
        return target
    return "/sales-report"


def _render_reports_gate(error=None, next_path="/sales-report", status=200, disabled=False):
    html = render_template(
        "site_gate.html",
        error=error,
        next_path=next_path,
        gate_action=url_for("reports_gate"),
        gate_disabled=disabled,
        gate_title="Reports locked",
        gate_message="Enter the passcode to open Reports / Analytics.",
        gate_env_var="REPORTS_PASSCODE",
    )
    return (html, status) if status != 200 else html


@app.before_request
def _require_reports_passcode():
    if not _reports_gate_enabled():
        return None
    path = request.path or "/"
    if not _is_reports_page_path(path) and not _is_reports_api_path(path):
        return None
    if _reports_token_valid(_reports_request_token()):
        return None
    if _is_reports_api_path(path):
        return jsonify({"error": "Reports access locked."}), 401
    return redirect(url_for("reports_gate", next=path))


@app.route(REPORTS_GATE_PATH, methods=["GET", "POST"], endpoint="reports_gate")
def reports_gate():
    next_path = _safe_reports_next(request.values.get("next"))

    if not _reports_gate_enabled():
        return _render_reports_gate(next_path=next_path, disabled=True)

    if request.method == "POST":
        entered = (request.form.get("passcode") or "").strip()
        passcode = _reports_passcode()
        if passcode and secrets.compare_digest(entered, passcode):
            token = _issue_reports_token()
            next_path = _safe_reports_next(request.form.get("next"))
            return redirect(f"{next_path}?rt={quote(token, safe='')}")
        return _render_reports_gate(error="Invalid passcode.", next_path=next_path, status=401)

    return _render_reports_gate(next_path=next_path)


def _safe_finance_next(raw: str) -> str:
    target = (raw or "").strip()
    if _is_finance_page_path(target):
        return target
    return ACCOUNTS_PATH


def _render_finance_gate(error=None, next_path=ACCOUNTS_PATH, status=200, disabled=False):
    html = render_template(
        "site_gate.html",
        error=error,
        next_path=next_path,
        gate_action=url_for("finance_gate"),
        gate_disabled=disabled,
        gate_title="Finance locked",
        gate_message="Enter the passcode to open Finance pages.",
        gate_env_var="FINANCE_PASSCODE",
    )
    return (html, status) if status != 200 else html


@app.before_request
def _require_finance_passcode():
    if not _finance_gate_enabled():
        return None
    path = request.path or "/"
    if not _is_finance_page_path(path) and not _is_finance_api_path(path):
        return None
    if _finance_token_valid(_finance_request_token()):
        return None
    if _is_finance_api_path(path):
        return jsonify({"error": "Finance access locked."}), 401
    return redirect(url_for("finance_gate", next=path))


@app.route(FINANCE_GATE_PATH, methods=["GET", "POST"], endpoint="finance_gate")
def finance_gate():
    next_path = _safe_finance_next(request.values.get("next"))

    if not _finance_gate_enabled():
        return _render_finance_gate(next_path=next_path, disabled=True)

    if request.method == "POST":
        entered = (request.form.get("passcode") or "").strip()
        passcode = _finance_passcode()
        if passcode and secrets.compare_digest(entered, passcode):
            token = _issue_finance_token()
            next_path = _safe_finance_next(request.form.get("next"))
            return redirect(f"{next_path}?ft={quote(token, safe='')}")
        return _render_finance_gate(error="Invalid passcode.", next_path=next_path, status=401)

    return _render_finance_gate(next_path=next_path)


def _safe_mro_next(raw: str) -> str:
    target = (raw or "").strip()
    if _is_mro_page_path(target):
        return target
    return MRO_PATH


@app.before_request
def _require_mro_login():
    path = request.path or "/"
    if is_mro_auth_public_path(path):
        return None
    if not _is_mro_page_path(path) and not _is_mro_api_path(path):
        return None
    if mro_user_authenticated():
        return None
    if _is_mro_api_path(path):
        return jsonify({"error": "MRO login required.", "login": MRO_LOGIN_PATH}), 401
    return redirect(url_for("mro_auth.mro_login", next=path))


def _safe_admin_next(raw: str) -> str:
    target = (raw or "").strip()
    if _is_admin_page_path(target):
        return target
    return ADMIN_PATH


def _render_admin_gate(error=None, next_path=ADMIN_PATH, status=200, disabled=False):
    html = render_template(
        "site_gate.html",
        error=error,
        next_path=next_path,
        gate_action=url_for("admin_gate"),
        gate_disabled=disabled,
        gate_title="Admin locked",
        gate_message="Enter the passcode to open the Admin Hub.",
        gate_env_var="ADMIN_PASSCODE",
    )
    return (html, status) if status != 200 else html


@app.before_request
def _require_admin_passcode():
    path = request.path or "/"
    if not _is_admin_page_path(path) and not _is_admin_api_path(path):
        return None
    if _admin_gate_enabled():
        if _admin_token_valid(_admin_request_token()):
            return None
        if _is_admin_api_path(path):
            return jsonify({"error": "Admin access locked."}), 401
        return redirect(url_for("admin_gate", next=path))
    # Gate off: /api/notes is exempt from the planner page gate, so require a
    # planner session here whenever PLANNER_PASSCODE is set.
    if (
        _is_admin_api_path(path)
        and _planner_gate_enabled()
        and not _planner_authenticated()
    ):
        return jsonify({"error": "Planner access locked."}), 401
    return None


@app.route(ADMIN_GATE_PATH, methods=["GET", "POST"], endpoint="admin_gate")
def admin_gate():
    next_path = _safe_admin_next(request.values.get("next"))

    if not _admin_gate_enabled():
        return _render_admin_gate(next_path=next_path, disabled=True)

    if request.method == "POST":
        entered = (request.form.get("passcode") or "").strip()
        passcode = _admin_passcode()
        if passcode and secrets.compare_digest(entered, passcode):
            token = _issue_admin_token()
            next_path = _safe_admin_next(request.form.get("next"))
            return redirect(f"{next_path}?at={quote(token, safe='')}")
        return _render_admin_gate(error="Invalid passcode.", next_path=next_path, status=401)

    return _render_admin_gate(next_path=next_path)


def _scheduler_asset_version() -> str:
    """Cache-bust token for planner JS — changes when scheduler scripts change."""
    override = (os.getenv("SCHEDULER_ASSET_VERSION") or "").strip()
    if override:
        return override
    root = os.path.dirname(os.path.abspath(__file__))
    watch = (
        "static/js/scheduler/data.js",
        "static/js/scheduler/catalog_op_rules.js",
        "static/js/scheduler/api.js",
        "static/js/scheduler/dnd.js",
        "static/js/scheduler/render.js",
        "static/js/scheduler/modals.js",
        "static/js/scheduler/utils.js",
        "static/js/scheduler/bom.js",
    )
    try:
        mt = max(
            os.path.getmtime(os.path.join(root, rel))
            for rel in watch
            if os.path.isfile(os.path.join(root, rel))
        )
        return f"partial-lane-{int(mt)}"
    except (OSError, ValueError):
        return "partial-lane-dev"


SCHEDULER_ASSET_VERSION = _scheduler_asset_version()


@app.context_processor
def _inject_board_paths():
    return {
        "machinist_board_path": MACHINIST_BOARD_PATH,
        "machinist_board_canonical_path": MACHINIST_BOARD_PATH,
        "finishing_queue_path": FINISHING_QUEUE_PATH,
        "driver_view_path": DRIVER_VIEW_PATH,
        "planner_path": PLANNER_PATH,
        "planner_gate_enabled": _planner_gate_enabled(),
        "planner_authenticated": _planner_authenticated(),
        "reports_gate_enabled": _reports_gate_enabled(),
        "finance_gate_enabled": _finance_gate_enabled(),
        "admin_gate_enabled": _admin_gate_enabled(),
        "scheduler_asset_version": SCHEDULER_ASSET_VERSION,
    }


@app.after_request
def _planner_cache_headers(response):
    """Prevent Cloudflare tunnel / browser from serving stale planner HTML or JS."""
    path = (request.path or "").lower()
    if path in (MACHINIST_BOARD_PATH.lower(), FINISHING_QUEUE_PATH.lower(), DRIVER_VIEW_PATH.lower()):
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    if path == "/":
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    if path in (PLANNER_PATH.lower(), MACHINIST_BOARD_PATH.lower(), FINISHING_QUEUE_PATH.lower(), DRIVER_VIEW_PATH.lower()):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["CDN-Cache-Control"] = "no-store"
        response.headers["X-Scheduler-Build"] = SCHEDULER_ASSET_VERSION
    elif path.startswith("/static/js/scheduler/") or path.startswith("/static/css/"):
        if request.args.get("v"):
            response.headers["Cache-Control"] = "public, max-age=300, must-revalidate"
        else:
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


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

@app.route("/", methods=["GET", "POST"], endpoint="site_root_gate")
def site_root_gate():
    next_path = _safe_next_path(request.values.get("next") or PLANNER_PATH)
    gate_action = url_for("site_root_gate")

    # Report tabs use REPORTS_PASSCODE — never the planner gate at "/".
    if _is_reports_page_path(next_path):
        return redirect(url_for("reports_gate", next=next_path))
    if _is_finance_page_path(next_path):
        return redirect(url_for("finance_gate", next=next_path))
    if _is_mro_page_path(next_path):
        return redirect(url_for("mro_auth.mro_login", next=next_path))
    if _admin_gate_enabled() and _is_admin_page_path(next_path):
        return redirect(url_for("admin_gate", next=next_path))

    if not _planner_gate_enabled():
        return render_template(
            "site_gate.html",
            error=None,
            next_path=next_path,
            gate_action=gate_action,
            gate_disabled=True,
        )

    if request.method == "POST":
        entered = (request.form.get("passcode") or "").strip()
        passcode = _planner_passcode()
        if passcode and secrets.compare_digest(entered, passcode):
            session[PLANNER_SESSION_KEY] = True
            session.permanent = True
            return redirect(_safe_next_path(request.form.get("next") or PLANNER_PATH))
        return (
            render_template(
                "site_gate.html",
                error="Invalid passcode.",
                next_path=next_path,
                gate_action=url_for("site_root_gate"),
            ),
            401,
        )

    if _planner_authenticated():
        return redirect(url_for("planner"))

    return render_template(
        "site_gate.html",
        error=None,
        next_path=next_path,
        gate_action=url_for("site_root_gate"),
    )


@app.post(LOCK_PLANNER_PATH, endpoint="lock_planner")
def lock_planner():
    session.pop(PLANNER_SESSION_KEY, None)
    return redirect(url_for("site_root_gate"))


@app.get(PLANNER_PATH, endpoint="planner")
def planner():
    if _planner_gate_enabled() and not _planner_authenticated():
        return redirect(url_for("site_root_gate", next=PLANNER_PATH))
    return render_template(
        "scheduler.html",
        active="scheduler",
        scheduler_asset_version=SCHEDULER_ASSET_VERSION,
    )


def _register_planner_legacy_decoy_routes():
    canonical = PLANNER_PATH.lower()

    def _register_one(legacy_path: str):
        slug = legacy_path.strip("/").replace("-", "_") or "root"

        @app.get(legacy_path, endpoint=f"planner_legacy_{slug}")
        def _planner_legacy_decoy():
            return "", 404

    for legacy_path in _PLANNER_LEGACY_PATHS:
        if legacy_path.lower() == canonical:
            continue
        _register_one(legacy_path)


_register_planner_legacy_decoy_routes()


@app.get(MACHINIST_BOARD_PATH)
def machinist_board():
    return render_template(
        "machinist_board.html",
        active="machinist_board",
        scheduler_asset_version=SCHEDULER_ASSET_VERSION,
        machinist_board_canonical_path=MACHINIST_BOARD_PATH,
    )


def _register_machinist_decoy_routes():
    canonical = MACHINIST_BOARD_PATH.lower()

    def _register_one(decoy_path: str):
        slug = decoy_path.strip("/").replace("-", "_") or "root"

        @app.get(decoy_path, endpoint=f"machinist_decoy_{slug}")
        def _machinist_board_decoy():
            return "", 404

    for decoy_path in _MACHINIST_BOARD_DECOY_PATHS:
        if decoy_path.lower() == canonical:
            continue
        _register_one(decoy_path)


_register_machinist_decoy_routes()


@app.get("/delivery")
def delivery():
    return render_template("delivery.html", active="delivery")


@app.get("/queue-delays")
def queue_delays_redirect():
    return redirect("/delivery?view=queue")


@app.get("/delivery-schedule")
def delivery_schedule_redirect():
    return redirect("/delivery")


@app.get("/daily-output")
def daily_output_view():
    return daily_output_page()


@app.get("/api/daily-output")
def api_get_daily_output():
    return api_daily_output_get()


@app.route("/api/daily-output", methods=["PATCH"])
def api_patch_daily_output():
    return api_daily_output_patch()


@app.post("/api/daily-output/refresh-plan")
def api_post_daily_output_refresh_plan():
    return api_daily_output_refresh_plan()


@app.post("/api/daily-output/unlock")
def api_post_daily_output_unlock():
    return api_daily_output_unlock()


@app.get("/api/daily-output/snapshots/<int:snapshot_id>")
def api_get_daily_output_snapshot(snapshot_id: int):
    return api_daily_output_snapshot_detail(snapshot_id)


@app.get("/actual-production")
def actual_production():
    return render_template("actual_production.html", active="actual_production")


@app.get("/process-sheets")
def process_sheets():
    return render_template("process_sheets.html", active="process_sheets")


@app.get("/temp-process-sheets")
def temp_process_sheets_page():
    return render_template("process_sheets.html", active="process_sheets")


@app.get("/machine-schedule")
def machine_schedule():
    # View-only Gantt hidden from nav — no background compute; redirect to Planner.
    return redirect(url_for("planner"))


@app.get("/summary")
def summary_redirect():
    return redirect(url_for("planner"))


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
    return render_template("planning_data/materials.html", active="materials")


@app.get("/planning-data/cycle-times")
def cycle_times_page():
    return render_template("planning_data/cycle_times.html", active="planning_data")


@app.get("/operations")
def operations():
    return redirect(url_for("planner"))


# /system — email settings UI (planning.email_route)

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
_PP_VOUCHERS_BOARD_ERP_CACHE: dict[str, dict] = {}
_PP_VOUCHERS_WITH_OPS_CACHE_LOCK = threading.Lock()
# In-process catalog payload — avoids re-querying Supabase on every planner load.
_PP_VOUCHERS_WITH_OPS_TTL_SECS = int(os.getenv("PP_VOUCHERS_WITH_OPS_TTL_SECS", "300"))
_PP_VOUCHERS_STALE_SECS = int(os.getenv("PP_VOUCHERS_STALE_SECS", "86400"))
_PP_VOUCHERS_DISK_CACHE_DIR = Path(
    os.getenv(
        "PP_VOUCHERS_DISK_CACHE_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "pp_vouchers_with_ops"),
    )
)
_PP_VOUCHERS_BUILD_LOCK = threading.Lock()
_PP_VOUCHERS_BG_REFRESH: set[str] = set()
_PP_VOUCHERS_AUTO_SYNC_ON_READ = os.getenv("PP_VOUCHERS_AUTO_SYNC_ON_READ", "").strip().lower() in {
    "1", "true", "yes", "on",
}
# pp_vouchers_cache is rebuilt from vw_pp_vouchers (already includes WO fields). Skip the
# read-time mfg_wo_status join unless you need live WO rows before the next cache rebuild.
_PP_VOUCHERS_READ_MERGE_WO = os.getenv("PP_VOUCHERS_READ_MERGE_WO", "").strip().lower() in {
    "1", "true", "yes", "on",
}

_BG_PP_SYNC_LOCK = threading.Lock()
_BG_PP_SYNC: dict = {
    "running": False,
    "post_sync_running": False,
    "started_at": None,
    "failed_at": None,
    "error": None,
    "results": None,
}
_BG_PP_SYNC_STALE_SECS = int(os.getenv("ERP_SYNC_STALE_SECS", "1800"))
_ERP_SYNC_WAIT_MAX_SECS = int(os.getenv("ERP_SYNC_WAIT_MAX_SECS", "25"))


def _pp_vouchers_cache_sql_parts():
    from planning.erp_wo_merge import (
        PP_VOUCHERS_CACHE_DIRECT_FROM,
        PP_VOUCHERS_CACHE_DIRECT_SELECT,
        PP_VOUCHERS_CACHE_WO_MERGE_FROM,
        PP_VOUCHERS_CACHE_WO_MERGE_SELECT,
    )

    if _PP_VOUCHERS_READ_MERGE_WO:
        return PP_VOUCHERS_CACHE_WO_MERGE_SELECT, PP_VOUCHERS_CACHE_WO_MERGE_FROM
    return PP_VOUCHERS_CACHE_DIRECT_SELECT, PP_VOUCHERS_CACHE_DIRECT_FROM


def _pp_vouchers_memory_cache_get(scope: str):
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        return dict(_PP_VOUCHERS_WITH_OPS_CACHE.get(scope) or {})


def _pp_vouchers_memory_cache_lookup(scope: str, *, allow_stale: bool):
    """Return cached with-ops payload when fresh, or stale when allowed."""
    now = time.monotonic()
    bucket = _pp_vouchers_memory_cache_get(scope)
    data = bucket.get("data")
    if data is None:
        return None
    if now < float(bucket.get("expires_at") or 0):
        return data
    if allow_stale and now < float(bucket.get("stale_expires_at") or 0):
        return data
    return None


def _store_pp_vouchers_with_ops_cache(scope: str, data: list) -> None:
    now = time.monotonic()
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        _PP_VOUCHERS_WITH_OPS_CACHE[scope] = {
            "data": data,
            "expires_at": now + _PP_VOUCHERS_WITH_OPS_TTL_SECS,
            "stale_expires_at": now + _PP_VOUCHERS_STALE_SECS,
        }
    _pp_vouchers_disk_cache_store(scope, data)


def _pp_vouchers_disk_cache_path(scope: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(scope or "open"))
    return _PP_VOUCHERS_DISK_CACHE_DIR / f"{safe}.json"


def _pp_vouchers_disk_cache_load(scope: str) -> list | None:
    path = _pp_vouchers_disk_cache_path(scope)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        data = payload.get("data")
        return list(data) if isinstance(data, list) else None
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def _pp_vouchers_disk_cache_store(scope: str, data: list) -> None:
    path = _pp_vouchers_disk_cache_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    body = json.dumps({"cached_at": time.time(), "data": data}, default=str)
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)


def _build_pp_vouchers_with_ops_cached(include_completed: bool, *, lite: bool = False) -> list:
    from planning.helpers import planner_db

    timeout_ms = "120000" if lite else "45000"
    with planner_db() as con:
        con.execute(f"SET LOCAL statement_timeout = '{timeout_ms}'")
        return _build_pp_vouchers_with_ops_data(include_completed, con, lite=lite)


def _refresh_pp_vouchers_with_ops_scope(scope: str, include_completed: bool) -> list | None:
    use_lite = os.getenv("PP_VOUCHERS_CATALOG_FULL", "").strip().lower() not in {
        "1", "true", "yes", "on",
    }
    with _PP_VOUCHERS_BUILD_LOCK:
        try:
            data = _build_pp_vouchers_with_ops_cached(include_completed, lite=use_lite)
        except Exception as exc:
            log.warning("pp-vouchers with-ops rebuild failed (%s): %s", scope, exc)
            return None
        _store_pp_vouchers_with_ops_cache(scope, data)
        return data


def rebuild_pp_vouchers_with_ops_catalog() -> dict:
    """Pre-build catalog JSON for both open/all scopes (run after ERP sync, not on page load)."""
    started = time.monotonic()
    summary: dict[str, object] = {}
    for include_completed in (False, True):
        scope = _pp_vouchers_cache_scope(include_completed)
        step_started = time.monotonic()
        data = _refresh_pp_vouchers_with_ops_scope(scope, include_completed)
        if data is None:
            disk_rows = len(_pp_vouchers_disk_cache_load(scope) or [])
            summary[scope] = {
                "error": "rebuild failed",
                "disk_fallback_rows": disk_rows,
            }
        else:
            summary[scope] = {
                "rows": len(data),
                "ms": int((time.monotonic() - step_started) * 1000),
            }
    summary["total_ms"] = int((time.monotonic() - started) * 1000)
    log.info("pp-vouchers catalog prebuilt: %s", summary)
    return summary


def load_pp_vouchers_with_ops_catalog_from_disk() -> bool:
    """Load pre-built catalog from disk into memory (server startup)."""
    loaded = False
    for scope in ("open", "all"):
        disk = _pp_vouchers_disk_cache_load(scope)
        if disk is None:
            continue
        _store_pp_vouchers_with_ops_cache(scope, disk)
        log.info("pp-vouchers disk cache loaded (%s, %d rows)", scope, len(disk))
        loaded = True
    return loaded


def _schedule_pp_vouchers_with_ops_refresh(scope: str, include_completed: bool) -> None:
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        if scope in _PP_VOUCHERS_BG_REFRESH:
            return
        _PP_VOUCHERS_BG_REFRESH.add(scope)

    def _worker():
        try:
            _refresh_pp_vouchers_with_ops_scope(scope, include_completed)
        finally:
            with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
                _PP_VOUCHERS_BG_REFRESH.discard(scope)

    threading.Thread(target=_worker, daemon=True, name=f"pp-vouchers-{scope}").start()


def warm_pp_vouchers_with_ops_cache() -> None:
    """Startup: load pre-built catalog from disk only (no Supabase build on page open)."""
    if load_pp_vouchers_with_ops_catalog_from_disk():
        return
    log.info(
        "pp-vouchers catalog not on disk yet — sidebar fills after ERP sync "
        "(scheduled task or Sync ERP)"
    )


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


def _fetch_pp_vouchers_cache_rows(include_completed: bool, con=None):
    from planning.helpers import planner_db, rows as _db_rows
    from planning.utils import SHIPPED_QTY_TOLERANCE

    select_sql, from_sql = _pp_vouchers_cache_sql_parts()

    # Completed = fully shipped on the SO line, not PP voucher status (H/History).
    shipped_complete = (
        "c.so_det_qty IS NOT NULL "
        f"AND COALESCE(c.qty_shipped, 0) >= c.so_det_qty - {SHIPPED_QTY_TOLERANCE}"
    )
    where = "" if include_completed else f" WHERE NOT ({shipped_complete})"
    order = " ORDER BY c.ps_id, c.pp_partial_no, c.stage_no"
    sql = f"SELECT {select_sql} {from_sql}{where}{order}"

    def _run(_con):
        return _db_rows(_con.execute(sql))

    if con is not None:
        return _run(con)
    with planner_db() as _con:
        return _run(_con)


def _build_pp_vouchers_with_ops_data(include_completed: bool, con, cache_rows=None, *, lite: bool = False) -> list:
    from planning.erp_wo_merge import merge_finishing_stages_into_voucher_entries

    rows = cache_rows if cache_rows is not None else _fetch_pp_vouchers_cache_rows(include_completed, con=con)
    payload = _pp_vouchers_with_ops_payload(rows)
    if lite:
        for entry in payload:
            _finalize_pp_voucher_entry(entry)
        return payload
    merge_finishing_stages_into_voucher_entries(payload, con)
    for entry in payload:
        _finalize_pp_voucher_entry(entry)
    data = _append_temp_ps_catalog_entries(
        _enrich_pp_vouchers_planner_data(
            payload,
            con=con,
        ),
        con,
        include_completed=include_completed,
    )
    if not include_completed:
        data = [
            entry
            for entry in data
            if not entry.get("shipped_completed") or entry.get("is_temp_ps")
        ]
    from planning.materials import enrich_items_material_inventory_codes

    enrich_items_material_inventory_codes(con, data)
    return data


def pp_vouchers_lane_catalog_entries(con, partial_keys, include_completed=True):
    """With-ops catalog entries for lane blocks — same pipeline as /api/pp-vouchers/with-ops."""
    from planning.helpers import rows as _db_rows
    from planning.utils import compact_text

    if not partial_keys:
        return []
    allowed = {
        (compact_text(base), int(partial or 1))
        for base, partial in partial_keys
        if compact_text(base)
    }
    if not allowed:
        return []

    select_sql, from_sql = _pp_vouchers_cache_sql_parts()
    from planning.utils import SHIPPED_QTY_TOLERANCE

    ps_ids = sorted({key[0] for key in allowed})
    shipped_complete = (
        "c.so_det_qty IS NOT NULL "
        f"AND COALESCE(c.qty_shipped, 0) >= c.so_det_qty - {SHIPPED_QTY_TOLERANCE}"
    )
    where_parts = ["c.ps_id = ANY(%s)"]
    params: list = [ps_ids]
    if not include_completed:
        where_parts.append(f"NOT ({shipped_complete})")
    where = " WHERE " + " AND ".join(where_parts)
    order = " ORDER BY c.ps_id, c.pp_partial_no, c.stage_no"
    sql = f"SELECT {select_sql} {from_sql}{where}{order}"
    cache_rows = [
        row for row in _db_rows(con.execute(sql, tuple(params)))
        if (compact_text(row.get("ps_id")), int(row.get("pp_partial_no") or 1)) in allowed
    ]
    if not cache_rows:
        return []
    return _enrich_pp_vouchers_planner_data(
        _pp_vouchers_with_ops_payload(cache_rows),
        con=con,
    )


def _invalidate_pp_vouchers_with_ops_cache(*, schedule_rebuild=False):
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        _PP_VOUCHERS_WITH_OPS_CACHE.clear()
        _PP_VOUCHERS_BOARD_ERP_CACHE.clear()
    if schedule_rebuild:
        for include_completed in (False, True):
            scope = _pp_vouchers_cache_scope(include_completed)
            _schedule_pp_vouchers_with_ops_refresh(scope, include_completed)


def _pp_vouchers_board_cache_lookup(scope: str, *, allow_stale: bool):
    now = time.monotonic()
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        bucket = _PP_VOUCHERS_BOARD_ERP_CACHE.get(scope) or {}
        data = bucket.get("data")
        if data is None:
            return None
        if now < float(bucket.get("expires_at") or 0):
            return data
        if allow_stale and now < float(bucket.get("stale_expires_at") or 0):
            return data
    return None


def _store_pp_vouchers_board_erp_cache(scope: str, data: list) -> None:
    now = time.monotonic()
    with _PP_VOUCHERS_WITH_OPS_CACHE_LOCK:
        _PP_VOUCHERS_BOARD_ERP_CACHE[scope] = {
            "data": data,
            "expires_at": now + _PP_VOUCHERS_WITH_OPS_TTL_SECS,
            "stale_expires_at": now + _PP_VOUCHERS_STALE_SECS,
        }


def _load_pp_vouchers_board_erp_data(include_completed: bool, refresh: bool, scope: str):
    """ERP-only board rows from memory cache or DB (one connection, released before planner list)."""
    if not refresh:
        cached = _pp_vouchers_board_cache_lookup(scope, allow_stale=True)
        if cached is not None:
            return list(cached)

    from planning.helpers import planner_db

    from planning.erp_wo_merge import merge_finishing_stages_into_voucher_entries

    with planner_db() as con:
        payload = _pp_vouchers_with_ops_payload(
            _fetch_pp_vouchers_cache_rows(include_completed, con=con)
        )
        merge_finishing_stages_into_voucher_entries(payload, con)
        for entry in payload:
            _finalize_pp_voucher_entry(entry)
        erp_data = _enrich_pp_vouchers_planner_data(payload, con=con)
    _store_pp_vouchers_board_erp_cache(scope, erp_data)
    return erp_data


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


def _entry_ps_base_and_partial(entry: dict) -> tuple[str, int]:
    source = str(entry.get("source_ps_id") or "").split("::")[0].strip().lower()
    if not source:
        source = str(entry.get("ps_id") or "").split("::")[0].strip().lower()
    try:
        partial_no = max(1, int(entry.get("pp_partial_no") or 1))
    except (TypeError, ValueError):
        partial_no = 1
    return source, partial_no


def _entry_matches_search_term(entry: dict, term: str) -> bool:
    from planning.process_sheets import is_ps_base_id, parse_bulk_lookup_ps_term

    term = term.strip().lower()
    if not term:
        return True
    base_term, partial_no = parse_bulk_lookup_ps_term(term)
    source, entry_partial = _entry_ps_base_and_partial(entry)
    if partial_no is not None and is_ps_base_id(base_term):
        return source == base_term and entry_partial == partial_no

    ps_ids = [
        str(entry.get(key) or "").lower()
        for key in ("ps_id", "source_ps_id", "display_ps_id")
        if entry.get(key)
    ]
    if ps_ids and any(base_term in ps_id for ps_id in ps_ids):
        return True
    if is_ps_base_id(base_term) and source == base_term:
        return True
    return base_term in _pp_voucher_search_haystack(entry)


def _filter_pp_vouchers_by_search(data: list, raw_search: str) -> list:
    from planning.process_sheets import is_ps_base_id, parse_bulk_lookup_ps_term

    normalized = str(raw_search or "").replace(";", " ").replace(",", " ")
    terms = [term.strip().lower() for term in normalized.split() if term.strip()]
    if not terms:
        return data
    parsed_terms = [parse_bulk_lookup_ps_term(term) for term in terms]
    matched = [
        entry
        for entry in data
        if any(_entry_matches_search_term(entry, term) for term in terms)
    ]
    explicit_partial_bases = {
        base_term
        for base_term, partial_no in parsed_terms
        if partial_no is not None and is_ps_base_id(base_term)
    }
    bases_to_expand = {
        base_term
        for base_term, partial_no in parsed_terms
        if partial_no is None and is_ps_base_id(base_term)
    }
    bases_to_expand.update(
        str(entry.get("source_ps_id") or "").split("::")[0].strip().lower()
        for entry in matched
        if entry.get("source_ps_id")
    )
    bases_to_expand -= explicit_partial_bases
    if not bases_to_expand:
        return matched
    by_id = {id(entry): entry for entry in matched}
    for entry in data:
        base = str(entry.get("source_ps_id") or "").split("::")[0].strip().lower()
        if base and base in bases_to_expand:
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


def _finalize_pp_voucher_entry(entry: dict) -> None:
    """Recalculate completion flags; ERP WO completion comes from mfg_wo_status metadata."""
    machining_completed = _entry_production_completed_from_ops(entry)
    erp_all_complete = bool(entry.get("erp_all_wo_complete"))
    entry["execution_completed"] = erp_all_complete or machining_completed
    entry["pending_do"] = pending_delivery_order(entry)
    entry["is_completed"] = bool(entry.get("shipped_completed")) or (
        erp_all_complete and not entry["pending_do"]
    )
    current_code = entry.get("current_stage_status")
    if current_code:
        entry["execution_status"] = _execution_status_label(current_code)


def _entry_production_completed_from_ops(entry, *, tol=0.0001):
    """True only when every ERP stage with WO evidence is qty-complete."""
    from planning.utils import op_production_complete

    ops = entry.get("op_cards") or entry.get("ops") or []
    tracked = []
    for op in ops:
        required = float(op.get("wo_qty_required") or op.get("required_qty") or 0)
        produced = float(op.get("finished_qty") or op.get("wo_qty_produced") or 0)
        status = _normalize_execution_status(op.get("execution_status"))
        if required > tol or produced > tol or status:
            tracked.append(op)
    if not tracked:
        return False
    return all(op_production_complete(op, tol=tol) for op in tracked)


def _apply_sequential_partial_shipped(entries, *, tol=0.0001):
    """Allocate duplicated SO shipped qty across partials; avoid marking open partials done."""
    from planning.utils import compact_text, shipped_quantity_completed

    by_source = {}
    for entry in entries:
        source = compact_text(entry.get("source_ps_id") or "")
        if not source:
            ps_id = compact_text(entry.get("ps_id") or "")
            source = ps_id.split("::", 1)[0] if ps_id else ""
        if not source:
            continue
        by_source.setdefault(source, []).append(entry)

    for siblings in by_source.values():
        siblings.sort(key=lambda item: int(item.get("pp_partial_no") or 1))
        shipped_total = max(float(item.get("qty_shipped") or 0) for item in siblings)
        shipped_left = max(0.0, shipped_total)
        so_qty = next((item.get("so_det_qty") for item in siblings if item.get("so_det_qty") is not None), None)
        so_shipped_complete = so_qty is not None and shipped_quantity_completed(so_qty, shipped_total)

        for entry in siblings:
            production_completed = bool(entry.get("execution_completed"))
            partial_work_qty = float(
                entry.get("display_qty") or entry.get("partial_qty") or entry.get("wo_req_qty") or 0
            )
            has_partial_erp_evidence = bool(
                str(entry.get("current_stage_status") or "").strip()
                or any(str(op.get("execution_status") or "").strip() for op in (entry.get("op_cards") or []))
            )
            covered = min(partial_work_qty, shipped_left) if partial_work_qty > tol else 0.0
            sequential_shipped = (
                has_partial_erp_evidence
                and production_completed
                and partial_work_qty > tol
                and covered >= (partial_work_qty - tol)
            )
            shipped_left = max(0.0, shipped_left - covered)
            entry["shipped_completed"] = sequential_shipped or so_shipped_complete

            if sequential_shipped and partial_work_qty > 0:
                entry["wo_qty_required"] = max(float(entry.get("wo_qty_required") or 0), partial_work_qty)
                entry["finished_qty"] = max(float(entry.get("finished_qty") or 0), partial_work_qty)
                entry["remaining_qty"] = max(0.0, float(entry["wo_qty_required"]) - float(entry["finished_qty"]))
                for op in entry.get("op_cards") or []:
                    op_req = float(op.get("wo_qty_required") or op.get("required_qty") or partial_work_qty)
                    if float(op.get("wo_qty_produced") or 0) <= 0:
                        op["wo_qty_produced"] = min(op_req, partial_work_qty)
                    op["finished_qty"] = max(float(op.get("finished_qty") or 0), float(op.get("wo_qty_produced") or 0))
                    op["remaining_qty"] = max(0.0, op_req - float(op["finished_qty"]))


def _pp_voucher_stage_op_key(stage_no, op_no, stage_desc=""):
    stage_no = int(stage_no or 0)
    op_text = str(op_no or "").strip()
    if not op_text and stage_no:
        op_text = str(stage_no)
    if op_text:
        return (stage_no, op_text)
    return (stage_no, str(stage_desc or "").strip())


def _merge_pp_voucher_op_card(existing, incoming):
    """Roll up duplicate ERP cache stage rows (split WOs) into one catalog op card."""
    for field in ("target_qty", "required_qty", "wo_qty_required"):
        existing[field] = max(float(existing.get(field) or 0), float(incoming.get(field) or 0))
    for field in ("wo_qty_produced", "finished_qty", "wo_qty_rejected", "reject_qty", "planned_qty"):
        existing[field] = max(float(existing.get(field) or 0), float(incoming.get(field) or 0))
    existing["qty_shipped"] = max(
        float(existing.get("qty_shipped") or 0),
        float(incoming.get("qty_shipped") or 0),
    )
    qty = float(existing.get("target_qty") or 0)
    stage_required = float(existing.get("required_qty") or existing.get("wo_qty_required") or 0)
    stage_produced = float(existing.get("finished_qty") or existing.get("wo_qty_produced") or 0)
    base_qty = qty if qty > 0 else stage_required
    if base_qty > 0 or stage_produced > 0 or str(existing.get("execution_status") or "").strip():
        existing["remaining_qty"] = max(0.0, base_qty - stage_produced)
    else:
        existing["remaining_qty"] = max(
            float(existing.get("remaining_qty") or 0),
            float(incoming.get("remaining_qty") or 0),
        )
    if _execution_status_rank(incoming.get("execution_status")) < _execution_status_rank(
        existing.get("execution_status")
    ):
        existing["execution_status"] = incoming.get("execution_status") or existing.get("execution_status")


def _pp_vouchers_with_ops_payload(cache_rows):
    from planning.utils import sanitize_erp_execution_status

    # Group cache rows by (ps_id, pp_partial_no). Duplicate cache rows for the same
    # stage/op (split ERP WOs) are merged into one op card per stage.
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
                "_op_card_by_stage": {},
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
        entry_work_qty = float(entry.get("display_qty") or entry.get("partial_qty") or entry.get("total_qty") or 0)
        effective_required = entry_work_qty if entry_work_qty > 0 else required_qty
        effective_produced = min(max(0.0, produced_qty), effective_required if effective_required > 0 else produced_qty)
        effective_rejected = min(max(0.0, rejected_qty), effective_required if effective_required > 0 else rejected_qty)
        entry["wo_qty_required"] = max(float(entry.get("wo_qty_required") or 0), effective_required)
        entry["finished_qty"] = max(float(entry.get("finished_qty") or 0), effective_produced)
        entry["reject_qty"] = max(float(entry.get("reject_qty") or 0), effective_rejected)
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
            stage_required = qty if qty > 0 else required_qty
            stage_produced = min(max(0.0, produced_qty), stage_required if stage_required > 0 else produced_qty)
            stage_rejected = min(max(0.0, rejected_qty), stage_required if stage_required > 0 else rejected_qty)
            has_wo_output = stage_required > 0 or stage_produced > 0 or str(row_execution_status or "").strip()
            voucher_status = str(row.get("status") or entry.get("status") or "").strip().upper()
            is_outstanding = voucher_status in {"O", "OUTSTANDING"}
            if not has_wo_output:
                # New/outstanding PP with BOM route but no WO issued yet — still schedulable.
                if is_outstanding and display_qty > 0:
                    qty = display_qty
                    remaining_qty = display_qty
                else:
                    qty = 0.0
                    remaining_qty = 0.0
            else:
                remaining_qty = max(0.0, qty - stage_produced)
            machine_group = stage_desc.split()[0].upper() if stage_desc else ""
            row_execution_status = sanitize_erp_execution_status(
                row_execution_status,
                required=stage_required,
                finished=stage_produced,
                remaining=remaining_qty,
            )
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
                "required_qty": stage_required,
                "wo_qty_required": stage_required,
                "wo_qty_produced": stage_produced,
                "wo_qty_rejected": stage_rejected,
                "qty_shipped": float(row.get("qty_shipped") or 0),
                "planned_qty": 0.0,
                "finished_qty": stage_produced,
                "reject_qty": stage_rejected,
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
            stage_key = _pp_voucher_stage_op_key(stage_no, op_no, stage_desc)
            stage_ops = entry.setdefault("_op_card_by_stage", {})
            existing_card = stage_ops.get(stage_key)
            if existing_card is not None:
                _merge_pp_voucher_op_card(existing_card, op_card)
            else:
                stage_ops[stage_key] = op_card
                entry["op_cards"].append(op_card)
                entry["ops"].append(op_card)

    for entry in grouped.values():
        entry.pop("_op_card_by_stage", None)
        current_code = entry.get("current_stage_status")
        if current_code:
            entry["execution_status"] = _execution_status_label(current_code)
        else:
            stage_statuses = [op.get("execution_status") for op in entry.get("ops", [])]
            summary_status = _summarize_execution_status(stage_statuses)
            if summary_status:
                entry["execution_status"] = summary_status
        so_qty = entry.get("so_det_qty")
        production_completed = _entry_production_completed_from_ops(entry)
        entry["execution_completed"] = production_completed
        entry["is_completed"] = production_completed
        entry["pending_do"] = pending_delivery_order(entry)
        bom_code = str(entry.get("bom_code") or "").strip()
        entry["erp_bom_code"] = bom_code
        entry["inventory_code"] = str(entry.get("inventory_code") or entry.get("part_no") or "").strip()

    result = list(grouped.values())
    _apply_sequential_partial_shipped(result)
    for entry in result:
        entry["is_completed"] = bool(entry.get("shipped_completed")) or bool(entry.get("execution_completed"))
        entry["pending_do"] = pending_delivery_order(entry)
    return result


def _erp_wo_completion_by_partial(con, source_ids):
    """Aggregate ERP WO completion from mfg_wo_status (authoritative vs BOM stage rows)."""
    from planning.helpers import rows as db_rows
    from planning.utils import compact_text

    if not source_ids:
        return {}
    out = {}
    for row in db_rows(
        con.execute(
            """
            SELECT source_mps_no, pp_partial_no,
                   COUNT(*)::INTEGER AS stage_count,
                   BOOL_AND(
                       COALESCE(execution_status, '') = 'C'
                       AND (
                           COALESCE(wo_qty_required, 0) <= 0.0001
                           OR COALESCE(total_acc_qty_produced, 0)
                              >= COALESCE(wo_qty_required, 0) - 0.0001
                       )
                   ) AS all_complete
            FROM mfg_wo_status
            WHERE source_mps_no = ANY(%s)
            GROUP BY source_mps_no, pp_partial_no
            """,
            (list(source_ids),),
        )
    ):
        key = (compact_text(row["source_mps_no"]), int(row.get("pp_partial_no") or 1))
        stage_count = int(row.get("stage_count") or 0)
        out[key] = {
            "erp_wo_stage_count": stage_count,
            "erp_all_wo_complete": stage_count > 0 and bool(row.get("all_complete")),
        }
    return out


def _merge_fresh_temp_ps_catalog_entries(entries, include_completed=False):
    """Replace cached [Temp] rows with current planner DB state (cheap vs full ERP rebuild)."""
    from planning.helpers import planner_db
    from planning.process_sheets import is_temp_planner_ps_id
    from planning.utils import compact_text

    base = [
        entry
        for entry in (entries or [])
        if not is_temp_planner_ps_id(compact_text(entry.get("ps_id")))
    ]
    try:
        with planner_db() as con:
            return _append_temp_ps_catalog_entries(base, con, include_completed=include_completed)
    except Exception as exc:
        log.warning("temp PS catalog merge failed: %s", exc)
        return list(entries or [])


def _append_temp_ps_catalog_entries(entries, con, include_completed=False):
    """Merge planner-only [Temp] reject/rework PS into the sidebar catalog."""
    from planning.catalog import trial_catalog_items
    from planning.helpers import rows as db_rows
    from planning.process_sheets import is_temp_planner_ps_id
    from planning.utils import compact_text

    merged = list(entries or [])
    existing = {compact_text(item.get("ps_id")) for item in merged if compact_text(item.get("ps_id"))}
    temp_ids = [
        compact_text(row.get("planner_ps_id"))
        for row in db_rows(
            con.execute(
                """
                SELECT planner_ps_id
                FROM planner_process_sheet
                WHERE planner_ps_id LIKE '[Temp]%%'
                """
            )
        )
        if compact_text(row.get("planner_ps_id")) and compact_text(row.get("planner_ps_id")) not in existing
    ]
    if not temp_ids:
        return merged
    catalog = trial_catalog_items(
        con,
        include_completed=include_completed,
        planner_ps_ids=temp_ids,
    )
    for bucket in ("available", "planned"):
        for item in catalog.get(bucket) or []:
            ps_id = compact_text(item.get("ps_id"))
            if not ps_id or not is_temp_planner_ps_id(ps_id) or ps_id in existing:
                continue
            merged.append(dict(item))
            existing.add(ps_id)
    return merged


def _enrich_pp_vouchers_planner_data(entries, con=None):
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
    erp_bom_codes_map = {}
    bom_code_by_id = {}
    wo_completion = {}

    def _load(_con):
        nonlocal wo_completion, erp_bom_codes_map
        if source_ids:
            wo_completion = _erp_wo_completion_by_partial(_con, source_ids)
        if source_ids:
            for row in db_rows(
                _con.execute(
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
            from planning.flows import erp_bom_codes_by_inventory

            erp_bom_codes_map = erp_bom_codes_by_inventory(_con, list(inventory_codes))
            for row in db_rows(
                _con.execute(
                    """
                    SELECT bom_id, inventory_code, bom_code, bom_desc, is_default, source_kind
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
                        "source_kind": compact_text(row.get("source_kind") or "ERP"),
                    }
                )

        bom_ids = [
            int(row["selected_bom_id"])
            for row in planner_rows.values()
            if int(row.get("selected_bom_id") or 0) > 0
        ]
        if bom_ids:
            for row in db_rows(
                _con.execute(
                    """
                    SELECT bom_id, bom_code
                    FROM planner_bom_variation
                    WHERE bom_id = ANY(%s)
                    """,
                    (bom_ids,),
                )
            ):
                bom_code_by_id[int(row["bom_id"])] = compact_text(row["bom_code"])

    if con is not None:
        _load(con)
    else:
        with planner_db() as _con:
            _load(_con)

    from planning.catalog import (
        _bom_op_stage_keys,
        _catalog_lane_qty_maps,
        attach_planner_bom_ops_to_catalog_entry,
    )

    bom_stage_keys = _bom_op_stage_keys(con) if con is not None else set()
    planned_qty_by_op = {}
    queued_machines_by_op = {}
    needs_planner_ops = any(
        int(row.get("selected_bom_id") or 0) > 0 for row in planner_rows.values()
    ) or any(int(entry.get("selected_bom_id") or 0) > 0 for entry in entries)
    if con is not None and needs_planner_ops:
        planned_qty_by_op, queued_machines_by_op = _catalog_lane_qty_maps(con)

    master_cache = None
    if con is not None and needs_planner_ops:
        from planning.cycle_time_service import MasterTimeCache

        master_cache = MasterTimeCache.load(con)

    from planning.process_sheets import format_planner_ps_id, material_in_map_for_planner_ps_ids

    material_in_by_ps = {}
    if con is not None:
        planner_ps_ids = []
        for entry in entries:
            source_ps_id = compact_text(entry.get("source_ps_id"))
            if not source_ps_id:
                ps_id = compact_text(entry.get("ps_id"))
                source_ps_id = ps_id.split("::", 1)[0] if ps_id else ""
            if source_ps_id:
                planner_ps_ids.append(
                    format_planner_ps_id(source_ps_id, int(entry.get("pp_partial_no") or 1))
                )
        material_in_by_ps = material_in_map_for_planner_ps_ids(con, planner_ps_ids)

    for entry in entries:
        bom_code = compact_text(entry.get("erp_bom_code") or entry.get("bom_code"))
        entry["erp_bom_code"] = bom_code
        source_ps_id = compact_text(entry.get("source_ps_id"))
        if not source_ps_id:
            ps_id = compact_text(entry.get("ps_id"))
            source_ps_id = ps_id.split("::", 1)[0] if ps_id else ""
        partial_no = int(entry.get("pp_partial_no") or 1)
        planner_ps_id = format_planner_ps_id(source_ps_id, partial_no) if source_ps_id else ""
        entry["material_in"] = bool(material_in_by_ps.get(planner_ps_id))
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
        erp_bom = compact_text(entry.get("erp_bom_code") or entry.get("bom_code"))
        from planning.flows import merge_flow_options

        entry["flow_options"] = merge_flow_options(
            flow_cache.get(inv, entry.get("flow_options") or []),
            erp_bom_codes_map.get(inv, []),
            erp_voucher_bom=erp_bom,
        )
        wo_flags = wo_completion.get((source_ps_id, partial_no), {})
        entry["erp_wo_stage_count"] = int(wo_flags.get("erp_wo_stage_count") or 0)
        entry["erp_all_wo_complete"] = bool(wo_flags.get("erp_all_wo_complete"))
        if con is not None and int(entry.get("selected_bom_id") or 0) > 0:
            attach_planner_bom_ops_to_catalog_entry(
                con,
                entry,
                planned_qty_by_op=planned_qty_by_op,
                queued_machines_by_op=queued_machines_by_op,
                bom_stage_keys=bom_stage_keys,
                master_cache=master_cache,
            )

    return entries


@app.get("/api/pp-vouchers")
def api_pp_vouchers():
    """Raw pp_vouchers_cache rows — no sync-on-read (use Sync ERP to refresh)."""
    try:
        from db import supa_url, supa_headers
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
    """Pre-built catalog only — rebuilt during ERP sync, not on page load."""
    include_completed = _pp_vouchers_include_completed()
    scope = _pp_vouchers_cache_scope(include_completed)
    raw_search = str(request.args.get("search") or "").strip()
    refresh = str(request.args.get("refresh") or "").lower() in {"1", "true", "yes"}

    cached_data = _pp_vouchers_memory_cache_lookup(scope, allow_stale=True)
    if cached_data is None:
        cached_data = _pp_vouchers_disk_cache_load(scope)
        if cached_data is not None:
            _store_pp_vouchers_with_ops_cache(scope, cached_data)

    if cached_data is not None:
        if refresh:
            _schedule_pp_vouchers_with_ops_refresh(scope, include_completed)
        merged = _merge_fresh_temp_ps_catalog_entries(cached_data, include_completed)
        return jsonify(_filter_pp_vouchers_by_search(merged, raw_search))

    if refresh:
        _schedule_pp_vouchers_with_ops_refresh(scope, include_completed)
    # Planner-only [Temp] rows still belong in the sidebar when ERP cache is cold.
    try:
        from planning.helpers import planner_db

        with planner_db() as con:
            temp_only = _append_temp_ps_catalog_entries([], con, include_completed=include_completed)
        if temp_only:
            return jsonify(_filter_pp_vouchers_by_search(temp_only, raw_search))
    except Exception as exc:
        log.warning("temp-only catalog fallback failed: %s", exc)
    return jsonify([])


@app.get("/api/process-sheets/board")
def api_process_sheets_board():
    """Single round-trip for Process Sheets: planner rows + ERP-only vouchers."""
    import concurrent.futures

    from flask import copy_current_request_context
    from planning.helpers import planner_db
    from planning.process_sheets import (
        enrich_board_planner_fields,
        list_process_sheets_payload,
        process_sheet_board_identity_key,
    )
    from planning.utils import compact_text

    try:
        include_completed = _pp_vouchers_include_completed()
        refresh = str(request.args.get("refresh") or "").lower() in {"1", "true", "yes"}
        scope = _pp_vouchers_cache_scope(include_completed)

        @copy_current_request_context
        def _load_erp_board_rows():
            erp_data = _load_pp_vouchers_board_erp_data(include_completed, refresh, scope)
            if not include_completed:
                erp_data = [entry for entry in erp_data if not entry.get("shipped_completed")]
            return erp_data

        @copy_current_request_context
        def _load_planner_board_rows():
            with planner_db() as con:
                planner_items = list_process_sheets_payload(con)
                enrich_board_planner_fields(con, planner_items)
                return planner_items

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            erp_future = pool.submit(_load_erp_board_rows)
            planner_future = pool.submit(_load_planner_board_rows)
            erp_data = erp_future.result()
            planner_items = planner_future.result()

        planner_keys = {process_sheet_board_identity_key(item) for item in planner_items}
        erp_only = [
            entry
            for entry in erp_data
            if compact_text(entry.get("ps_id"))
            and process_sheet_board_identity_key(entry) not in planner_keys
        ]
        with planner_db() as con:
            enrich_board_planner_fields(con, erp_only)
            from planning.materials import enrich_items_material_inventory_codes

            enrich_items_material_inventory_codes(con, erp_only)
        return jsonify({"planner": planner_items, "erp_only": erp_only})
    except Exception as e:
        from db import planner_db_connect_error

        friendly = planner_db_connect_error(e)
        return jsonify({"error": friendly or str(e)}), 500


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


def _want_background_pp_sync(body: dict | None = None) -> bool:
    body = body if body is not None else (request.get_json(silent=True) or {})
    raw = body.get("background", request.args.get("background", False))
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return bool(raw)


def _domain_sync_unreachable_response():
    from db import domain_db_endpoint, domain_sync_likely_unreachable, domain_sync_unreachable

    if not domain_sync_unreachable():
        return None
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


def _run_pp_staging_sync_pipeline(steps: list[str], force: bool, *, run_post_sync: bool = True) -> tuple[dict, int]:
    from sync import run_pp_staging_sync

    staging_only = [s for s in steps if s != "pp_vouchers_cache"]
    if staging_only:
        _ensure_pp_staging_schema()
    results: dict = {"schema": {"updated": bool(staging_only)}}
    sync_results = run_pp_staging_sync(steps=steps, force=force)
    results.update(sync_results)
    if run_post_sync and ("pp_vouchers_cache" in steps or staging_only):
        from planning.erp_cache_refresh import refresh_after_erp_sync

        results["post_sync"] = refresh_after_erp_sync(warm=True, background=True)
    failed = results.get("_failed_at")
    if failed:
        step_result = results.get(failed, {})
        err = step_result.get("error") or step_result.get("reason") or f"sync failed at {failed}"
        return {"error": err, **results}, 500
    return results, 200


def _run_erp_post_sync() -> dict:
    from planning.erp_cache_refresh import refresh_after_erp_sync

    return refresh_after_erp_sync(warm=True, background=True)


def _background_pp_sync_worker(steps: list[str], force: bool) -> None:
    global _BG_PP_SYNC
    try:
        payload, status = _run_pp_staging_sync_pipeline(steps, force, run_post_sync=False)
        with _BG_PP_SYNC_LOCK:
            _BG_PP_SYNC["results"] = payload
            _BG_PP_SYNC["failed_at"] = payload.get("_failed_at")
            if status >= 400 and not _BG_PP_SYNC["failed_at"]:
                _BG_PP_SYNC["error"] = payload.get("error") or "sync failed"
            # Staging steps finished — release the UI wait loop before cache warm / reconcile.
            _BG_PP_SYNC["running"] = False
            if status < 400 and not payload.get("_failed_at"):
                _BG_PP_SYNC["post_sync_running"] = True

        if status >= 400 or payload.get("_failed_at"):
            return

        try:
            post_sync = _run_erp_post_sync()
            with _BG_PP_SYNC_LOCK:
                if isinstance(_BG_PP_SYNC.get("results"), dict):
                    _BG_PP_SYNC["results"]["post_sync"] = post_sync
        except Exception as exc:
            log.exception("ERP post-sync (cache warm / queue reconcile) failed")
            with _BG_PP_SYNC_LOCK:
                _BG_PP_SYNC["post_sync_error"] = str(exc)
    except Exception as exc:
        log.exception("background PP staging sync failed")
        with _BG_PP_SYNC_LOCK:
            _BG_PP_SYNC["error"] = str(exc)
    finally:
        with _BG_PP_SYNC_LOCK:
            _BG_PP_SYNC["running"] = False
            _BG_PP_SYNC["post_sync_running"] = False
            _BG_PP_SYNC["started_at"] = None


def _bg_pp_sync_stale() -> bool:
    with _BG_PP_SYNC_LOCK:
        if not _BG_PP_SYNC.get("running") and not _BG_PP_SYNC.get("post_sync_running"):
            return False
        started = _BG_PP_SYNC.get("started_at")
    if started is None:
        return True
    try:
        return (time.monotonic() - float(started)) > _BG_PP_SYNC_STALE_SECS
    except (TypeError, ValueError):
        return True


def _reset_stale_bg_pp_sync(reason: str) -> None:
    global _BG_PP_SYNC
    log.warning("Resetting stale ERP background sync (%s)", reason)
    with _BG_PP_SYNC_LOCK:
        _BG_PP_SYNC = {
            "running": False,
            "post_sync_running": False,
            "started_at": None,
            "failed_at": None,
            "error": f"stale sync reset: {reason}",
            "results": _BG_PP_SYNC.get("results"),
            "post_sync_error": None,
        }


def _start_background_pp_sync(steps: list[str], force: bool):
    global _BG_PP_SYNC
    if _bg_pp_sync_stale():
        _reset_stale_bg_pp_sync("exceeded stale timeout")
    with _BG_PP_SYNC_LOCK:
        if _BG_PP_SYNC.get("running") or _BG_PP_SYNC.get("post_sync_running"):
            return None
        _BG_PP_SYNC = {
            "running": True,
            "post_sync_running": False,
            "started_at": time.monotonic(),
            "failed_at": None,
            "error": None,
            "results": None,
            "post_sync_error": None,
        }
    threading.Thread(
        target=_background_pp_sync_worker,
        args=(steps, force),
        daemon=True,
        name="pp-staging-sync",
    ).start()
    return dict(_BG_PP_SYNC)


def _pp_staging_status_payload() -> dict:
    from sync import get_pp_staging_status

    with _BG_PP_SYNC_LOCK:
        background = dict(_BG_PP_SYNC)
    return {**get_pp_staging_status(), "background_sync": background}


def _pp_sync_progress_token(payload: dict) -> str:
    order = payload.get("step_order") or []
    parts: list[str] = []
    bg = payload.get("background_sync") or {}
    parts.append("1" if bg.get("running") else "0")
    parts.append("1" if bg.get("post_sync_running") else "0")
    parts.append(str(bg.get("failed_at") or ""))
    parts.append(str(bg.get("post_sync_error") or ""))
    for step in order:
        info = (payload.get("steps") or {}).get(step) or {}
        if info.get("in_progress"):
            parts.append(f">{step}")
        last = info.get("last") or {}
        parts.append(f"{step}:{last.get('recorded_at') or last.get('synced_at') or ''}")
    return "|".join(parts)


def _pp_sync_fully_done(payload: dict) -> bool:
    bg = payload.get("background_sync") or {}
    return not bg.get("running") and not bg.get("post_sync_running")


@app.post("/api/pp-vouchers/sync")
def api_pp_vouchers_sync():
    """Force full COMAIN → Supabase staging + cache rebuild (manual Sync ERP)."""
    return api_pp_staging_sync()


# ── PP staging schema / vw_pp_vouchers (canonical SQL in sql/*.sql) ─────────


def _ensure_pp_staging_schema(*, apply_view: bool = False):
    from planning.pp_staging_sql import ensure_pp_staging_schema

    return ensure_pp_staging_schema(apply_view=apply_view)


@app.post("/api/admin/fix-execution-status")
def api_admin_fix_execution_status():
    from sync import run_mfg_wo_status_sync, run_sync
    results = {}
    try:
        _ensure_pp_staging_schema(apply_view=True)
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
    from planning.finishing_queue_route import invalidate_finishing_queue_cache
    try:
        result = run_mfg_wo_status_sync(force=True)
        invalidate_finishing_queue_cache()
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
    if _bg_pp_sync_stale():
        _reset_stale_bg_pp_sync("status poll timeout")
    return jsonify(_pp_staging_status_payload())


@app.get("/api/pp-staging/wait")
def api_pp_staging_wait():
    """Long-poll ERP sync progress (avoids polling /status every few seconds)."""
    if _bg_pp_sync_stale():
        _reset_stale_bg_pp_sync("wait poll timeout")
    try:
        timeout_sec = int(request.args.get("timeout", 30))
    except (TypeError, ValueError):
        timeout_sec = 30
    timeout_sec = max(5, min(timeout_sec, _ERP_SYNC_WAIT_MAX_SECS))
    since = str(request.args.get("since") or "").strip()
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        payload = _pp_staging_status_payload()
        token = _pp_sync_progress_token(payload)
        bg = payload.get("background_sync") or {}
        if _pp_sync_fully_done(payload):
            return jsonify({**payload, "done": True, "progress_token": token})
        if since and token != since:
            return jsonify({**payload, "done": False, "progress_token": token})
        if not since:
            return jsonify({**payload, "done": False, "progress_token": token})
        time.sleep(1.0)
    payload = _pp_staging_status_payload()
    return jsonify({
        **payload,
        "done": _pp_sync_fully_done(payload),
        "progress_token": _pp_sync_progress_token(payload),
    })


@app.post("/api/pp-staging/cache-refresh")
def api_pp_staging_cache_refresh():
    """Invalidate and warm in-process ERP read caches (called after scheduled sync)."""
    secret = os.getenv("ERP_CACHE_REFRESH_SECRET", "").strip()
    if secret:
        if request.headers.get("X-ERP-Cache-Refresh", "") != secret:
            return jsonify({"error": "forbidden"}), 403
    elif request.remote_addr not in {"127.0.0.1", "::1"}:
        return jsonify({"error": "forbidden"}), 403

    from planning.erp_cache_refresh import refresh_after_erp_sync

    return jsonify(refresh_after_erp_sync(warm=True, background=False))


@app.post("/api/pp-vouchers-cache/rebuild")
def api_pp_vouchers_cache_rebuild():
    """Rebuild pp_vouchers_cache from vw_pp_vouchers (no COMAIN staging)."""
    from sync import run_pp_staging_sync
    try:
        results = run_pp_staging_sync(steps=["pp_vouchers_cache"], force=True)
        from planning.erp_cache_refresh import refresh_after_erp_sync

        refresh_after_erp_sync(warm=True, background=True)
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
    """Run PP staging syncs; pass {\"background\": true} from the UI to avoid proxy timeouts."""
    try:
        body = request.get_json(silent=True) or {}
        steps, force = _parse_pp_staging_sync_args()
        staging_only = [s for s in steps if s != "pp_vouchers_cache"]
        if staging_only:
            blocked = _domain_sync_unreachable_response()
            if blocked is not None:
                return blocked
        if _want_background_pp_sync(body):
            started = _start_background_pp_sync(steps, force)
            if started is None:
                return jsonify({
                    "error": "ERP sync is already running",
                    "background_sync": _pp_staging_status_payload().get("background_sync"),
                }), 409
            return jsonify({"status": "started", "background_sync": started, "steps": steps})
        payload, status = _run_pp_staging_sync_pipeline(steps, force)
        return jsonify(payload), status
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
        "planner_gate_enabled": _planner_gate_enabled(),
        "planner_path": PLANNER_PATH,
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
    from planning.bom_materials import fetch_bom_material_rows, resolve_bom_materials

    source = request.args.get("source", "").strip()
    bom = request.args.get("bom", "").strip()
    fallback = request.args.get("fallback", "").strip().lower() in {"1", "true", "yes"}
    if not source:
        return jsonify({"error": "source is required"}), 400
    try:
        if fallback:
            return jsonify(resolve_bom_materials(db_query, source, bom or None))
        return jsonify(fetch_bom_material_rows(db_query, source, bom or None))
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
        from planning.bom_operations import fetch_machining_operations

        rows = fetch_machining_operations(db_query, source, bom)
        return jsonify([
            {
                "inventory_code": r["inventory_code"],
                "bom_code":       r["bom_code"],
                "stage_no":       r["stage_no"],
                "stage_desc":     r["stage_desc"] or "",
                "op_no":          r["op_no"],
                "machine_no":     r["machine_no"] or "",
            }
            for r in rows
        ])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: stubs ─────────────────────────────────────────────────────────────

@app.get("/api/machine-schedule")
def api_machine_schedule():
    """Alias for gantt timeline data (same payload as /api/trial/gantt)."""
    from planning.gantt_route import api_trial_gantt
    return api_trial_gantt()


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
    "program_no,program_file,tool_list_file,ideal_cycle_time,cycle_time,set_up_time,updated_at"
)


def _non_negative_number(value, default=0.0):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return float(default)


def _api_planner_cycle_times_harvest_preview_impl():
    from planning.cycle_time_service import harvest_preview, planner_db_available
    from planning.helpers import planner_db

    if not planner_db_available():
        return jsonify({"error": "SUPA_DB_URL is not set. Direct Postgres is required."}), 503
    with planner_db() as con:
        rows_out = harvest_preview(con)
    return jsonify({"rows": rows_out, "count": len(rows_out)})


@app.get("/api/planner/cycle-times")
def api_planner_cycle_times_list():
    """List master cycle times. Uses service role (RLS on this table blocks anon reads)."""
    if request.args.get("harvest") == "preview":
        try:
            return _api_planner_cycle_times_harvest_preview_impl()
        except Exception as e:
            return jsonify({"error": str(e)}), 500
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

    ideal_cycle = _non_negative_number(data.get("ideal_cycle_time"), 0)
    production_cycle = _non_negative_number(data.get("cycle_time"), ideal_cycle)
    if ideal_cycle <= 0 and production_cycle > 0:
        ideal_cycle = production_cycle
    if production_cycle <= 0 and ideal_cycle > 0:
        production_cycle = ideal_cycle

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
        "ideal_cycle_time": ideal_cycle,
        "cycle_time": production_cycle,
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
    if "ideal_cycle_time" in data:
        payload["ideal_cycle_time"] = _non_negative_number(data.get("ideal_cycle_time"), 0)
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


@app.get("/api/planner/cycle-times/harvest-preview")
def api_planner_cycle_times_harvest_preview():
    """Preview planner job cycle times grouped by part+BOM+op (does not change anything)."""
    try:
        return _api_planner_cycle_times_harvest_preview_impl()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _api_planner_cycle_times_publish_impl(data):
    """
    Publish cycle/setup times to master + snapshot.
    Never updates planner_operation on existing scheduled jobs.
    """
    from planning.cycle_time_service import (
        SOURCE_PLANNER_HARVEST,
        SOURCE_PLANNER_JOB,
        publish_cycle_time,
        publish_from_block,
        publish_many,
        planner_db_available,
    )
    from planning.helpers import planner_db
    from planning.utils import compact_text

    if not planner_db_available():
        return jsonify({"error": "SUPA_DB_URL is not set. Direct Postgres is required."}), 503

    block_id = data.get("block_id")
    items = data.get("items")

    try:
        with planner_db() as con:
            if block_id is not None:
                result = publish_from_block(
                    con,
                    int(block_id),
                    notes=compact_text(data.get("notes")),
                )
                return jsonify({"ok": True, "published": [result], "count": 1})
            if isinstance(items, list) and items:
                out = publish_many(
                    con,
                    items,
                    default_source=compact_text(data.get("source_kind") or SOURCE_PLANNER_HARVEST),
                )
                return jsonify({"ok": True, **out})
            if data.get("part_no"):
                result = publish_cycle_time(
                    con,
                    part_no=data.get("part_no") or "",
                    bom_code=data.get("bom_code") or "",
                    stage_no=int(data.get("stage_no") or 0),
                    stage_name=data.get("stage_name") or "",
                    op_no=data.get("op_no"),
                    op_type=data.get("op_type") or "",
                    cycle_time=float(data.get("cycle_time") or 0),
                    set_up_time=float(data.get("set_up_time") or 0),
                    part_description=data.get("part_description") or "",
                    program_no=data.get("program_no") or "",
                    program_file=data.get("program_file") or "",
                    tool_list_file=data.get("tool_list_file") or "",
                    source_kind=compact_text(data.get("source_kind") or SOURCE_PLANNER_JOB),
                    notes=compact_text(data.get("notes")),
                    master_id=data.get("master_id"),
                    source_block_id=data.get("source_block_id"),
                    source_operation_id=data.get("source_operation_id"),
                )
                return jsonify({"ok": True, "published": [result], "count": 1})
        return jsonify({"error": "Provide block_id, items[], or a single part_no payload."}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/publish")
def api_planner_cycle_times_publish():
    data = request.get_json(silent=True) or {}
    return _api_planner_cycle_times_publish_impl(data)


@app.get("/api/trial/blocks/<int:block_id>/cycle-time-context")
def api_trial_block_cycle_time_context(block_id):
    """Read-only cycle time references for a scheduled block."""
    from planning.cycle_time_service import block_cycle_time_context, planner_db_available
    from planning.helpers import planner_db

    if not planner_db_available():
        return jsonify({"error": "SUPA_DB_URL is not set."}), 503
    try:
        with planner_db() as con:
            ctx = block_cycle_time_context(con, block_id)
        if not ctx:
            return jsonify({"error": "block not found"}), 404
        return jsonify(ctx)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/import-new")
def api_planner_cycle_times_import_new():
    """
    Insert new master rows from planner_program_tools and ERP BOM machining steps.
    Existing master rows are never updated or overwritten.
    """
    from planning.cycle_time_master_import import import_new_from_bom_steps, import_new_from_program_tools

    try:
        sheet = import_new_from_program_tools()
        if sheet.get("error"):
            return jsonify(sheet), 503
        bom = import_new_from_bom_steps()
        if bom.get("error"):
            return jsonify(bom), 503
        return jsonify({
            "sheet": sheet,
            "bom_steps": bom,
            "inserted": int(sheet.get("inserted") or 0) + int(bom.get("inserted") or 0),
            "message": (
                f"Sheet: {sheet.get('message', '')} "
                f"BOM steps: {bom.get('message', '')}"
            ).strip(),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/planner/cycle-times/sync")
def api_planner_cycle_times_sync():
    """
    Incremental sync (default): sheet -> planner_program_tools upsert,
    then insert-only new master rows. Never truncates master; never wipes program tools.

    Pass JSON ``{"action": "publish", ...}`` to publish without syncing the sheet.
    """
    from planning.utils import compact_text

    data = request.get_json(silent=True) or {}
    if compact_text(data.get("action")).lower() == "publish":
        return _api_planner_cycle_times_publish_impl(data)

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


@app.post("/api/planner/cycle-times/reset-from-sheet")
def api_planner_cycle_times_reset_from_sheet():
    """
    DESTRUCTIVE one-time reset: sync Excel sheet, wipe master table, reload all rows from program tools.
    Requires JSON body {"confirm": "RESET_FROM_SHEET"}.
    """
    data = request.get_json(silent=True) or {}
    if (data.get("confirm") or "").strip() != "RESET_FROM_SHEET":
        return jsonify({
            "error": 'Confirmation required. Send {"confirm": "RESET_FROM_SHEET"} to proceed.',
        }), 400

    from planning.cycle_time_master_import import reset_master_from_sheet

    try:
        result = reset_master_from_sheet(full_program_tools_refresh=False)
        if result.get("error"):
            status = 503 if "SUPA_DB_URL" in str(result.get("error", "")) else 500
            return jsonify(result), status
        if result.get("program_tools", {}).get("error"):
            return jsonify(result), 500
        if result.get("master", {}).get("error"):
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


# ── Background auto-sync (opt-in) ─────────────────────────────────────────────
# ERP sync normally runs at 08:00 and 13:00 on weekdays via
# scripts/install_erp_sync_scheduler.ps1
# (or manual Sync ERP in the UI). Set ENABLE_AUTO_SYNC=1 to also run the full PP staging
# pipeline every AUTO_SYNC_INTERVAL seconds inside this Flask process, then
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
                from planning.erp_cache_refresh import refresh_after_erp_sync

                refresh_after_erp_sync(warm=True, background=True)
            except Exception as e:
                log.error("post-sync cache refresh error: %s", e)
            try:
                from planning.program_tool_list_route import run_auto_program_tool_list_sync

                run_auto_program_tool_list_sync(log)
            except Exception as e:
                log.error("program-tool-list auto-sync error: %s", e)
            log.info("auto-sync complete")
        except Exception as e:
            log.error("auto-sync error: %s", e)
        time.sleep(AUTO_SYNC_INTERVAL)


_enable_auto_sync = os.getenv("ENABLE_AUTO_SYNC", "").strip().lower() in {
    "1", "true", "yes", "on",
}
if os.environ.get("WERKZEUG_RUN_MAIN") != "false" and _enable_auto_sync:
    _t = threading.Thread(target=_auto_sync_loop, daemon=True, name="auto-sync")
    _t.start()
else:
    log.info(
        "background auto-sync disabled (use scheduled task or ENABLE_AUTO_SYNC=1)"
    )


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
    from planning.mpp_planner_queue_service import run_mpp_auto_dequeue_sweep

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
                mpp_summary = run_mpp_auto_dequeue_sweep(con, dry_run=False)
            unscheduled = int(summary.get("unscheduled") or 0)
            if unscheduled:
                log.info(
                    "auto-unschedule: returned %d done block(s) to catalog (anchor preserved)",
                    unscheduled,
                )
            dequeued = int(mpp_summary.get("dequeued") or 0)
            if dequeued:
                log.info(
                    "auto-unschedule: dequeued %d completed MPP cycle op(s) from machine lanes",
                    dequeued,
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
    repeat_rules = [str(r) for r in app.url_map.iter_rules() if "repeat-orders" in str(r)]
    if repeat_rules:
        log.info("repeat orders routes: %s", ", ".join(repeat_rules))
    else:
        log.warning("repeat orders routes missing — check app.py was saved before restart")
    daily_rules = [str(r) for r in app.url_map.iter_rules() if "daily-output" in str(r)]
    if daily_rules:
        log.info("daily output routes: %s", ", ".join(daily_rules))
    else:
        log.warning("daily output routes missing — restart Flask after pulling latest app.py")
    log.info("daily output page: http://127.0.0.1:%s/daily-output", port)
    log.info("planner: http://127.0.0.1:%s%s", port, PLANNER_PATH)
    log.info("machinist board: http://127.0.0.1:%s%s", port, MACHINIST_BOARD_PATH)
    log.info("QAQC view: http://127.0.0.1:%s%s", port, FINISHING_QUEUE_PATH)
    log.info("driver view: http://127.0.0.1:%s%s", port, DRIVER_VIEW_PATH)
    log.info("MRO app: http://127.0.0.1:%s%s", port, MRO_PATH)
    log.info("accounts receivable: http://127.0.0.1:%s%s", port, ACCOUNTS_PATH)
    if _planner_gate_enabled():
        log.info("planner passcode gate: enabled (POST / then session unlock)")
    else:
        log.warning("planner passcode gate: disabled — set PLANNER_PASSCODE in .env to protect /planner")
    log.info("scheduler asset build: %s", SCHEDULER_ASSET_VERSION)
    try:
        app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)
    except OSError as exc:
        in_use = getattr(exc, "winerror", None) == 10048 or "Address already in use" in str(exc)
        if in_use:
            log.error(
                "Port %s is already in use — stop the other Flask/python process or set FLASK_PORT in .env",
                port,
            )
        raise
