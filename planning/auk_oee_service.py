"""Fetch OEE dashboard data from Auk Industries Ops Analytics API."""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, time, timedelta, timezone
from typing import Any

from .utils import PLANNER_TZ

import requests

_DEFAULT_API_BASE = "https://api.prod.auk.industries/v1"
_DEFAULT_ENTITY_ID = 383
_DEFAULT_PARETO_BLOCK_ID = 5462
_DEFAULT_CANVAS_ID = 426
_DEFAULT_FRONTEND_URL = "https://ops.auk.industries/pareto_analysis/5462"
_MAX_WORKERS = 8
_CNC_RE = re.compile(r"CNC\s+(\d+)", re.IGNORECASE)

# Seletar machine-group mapping (CNC number -> group).
_CNC_GROUP_NUMBERS: dict[str, set[int]] = {
    "mpp": {35, 36},
    "multiaxis": {38, 39, 40, 41},
    "turning": {10, 15, 21, 22, 24, 27, 30, 31, 32},
    "milling": {20, 25, 26, 29},
}

# Auk block summaries — shown for reference, excluded from group averages.
_SUMMARY_LABELS: dict[str, str] = {
    "seletar manufacturing overall": "overall",
    "seletar overall": "overall",
    "turning": "turning",
    "aps turn": "turning",
    "ps turn": "turning",
    "milling": "milling",
    "turn mill": "multiaxis",
    "turnmill": "multiaxis",
    "mpp": "mpp",
}

_GROUP_ORDER = (
    ("overall", "Plant overview"),
    ("turning", "Turning"),
    ("milling", "Milling"),
    ("multiaxis", "Multi-axis"),
    ("mpp", "MPP"),
    ("other", "Other"),
)

_SHIFT_START = time(8, 30)
_SHIFT_END = time(20, 30)

_LOSS_LABELS = {
    "us": "Unscheduled",
    "pd": "Planned downtime",
    "bd": "Breakdowns",
    "st": "Setup / changeover",
    "uu": "Un-utilised",
    "ms": "Minor stops",
    "sl": "Speed loss",
    "ef": "Effective",
    "rj": "Rejects",
    "rw": "Rework",
    "na": "No data",
}


def _api_base() -> str:
    return (os.getenv("AUK_API_BASE") or _DEFAULT_API_BASE).rstrip("/")


def _access_token() -> str:
    return (os.getenv("AUK_ACCESS_TOKEN") or "").strip()


def _entity_id() -> int:
    return int(os.getenv("AUK_ENTITY_ID") or _DEFAULT_ENTITY_ID)


def _canvas_id() -> int:
    return int(os.getenv("AUK_CANVAS_ID") or _DEFAULT_CANVAS_ID)


def _pareto_block_id() -> int:
    return int(os.getenv("AUK_PARETO_BLOCK_ID") or _DEFAULT_PARETO_BLOCK_ID)


def _use_canvas_source() -> bool:
    return (os.getenv("AUK_DATA_SOURCE") or "pareto").strip().lower() == "canvas"


def auk_configured() -> bool:
    return bool(_access_token())


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_access_token()}",
        "X-Frontend-Url": os.getenv("AUK_FRONTEND_URL") or _DEFAULT_FRONTEND_URL,
    }


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    url = f"{_api_base()}/{path.lstrip('/')}"
    response = requests.get(url, headers=_headers(), params=params or {}, timeout=45)
    response.raise_for_status()
    return response.json()


def _sku_oee_enabled() -> bool:
    raw = (os.getenv("AUK_SKU_OEE") or "false").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _auk_range_params(
    lower: str,
    upper: str,
    *,
    res_x: int = 1,
    res_period: str = "hours",
    sku_oee: bool | None = None,
) -> dict[str, Any]:
    """Query params as used by ops.auk.industries (date_range JSON + sku_oee)."""
    sku = _sku_oee_enabled() if sku_oee is None else sku_oee
    return {
        "res_x": res_x,
        "res_period": res_period,
        "date_range": json.dumps({"lower": lower, "upper": upper}, separators=(",", ":")),
        "sku_oee": "true" if sku else "false",
    }


def _to_utc_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _floor_to_minute(dt: datetime) -> datetime:
    return dt.replace(second=0, microsecond=0)


def _shift_start_for_day(day) -> datetime:
    return datetime.combine(day, _SHIFT_START, tzinfo=PLANNER_TZ)


def _shift_end_for_day(day) -> datetime:
    return datetime.combine(day, _SHIFT_END, tzinfo=PLANNER_TZ)


def _active_shift_day(now: datetime | None = None) -> datetime.date:
    now = _floor_to_minute(now or datetime.now(PLANNER_TZ))
    day = now.date()
    if now < _shift_start_for_day(day):
        day -= timedelta(days=1)
    return day


def _shift_upper(now: datetime) -> datetime:
    """End of query window: current minute, capped at today's shift end."""
    now = _floor_to_minute(now)
    shift_end = _shift_end_for_day(now.date())
    return min(now, shift_end)


def _clamp_lower_to_shift_window(lower: datetime, upper: datetime) -> datetime:
    """Keep the lower bound inside 08:30–20:30 blocks (per day in the span)."""
    lower = _floor_to_minute(lower)
    upper = _floor_to_minute(upper)
    if lower >= upper:
        return lower

    day = lower.date()
    end_day = upper.date()
    while day <= end_day:
        block_start = _shift_start_for_day(day)
        block_end = _shift_end_for_day(day)
        if lower < block_start:
            lower = block_start
        if lower <= block_end:
            break
        day += timedelta(days=1)
        lower = _shift_start_for_day(day)
    return lower


def range_for_preset(preset: str, *, now: datetime | None = None) -> tuple[str, str, str]:
    """Build a range aligned with Auk live views (minute precision, shift window)."""
    now = _floor_to_minute(now or datetime.now(PLANNER_TZ))
    preset_key = (preset or "shift").strip().lower()
    upper = _shift_upper(now)

    if preset_key in ("1h", "last_1h", "last-1h"):
        lower = upper - timedelta(hours=1)
        lower = _clamp_lower_to_shift_window(lower, upper)
        return _to_utc_z(lower), _to_utc_z(upper), "last_1h"

    if preset_key in ("24h", "last_24h", "last-24h"):
        lower = upper - timedelta(hours=24)
        lower = _clamp_lower_to_shift_window(lower, upper)
        return _to_utc_z(lower), _to_utc_z(upper), "last_24h"

    shift_day = _active_shift_day(now)
    lower = _shift_start_for_day(shift_day)
    if upper < lower:
        upper = lower
    return _to_utc_z(lower), _to_utc_z(upper), "shift"


def _clamp_upper_to_now(upper: str) -> str:
    """Auk live views never include future time — future hours tank OEE averages."""
    upper_dt = _parse_iso(upper)
    if upper_dt is None:
        return upper
    now = _floor_to_minute(datetime.now(PLANNER_TZ))
    upper_local = _floor_to_minute(upper_dt.astimezone(PLANNER_TZ))
    if upper_local > now:
        return _to_utc_z(now)
    return _to_utc_z(upper_local)


def _default_range() -> tuple[str, str]:
    lower, upper, _ = range_for_preset("shift")
    return lower, upper


def _normalize_custom_range(lower: str, upper: str) -> tuple[str, str, str]:
    """Validate custom bounds; fall back to live shift if invalid or inverted."""
    lower_dt = _parse_iso(lower)
    upper_clamped = _clamp_upper_to_now(upper)
    upper_dt = _parse_iso(upper_clamped)
    if lower_dt is None or upper_dt is None:
        return range_for_preset("shift")
    lower_dt = _floor_to_minute(lower_dt.astimezone(PLANNER_TZ))
    upper_dt = _floor_to_minute(upper_dt.astimezone(PLANNER_TZ))
    if lower_dt >= upper_dt:
        return range_for_preset("shift")
    return _to_utc_z(lower_dt), _to_utc_z(upper_dt), "custom"


def format_auk_http_error(exc: requests.HTTPError) -> tuple[str, int]:
    response = exc.response
    status = response.status_code if response is not None else 502
    raw = (response.text if response is not None else str(exc)) or str(exc)
    message = raw
    try:
        payload = json.loads(raw)
        if isinstance(payload, dict):
            details = payload.get("details")
            detail_text = ""
            if isinstance(details, dict):
                detail_text = "; ".join(
                    f"{key}: {value[0] if isinstance(value, list) and value else value}"
                    for key, value in details.items()
                )
            message = payload.get("message") or payload.get("error") or detail_text or raw
    except ValueError:
        message = raw

    if status == 401:
        return (
            "Auk access token rejected — copy a fresh AUK_ACCESS_TOKEN from ops.auk.industries "
            "localStorage, update .env, and restart the app.",
            401,
        )
    if status == 400:
        return message or "Invalid time range for Auk API.", 400
    return message[:500], 502


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _extract_asset_block_map(node: Any, out: dict[int, int] | None = None) -> dict[int, int]:
    mapping = out if out is not None else {}
    if isinstance(node, dict):
        asset_id = node.get("asset_id")
        block_id = node.get("block_id")
        if asset_id is not None and block_id is not None:
            mapping[int(asset_id)] = int(block_id)
        for value in node.values():
            _extract_asset_block_map(value, mapping)
    elif isinstance(node, list):
        for item in node:
            _extract_asset_block_map(item, mapping)
    return mapping


def fetch_entity_dashboard(
    entity_id: int | None = None,
    *,
    lower: str | None = None,
    upper: str | None = None,
    res_x: int = 1,
    res_period: str = "hours",
) -> dict[str, Any]:
    """Entity catalog used by the Ops Pareto page (blocks, assets, devices)."""
    entity = entity_id if entity_id is not None else _entity_id()
    params: dict[str, Any] = {}
    if lower and upper:
        params = _auk_range_params(lower, upper, res_x=res_x, res_period=res_period)
    data = _get(f"entity/{entity}/dashboard", params)
    return data if isinstance(data, dict) else {}


def fetch_widgets(entity_id: int | None = None, canvas_id: int | None = None) -> list[dict[str, Any]]:
    entity = entity_id if entity_id is not None else _entity_id()
    canvas = canvas_id if canvas_id is not None else _canvas_id()
    data = _get(f"entity/{entity}/canvas/{canvas}/widget")
    return data if isinstance(data, list) else []


def fetch_block_oee(
    block_id: int,
    *,
    lower: str,
    upper: str,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
) -> dict[str, Any]:
    entity = entity_id if entity_id is not None else _entity_id()
    params = _auk_range_params(lower, upper, res_x=res_x, res_period=res_period)
    return _get(f"entity/{entity}/block/{block_id}/oee", params)


def fetch_asset_oee(
    asset_id: int,
    *,
    lower: str,
    upper: str,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
) -> dict[str, Any]:
    entity = entity_id if entity_id is not None else _entity_id()
    params = _auk_range_params(lower, upper, res_x=res_x, res_period=res_period)
    return _get(f"entity/{entity}/asset/{asset_id}/oee", params)


def fetch_asset_chart_data(
    asset_id: int,
    chart_id: int,
    *,
    lower: str,
    upper: str,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
) -> list[dict[str, Any]]:
    entity = entity_id if entity_id is not None else _entity_id()
    params = _auk_range_params(lower, upper, res_x=res_x, res_period=res_period)
    data = _get(f"entity/{entity}/asset/{asset_id}/chart/{chart_id}/data", params)
    return data if isinstance(data, list) else []


def _asset_chart_summaries(asset: dict[str, Any]) -> list[dict[str, Any]]:
    charts: list[dict[str, Any]] = []
    for chart in asset.get("charts") or []:
        chart_id = chart.get("chart_id")
        if chart_id is None:
            continue
        charts.append(
            {
                "chart_id": int(chart_id),
                "title": chart.get("title") or "",
                "chart_type": chart.get("chart_type") or "",
                "units": chart.get("units") or "",
            }
        )
    return charts


def _resolve_block_id(widget: dict[str, Any], asset_map: dict[int, int]) -> int | None:
    binding = widget.get("binding") or {}
    block_id = binding.get("block_id")
    if block_id is not None:
        return int(block_id)
    asset_id = binding.get("asset_id")
    if asset_id is None:
        return None
    return asset_map.get(int(asset_id))


def _overall_block_id_for_mapping(widgets: list[dict[str, Any]]) -> int | None:
    for widget in widgets:
        label = (widget.get("label") or "").lower()
        binding = widget.get("binding") or {}
        block_id = binding.get("block_id")
        if block_id is not None and "overall" in label:
            return int(block_id)
    for widget in widgets:
        binding = widget.get("binding") or {}
        block_id = binding.get("block_id")
        if block_id is not None:
            return int(block_id)
    return None


def _extract_cnc_number(label: str) -> int | None:
    match = _CNC_RE.search(label or "")
    return int(match.group(1)) if match else None


def _group_for_cnc(cnc_number: int) -> str | None:
    for group_id, numbers in _CNC_GROUP_NUMBERS.items():
        if cnc_number in numbers:
            return group_id
    return None


def _classify_card(label: str) -> dict[str, Any]:
    """Classify a canvas tile. Machines are grouped by CNC number; summaries are reference-only."""
    text = (label or "").strip()
    lower = text.lower()

    if "seletar manufacturing" in lower:
        return {
            "group_id": "overall",
            "is_group_summary": True,
            "is_machine": False,
            "cnc_number": None,
        }

    if lower in _SUMMARY_LABELS:
        return {
            "group_id": _SUMMARY_LABELS[lower],
            "is_group_summary": True,
            "is_machine": False,
            "cnc_number": None,
        }

    cnc_number = _extract_cnc_number(text)
    if cnc_number is not None:
        group_id = _group_for_cnc(cnc_number) or "other"
        return {
            "group_id": group_id,
            "is_group_summary": False,
            "is_machine": True,
            "cnc_number": cnc_number,
        }

    if "cnc" in lower:
        return {
            "group_id": "other",
            "is_group_summary": False,
            "is_machine": True,
            "cnc_number": None,
        }

    return {
        "group_id": None,
        "is_group_summary": False,
        "is_machine": False,
        "cnc_number": None,
    }


def _card_sort_key(card: dict[str, Any]) -> tuple:
    group_id = card.get("group_id") or "zzz"
    group_rank = next((idx for idx, (gid, _) in enumerate(_GROUP_ORDER) if gid == group_id), 99)
    summary_rank = 0 if card.get("is_group_summary") else 1
    cnc_number = card.get("cnc_number")
    cnc_rank = int(cnc_number) if cnc_number is not None else 9999
    return (group_rank, summary_rank, cnc_rank, (card.get("label") or "").lower())


def _dedupe_overall_summaries(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Pareto exposes both Seletar Overall and Manufacturing Overall — keep both.
    if not _use_canvas_source():
        return cards

    summaries = [
        card
        for card in cards
        if card.get("group_id") == "overall" and card.get("is_group_summary")
    ]
    if len(summaries) <= 1:
        return cards

    def _summary_rank(card: dict[str, Any]) -> tuple:
        label = (card.get("label") or "").lower()
        return (
            "manufacturing" in label,
            "overall" in label,
            len(label),
            -(card.get("position_y") or 0),
        )

    keep = max(summaries, key=_summary_rank)
    drop_block_ids = {card.get("block_id") for card in summaries if card is not keep}
    return [card for card in cards if card.get("block_id") not in drop_block_ids]


def _dedupe_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one card per block_id — prefer the primary canvas tile (lower row/col)."""
    best_by_block: dict[int, dict[str, Any]] = {}
    unmapped: list[dict[str, Any]] = []

    for card in cards:
        block_id = card.get("block_id")
        if block_id is None:
            unmapped.append(card)
            continue
        block_id = int(block_id)
        existing = best_by_block.get(block_id)
        if existing is None:
            best_by_block[block_id] = card
            continue
        candidate_key = (
            card.get("position_y") or 0,
            card.get("position_x") or 0,
            len(card.get("label") or ""),
        )
        existing_key = (
            existing.get("position_y") or 0,
            existing.get("position_x") or 0,
            len(existing.get("label") or ""),
        )
        if candidate_key < existing_key:
            best_by_block[block_id] = card

    deduped = list(best_by_block.values()) + unmapped
    deduped = _dedupe_overall_summaries(deduped)
    deduped.sort(key=_card_sort_key)
    return deduped


def _section_avg_oee(group_id: str, machines: list[dict[str, Any]], summaries: list[dict[str, Any]]) -> float | None:
    if group_id == "overall":
        for summary in summaries:
            if summary.get("oee_pct") is not None:
                return round(float(summary["oee_pct"]), 2)
        return None

    oee_values = [float(c["oee_pct"]) for c in machines if c.get("oee_pct") is not None]
    if not oee_values:
        return None
    return round(sum(oee_values) / len(oee_values), 2)


def _machine_sort_key(card: dict[str, Any]) -> tuple:
    """Worst OEE first so problem machines are immediately visible."""
    oee = card.get("oee_pct")
    oee_rank = float(oee) if oee is not None else -1.0
    cnc = card.get("cnc_number")
    cnc_rank = int(cnc) if cnc is not None else 9999
    return (oee_rank, cnc_rank, (card.get("label") or "").lower())


def _summary_sort_key(card: dict[str, Any]) -> tuple:
    pareto_root = _pareto_block_id()
    block_id = card.get("block_id")
    is_pareto_root = block_id is not None and int(block_id) == pareto_root
    return (0 if is_pareto_root else 1, (card.get("label") or "").lower())


def _group_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {gid: [] for gid, _ in _GROUP_ORDER}
    for card in cards:
        group_id = card.get("group_id")
        if not group_id:
            continue
        grouped.setdefault(group_id, []).append(card)

    sections: list[dict[str, Any]] = []
    for group_id, title in _GROUP_ORDER:
        section_cards = grouped.get(group_id) or []
        if not section_cards:
            continue

        summaries = sorted(
            [c for c in section_cards if c.get("is_group_summary")],
            key=_summary_sort_key,
        )
        machines = sorted(
            [c for c in section_cards if c.get("is_machine")],
            key=_machine_sort_key,
        )

        sections.append(
            {
                "id": group_id,
                "title": title,
                "count": len(machines),
                "summary_count": len(summaries),
                "avg_oee_pct": _section_avg_oee(group_id, machines, summaries),
                "summaries": summaries,
                "machines": machines,
                "cards": summaries + machines,
            }
        )
    return sections


def _parse_card_title(label: str) -> tuple[str, str | None]:
    text = (label or "Untitled").strip()
    match = re.match(r"^(CNC\s+\d+)\s*\(([^)]+)\)\s*$", text, re.IGNORECASE)
    if match:
        return match.group(1), match.group(2).strip()
    return text, None


def _card_from_widget(
    widget: dict[str, Any],
    oee_payload: dict[str, Any] | None,
    *,
    error: str | None = None,
) -> dict[str, Any]:
    overall = (oee_payload or {}).get("overall") or {}
    label = widget.get("label") or "Untitled"
    classification = _classify_card(label)
    title, machine_type = _parse_card_title(label)
    return {
        "widget_id": widget.get("widget_id"),
        "label": label,
        "title": title,
        "machine_type": machine_type,
        "group_id": classification["group_id"],
        "is_group_summary": classification["is_group_summary"],
        "is_machine": classification["is_machine"],
        "cnc_number": classification["cnc_number"],
        "position_x": int(widget.get("position_x") or 0),
        "position_y": int(widget.get("position_y") or 0),
        "block_id": (oee_payload or {}).get("block_id") or (widget.get("binding") or {}).get("block_id"),
        "asset_id": (widget.get("binding") or {}).get("asset_id"),
        "oee_pct": _round_pct(overall.get("final_effective")),
        "loading_pct": _round_pct(overall.get("loading")),
        "availability_pct": _round_pct(overall.get("availability")),
        "performance_pct": _round_pct(overall.get("performance")),
        "quality_pct": _round_pct(overall.get("quality")),
        "error": error,
    }


def _round_pct(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


_LOSS_KEYS = ("us", "pd", "bd", "st", "uu", "ms", "sl", "ef", "rj", "rw", "na")


def _loss_averages(oee_slots: list[dict[str, Any]] | None) -> dict[str, float]:
    sums = {key: 0.0 for key in _LOSS_KEYS}
    count = 0
    for slot in oee_slots or []:
        oee = (slot or {}).get("oee") or {}
        if not oee:
            continue
        count += 1
        for key in _LOSS_KEYS:
            sums[key] += float(oee.get(key) or 0)
    if count == 0:
        return {}
    return {key: round(sums[key] / count, 2) for key in _LOSS_KEYS}


def _dashboard_indexes(
    dashboard: dict[str, Any],
) -> tuple[dict[int, dict[str, Any]], dict[int, dict[str, Any]], dict[int, dict[str, Any]]]:
    blocks_by_id: dict[int, dict[str, Any]] = {}
    for block in dashboard.get("blocks") or []:
        block_id = block.get("block_id")
        if block_id is not None:
            blocks_by_id[int(block_id)] = block

    assets_by_id: dict[int, dict[str, Any]] = {}
    assets_by_block: dict[int, dict[str, Any]] = {}
    for asset in dashboard.get("assets") or []:
        asset_id = asset.get("asset_id")
        if asset_id is not None:
            assets_by_id[int(asset_id)] = asset
        block = asset.get("block") or {}
        block_id = block.get("block_id")
        if block_id is not None:
            assets_by_block[int(block_id)] = asset

    return blocks_by_id, assets_by_id, assets_by_block


def _label_for_block_id(
    block_id: int,
    blocks_by_id: dict[int, dict[str, Any]],
    assets_by_block: dict[int, dict[str, Any]],
    assets_by_id: dict[int, dict[str, Any]],
    node: dict[str, Any] | None = None,
) -> str:
    block = blocks_by_id.get(int(block_id)) or {}
    name = (block.get("block_name") or "").strip()
    if name:
        return name

    asset = assets_by_block.get(int(block_id))
    if asset and asset.get("asset_name"):
        return str(asset["asset_name"]).strip()

    asset_id = block.get("asset_id") or (node or {}).get("asset_id")
    if asset_id is not None:
        linked = assets_by_id.get(int(asset_id))
        if linked and linked.get("asset_name"):
            return str(linked["asset_name"]).strip()

    return f"Block {block_id}"


def _card_metrics_from_oee_payload(
    payload: dict[str, Any] | None,
    *,
    label: str,
    block_id: int | None,
    asset_id: int | None,
    classification: dict[str, Any],
    position_x: int = 0,
    position_y: int = 0,
    source: str,
    error: str | None = None,
) -> dict[str, Any]:
    overall = (payload or {}).get("overall") or {}
    losses = _loss_averages((payload or {}).get("oee") or [])
    title, machine_type = _parse_card_title(label)
    std_time = (payload or {}).get("stdTime")
    return {
        "widget_id": None,
        "label": label,
        "title": title,
        "machine_type": machine_type,
        "group_id": classification["group_id"],
        "is_group_summary": classification["is_group_summary"],
        "is_machine": classification["is_machine"],
        "cnc_number": classification["cnc_number"],
        "position_x": position_x,
        "position_y": position_y,
        "block_id": block_id,
        "asset_id": asset_id,
        "oee_pct": _round_pct(overall.get("final_effective")),
        "loading_pct": _round_pct(overall.get("loading")),
        "availability_pct": _round_pct(overall.get("availability")),
        "performance_pct": _round_pct(overall.get("performance")),
        "quality_pct": _round_pct(overall.get("quality")),
        "yield_pct": _round_pct(overall.get("yield")),
        "unutilised_pct": losses.get("uu"),
        "effective_pct": losses.get("ef"),
        "losses": losses,
        "std_time_hrs": round(float(std_time), 2) if std_time is not None else None,
        "hourly_slots": len((payload or {}).get("oee") or []),
        "source": source,
        "error": error,
    }


def _card_from_pareto_node(
    node: dict[str, Any],
    label: str,
    block_id: int,
    *,
    blocks_by_id: dict[int, dict[str, Any]],
    assets_by_block: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    classification = _classify_card(label)
    block_meta = blocks_by_id.get(int(block_id)) or {}
    asset = assets_by_block.get(int(block_id)) or {}
    return _card_metrics_from_oee_payload(
        node,
        label=label,
        block_id=block_id,
        asset_id=block_meta.get("asset_id") or asset.get("asset_id") or node.get("asset_id"),
        classification=classification,
        position_x=int(block_meta.get("order") or 0),
        position_y=int(block_meta.get("hierarchy_level") or 0),
        source="pareto",
    )


def _card_from_asset(
    asset: dict[str, Any],
    payload: dict[str, Any] | None,
    *,
    error: str | None = None,
) -> dict[str, Any]:
    label = (asset.get("asset_name") or "Untitled").strip()
    classification = _classify_card(label)
    block_id = (asset.get("block") or {}).get("block_id")
    card = _card_metrics_from_oee_payload(
        payload,
        label=label,
        block_id=int(block_id) if block_id is not None else None,
        asset_id=asset.get("asset_id"),
        classification=classification,
        position_x=0,
        position_y=0,
        source="asset",
        error=error,
    )
    card["charts"] = _asset_chart_summaries(asset)
    return card


def _fetch_asset_machine_cards(
    assets: list[dict[str, Any]],
    *,
    entity: int,
    lower: str,
    upper: str,
    res_x: int,
    res_period: str,
) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    errors: dict[int, str] = {}

    def _load(asset: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
        asset_id = asset.get("asset_id")
        if asset_id is None:
            return asset, None, "Missing asset_id"
        asset_id = int(asset_id)
        try:
            payload = fetch_asset_oee(
                asset_id,
                lower=lower,
                upper=upper,
                res_x=res_x,
                res_period=res_period,
                entity_id=entity,
            )
            return asset, payload, None
        except requests.RequestException as exc:
            return asset, None, str(exc)

    if not assets:
        return cards

    workers = min(_MAX_WORKERS, len(assets))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_load, asset) for asset in assets]
        for future in as_completed(futures):
            asset, payload, error = future.result()
            asset_id = int(asset["asset_id"])
            if error:
                errors[asset_id] = error
            cards.append(_card_from_asset(asset, payload, error=error))

    cards.sort(key=_card_sort_key)
    return cards


def _walk_pareto_tree(
    node: dict[str, Any],
    blocks_by_id: dict[int, dict[str, Any]],
    assets_by_id: dict[int, dict[str, Any]],
    assets_by_block: dict[int, dict[str, Any]],
    cards: list[dict[str, Any]],
    *,
    summaries_only: bool = False,
) -> None:
    block_id = node.get("block_id")
    if block_id is not None and node.get("overall"):
        label = _label_for_block_id(
            int(block_id),
            blocks_by_id,
            assets_by_block,
            assets_by_id,
            node,
        )
        classification = _classify_card(label)
        if not summaries_only or classification["is_group_summary"]:
            cards.append(
                _card_from_pareto_node(
                    node,
                    label,
                    int(block_id),
                    blocks_by_id=blocks_by_id,
                    assets_by_block=assets_by_block,
                )
            )
    for child in node.get("children") or []:
        if isinstance(child, dict):
            _walk_pareto_tree(
                child,
                blocks_by_id,
                assets_by_id,
                assets_by_block,
                cards,
                summaries_only=summaries_only,
            )


def fetch_pareto_dashboard(
    *,
    lower: str | None = None,
    upper: str | None = None,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
    pareto_block_id: int | None = None,
) -> dict[str, Any]:
    if not auk_configured():
        raise RuntimeError("AUK_ACCESS_TOKEN is not configured")

    if not lower or not upper:
        lower, upper = _default_range()

    entity = entity_id if entity_id is not None else _entity_id()
    pareto_block = pareto_block_id if pareto_block_id is not None else _pareto_block_id()

    dashboard = fetch_entity_dashboard(
        entity_id=entity,
        lower=lower,
        upper=upper,
        res_x=res_x,
        res_period=res_period,
    )
    blocks_by_id, assets_by_id, assets_by_block = _dashboard_indexes(dashboard)
    try:
        root = fetch_block_oee(
            pareto_block,
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
            entity_id=entity,
        )
    except requests.RequestException as exc:
        raise RuntimeError(
            f"Failed to load Pareto block {pareto_block} for entity {entity}. "
            f"Check AUK_ENTITY_ID=383 and AUK_PARETO_BLOCK_ID=5462. ({exc})"
        ) from exc

    assets = dashboard.get("assets") or []
    summary_cards: list[dict[str, Any]] = []
    _walk_pareto_tree(
        root,
        blocks_by_id,
        assets_by_id,
        assets_by_block,
        summary_cards,
        summaries_only=True,
    )
    machine_cards = _fetch_asset_machine_cards(
        assets,
        entity=entity,
        lower=lower,
        upper=upper,
        res_x=res_x,
        res_period=res_period,
    )

    cards = _dedupe_cards(summary_cards) + machine_cards
    cards = [card for card in cards if card.get("group_id")]
    groups = _group_cards(cards)
    machine_count = sum(1 for card in cards if card.get("is_machine"))
    asset_errors = [card for card in machine_cards if card.get("error")]
    warning = None
    if machine_count == 0:
        warning = (
            f"No machine OEE returned for entity {entity}. "
            "Set AUK_ENTITY_ID=383 in .env and restart the app."
        )
    elif asset_errors and len(asset_errors) == len(machine_cards):
        warning = "All machine OEE requests failed — check AUK_ACCESS_TOKEN."

    return {
        "entity_id": entity,
        "pareto_block_id": pareto_block,
        "source": "pareto",
        "from": lower,
        "to": upper,
        "res_x": res_x,
        "res_period": res_period,
        "cards": cards,
        "groups": groups,
        "block_count": len(dashboard.get("blocks") or []),
        "asset_count": len(assets),
        "machine_count": machine_count,
        "asset_error_count": len(asset_errors),
        "card_count": len(cards),
        "warning": warning,
        "auk_block_oee_url": (
            f"{_api_base()}/entity/{entity}/block/{pareto_block}/oee"
            f"?{requests.compat.urlencode(_auk_range_params(lower, upper, res_x=res_x, res_period=res_period))}"
        ),
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def _fetch_canvas_dashboard(
    *,
    lower: str | None = None,
    upper: str | None = None,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
    canvas_id: int | None = None,
) -> dict[str, Any]:
    if not auk_configured():
        raise RuntimeError("AUK_ACCESS_TOKEN is not configured")

    if not lower or not upper:
        lower, upper = _default_range()

    entity = entity_id if entity_id is not None else _entity_id()
    canvas = canvas_id if canvas_id is not None else _canvas_id()
    widgets = fetch_widgets(entity_id=entity, canvas_id=canvas)

    asset_map: dict[int, int] = {}
    mapping_block_id = _overall_block_id_for_mapping(widgets)
    if mapping_block_id is not None:
        try:
            mapping_payload = fetch_block_oee(
                mapping_block_id,
                lower=lower,
                upper=upper,
                res_x=res_x,
                res_period=res_period,
                entity_id=entity,
            )
            asset_map = _extract_asset_block_map(mapping_payload)
        except requests.RequestException:
            asset_map = {}

    resolved: list[tuple[dict[str, Any], int | None]] = []
    for widget in widgets:
        block_id = _resolve_block_id(widget, asset_map)
        resolved.append((widget, block_id))

    block_ids = sorted({block_id for _, block_id in resolved if block_id is not None})
    oee_by_block: dict[int, dict[str, Any]] = {}
    errors: dict[int, str] = {}

    def _load(block_id: int) -> tuple[int, dict[str, Any] | None, str | None]:
        try:
            payload = fetch_block_oee(
                block_id,
                lower=lower,
                upper=upper,
                res_x=res_x,
                res_period=res_period,
                entity_id=entity,
            )
            return block_id, payload, None
        except requests.RequestException as exc:
            return block_id, None, str(exc)

    if block_ids:
        workers = min(_MAX_WORKERS, len(block_ids))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_load, block_id) for block_id in block_ids]
            for future in as_completed(futures):
                block_id, payload, error = future.result()
                if payload is not None:
                    oee_by_block[block_id] = payload
                if error:
                    errors[block_id] = error

    cards: list[dict[str, Any]] = []
    for widget, block_id in resolved:
        if block_id is None:
            cards.append(_card_from_widget(widget, None, error="No block mapping for widget"))
            continue
        payload = oee_by_block.get(block_id)
        cards.append(
            _card_from_widget(
                widget,
                payload,
                error=errors.get(block_id) if payload is None else None,
            )
        )

    cards = _dedupe_cards(cards)
    cards = [card for card in cards if card.get("group_id")]
    groups = _group_cards(cards)

    return {
        "entity_id": entity,
        "canvas_id": canvas,
        "from": lower,
        "to": upper,
        "res_x": res_x,
        "res_period": res_period,
        "cards": cards,
        "groups": groups,
        "widget_count": len(widgets),
        "card_count": len(cards),
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "canvas",
    }


def fetch_canvas_dashboard(
    *,
    lower: str | None = None,
    upper: str | None = None,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
    canvas_id: int | None = None,
) -> dict[str, Any]:
    if _use_canvas_source():
        return _fetch_canvas_dashboard(
            lower=lower,
            upper=upper,
            res_x=res_x,
            res_period=res_period,
            entity_id=entity_id,
            canvas_id=canvas_id,
        )
    return fetch_pareto_dashboard(
        lower=lower,
        upper=upper,
        res_x=res_x,
        res_period=res_period,
        entity_id=entity_id,
    )


def parse_range_from_request(args: dict[str, Any]) -> tuple[str, str, str]:
    preset = (args.get("preset") or "").strip().lower()
    if preset and preset not in ("custom",):
        lower, upper, preset_key = range_for_preset(preset)
        return lower, upper, preset_key

    lower = (args.get("from") or args.get("lower") or "").strip()
    upper = (args.get("to") or args.get("upper") or "").strip()
    if lower and upper:
        return _normalize_custom_range(lower, upper)
    return range_for_preset("shift")


_METRIC_MAP = {
    "final_effective": "oee_pct",
    "loading": "loading_pct",
    "availability": "availability_pct",
    "performance": "performance_pct",
    "quality": "quality_pct",
}


def _walk_raw_oee(node: dict[str, Any], out: dict[int, dict[str, Any]]) -> None:
    block_id = node.get("block_id")
    if block_id is not None and node.get("overall"):
        out[int(block_id)] = {
            "overall": node.get("overall") or {},
            "uu_avg": _loss_averages(node.get("oee") or {}).get("uu"),
        }
    for child in node.get("children") or []:
        if isinstance(child, dict):
            _walk_raw_oee(child, out)


def _block_name_map(dashboard: dict[str, Any], cards: list[dict[str, Any]]) -> dict[int, str]:
    names: dict[int, str] = {}
    for block in dashboard.get("blocks") or []:
        block_id = block.get("block_id")
        if block_id is not None:
            names[int(block_id)] = (block.get("block_name") or "").strip()
    for asset in dashboard.get("assets") or []:
        block = asset.get("block") or {}
        block_id = block.get("block_id")
        if block_id is not None and not names.get(int(block_id)):
            names[int(block_id)] = (asset.get("asset_name") or "").strip()
    for card in cards:
        block_id = card.get("block_id")
        if block_id is not None and not names.get(int(block_id)):
            names[int(block_id)] = card.get("label") or ""
    return names


def validate_pareto_dashboard(
    *,
    lower: str | None = None,
    upper: str | None = None,
    res_x: int = 1,
    res_period: str = "hours",
    entity_id: int | None = None,
    pareto_block_id: int | None = None,
    tolerance: float = 0.05,
) -> dict[str, Any]:
    """Compare our dashboard cards against raw Auk Pareto block/oee payloads."""
    if not auk_configured():
        raise RuntimeError("AUK_ACCESS_TOKEN is not configured")

    if not lower or not upper:
        lower, upper = _default_range()

    entity = entity_id if entity_id is not None else _entity_id()
    pareto_block = pareto_block_id if pareto_block_id is not None else _pareto_block_id()

    app = fetch_pareto_dashboard(
        lower=lower,
        upper=upper,
        res_x=res_x,
        res_period=res_period,
        entity_id=entity,
        pareto_block_id=pareto_block,
    )
    dashboard = fetch_entity_dashboard(
        entity_id=entity,
        lower=lower,
        upper=upper,
        res_x=res_x,
        res_period=res_period,
    )
    names = _block_name_map(dashboard, app.get("cards") or [])

    raw_root = fetch_block_oee(
        pareto_block,
        lower=lower,
        upper=upper,
        res_x=res_x,
        res_period=res_period,
        entity_id=entity,
    )
    raw_by_block: dict[int, dict[str, Any]] = {}
    _walk_raw_oee(raw_root, raw_by_block)

    app_by_block = {
        int(card["block_id"]): card
        for card in app.get("cards") or []
        if card.get("block_id") is not None
    }

    rows: list[dict[str, Any]] = []
    matched = 0
    for block_id in sorted(raw_by_block):
        raw_overall = raw_by_block[block_id]["overall"]
        label = names.get(block_id) or f"Block {block_id}"
        app_card = app_by_block.get(block_id)
        row: dict[str, Any] = {
            "block_id": block_id,
            "label": label,
            "in_app": app_card is not None,
            "metrics": {},
            "uu": {
                "auk": raw_by_block[block_id].get("uu_avg"),
                "app": app_card.get("unutilised_pct") if app_card else None,
            },
        }
        row_ok = app_card is not None
        for raw_key, app_key in _METRIC_MAP.items():
            raw_val = round(float(raw_overall.get(raw_key) or 0), 2)
            app_val = app_card.get(app_key) if app_card else None
            delta = None if app_val is None else round(float(app_val) - raw_val, 3)
            ok = app_val is not None and abs(delta or 0) <= tolerance
            if not ok:
                row_ok = False
            row["metrics"][raw_key] = {
                "auk": raw_val,
                "app": app_val,
                "delta": delta,
                "ok": ok,
            }
        uu_auk = row["uu"]["auk"]
        uu_app = row["uu"]["app"]
        row["uu"]["ok"] = (
            uu_auk is None
            or uu_app is None
            or abs(float(uu_app) - float(uu_auk)) <= tolerance
        )
        if row_ok and row["uu"]["ok"]:
            matched += 1
        rows.append(row)

    overall_group = next((g for g in app.get("groups") or [] if g.get("id") == "overall"), {})
    summaries = overall_group.get("summaries") or []
    hero = summaries[0] if summaries else None
    hero_block_id = int(hero["block_id"]) if hero and hero.get("block_id") else None

    root_raw = raw_by_block.get(pareto_block, {}).get("overall") or {}
    root_app = app_by_block.get(pareto_block)
    hero_raw = raw_by_block.get(hero_block_id, {}).get("overall") if hero_block_id else {}

    return {
        "range": {"from": lower, "to": upper},
        "entity_id": entity,
        "pareto_block_id": pareto_block,
        "pareto_url": (
            f"https://ops.auk.industries/pareto_analysis/{pareto_block}"
            f"?from={lower}&to={upper}&res_x={res_x}&res_period={res_period}"
            f"&span=12+hours&entity_id={entity}"
        ),
        "auk_block_oee_url": (
            f"{_api_base()}/entity/{entity}/block/{pareto_block}/oee"
            f"?{requests.compat.urlencode(_auk_range_params(lower, upper, res_x=res_x, res_period=res_period))}"
        ),
        "summary": {
            "raw_nodes": len(raw_by_block),
            "app_cards": len(app_by_block),
            "matched_rows": matched,
            "mismatched_rows": len(rows) - matched,
            "missing_in_app": [row for row in rows if not row["in_app"]],
            "all_ok": matched == len(rows),
        },
        "plant_oee": {
            "pareto_root_label": names.get(pareto_block) or "Seletar Overall",
            "auk_oee2": round(float(root_raw.get("final_effective") or 0), 2),
            "app_oee2": root_app.get("oee_pct") if root_app else None,
            "hero_block_id": hero_block_id,
            "hero_label": hero.get("label") if hero else None,
            "hero_oee2": round(float(hero_raw.get("final_effective") or 0), 2) if hero_raw else None,
            "hero_matches_pareto_root": hero_block_id == pareto_block,
        },
        "rows": rows,
    }
