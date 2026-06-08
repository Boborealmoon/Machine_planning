"""Fetch OEE dashboard data from Auk Industries Ops Analytics API."""

from __future__ import annotations

import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

_DEFAULT_API_BASE = "https://api.prod.auk.industries/v1"
_DEFAULT_ENTITY_ID = 393
_DEFAULT_CANVAS_ID = 426
_DEFAULT_FRONTEND_URL = "https://ops.auk.industries/canvas/426"
_MAX_WORKERS = 8
_CNC_RE = re.compile(r"^CNC\s+(\d+)", re.IGNORECASE)

_GROUP_ORDER = (
    ("overall", "Plant overview"),
    ("turning", "Turning"),
    ("milling", "Milling"),
    ("turnmill", "Turn mill"),
    ("mpp", "MPP"),
    ("other", "Other"),
)


def _api_base() -> str:
    return (os.getenv("AUK_API_BASE") or _DEFAULT_API_BASE).rstrip("/")


def _access_token() -> str:
    return (os.getenv("AUK_ACCESS_TOKEN") or "").strip()


def _entity_id() -> int:
    return int(os.getenv("AUK_ENTITY_ID") or _DEFAULT_ENTITY_ID)


def _canvas_id() -> int:
    return int(os.getenv("AUK_CANVAS_ID") or _DEFAULT_CANVAS_ID)


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


def _default_range() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    lower = (now - timedelta(hours=12)).replace(minute=0, second=0, microsecond=0)
    upper = now.replace(minute=0, second=0, microsecond=0)
    return lower.isoformat().replace("+00:00", "Z"), upper.isoformat().replace("+00:00", "Z")


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
    params = {
        "res_x": res_x,
        "res_period": res_period,
        "lower": lower,
        "upper": upper,
    }
    return _get(f"entity/{entity}/block/{block_id}/oee", params)


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


def _classify_card(label: str) -> tuple[str, bool]:
    """Return (group_id, is_group_summary)."""
    text = (label or "").strip()
    lower = text.lower()

    if "overall" in lower or "seletar manufacturing" in lower:
        return "overall", True

    if lower in {"turning", "aps turn", "ps turn"}:
        return "turning", True
    if lower == "milling":
        return "milling", True
    if lower in {"turn mill", "turnmill"}:
        return "turnmill", True
    if lower == "mpp":
        return "mpp", True

    if "(turning)" in lower:
        return "turning", False
    if "(milling)" in lower:
        return "milling", False
    if "(turnmill)" in lower or "(turn mill)" in lower:
        return "turnmill", False

    if "turn" in lower and "mill" in lower:
        return "turnmill", "cnc" not in lower
    if "milling" in lower:
        return "milling", "cnc" not in lower
    if "turning" in lower or lower.endswith(" turn"):
        return "turning", "cnc" not in lower
    if lower == "mpp" or lower.startswith("mpp "):
        return "mpp", True

    return "other", "cnc" not in lower


def _cnc_sort_key(label: str) -> tuple[int, str]:
    match = _CNC_RE.match(label or "")
    if match:
        return (0, int(match.group(1)))
    return (1, (label or "").lower())


def _card_sort_key(card: dict[str, Any]) -> tuple:
    group_id = card.get("group_id") or "other"
    group_rank = next((idx for idx, (gid, _) in enumerate(_GROUP_ORDER) if gid == group_id), 99)
    summary_rank = 0 if card.get("is_group_summary") else 1
    return (group_rank, summary_rank, _cnc_sort_key(card.get("label") or ""))


def _dedupe_overall_summaries(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
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


def _group_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {gid: [] for gid, _ in _GROUP_ORDER}
    for card in cards:
        group_id = card.get("group_id") or "other"
        grouped.setdefault(group_id, []).append(card)

    sections: list[dict[str, Any]] = []
    for group_id, title in _GROUP_ORDER:
        section_cards = grouped.get(group_id) or []
        if not section_cards:
            continue
        oee_values = [float(c["oee_pct"]) for c in section_cards if c.get("oee_pct") is not None]
        avg_oee = round(sum(oee_values) / len(oee_values), 1) if oee_values else None
        sections.append(
            {
                "id": group_id,
                "title": title,
                "count": len(section_cards),
                "avg_oee_pct": avg_oee,
                "cards": section_cards,
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
    group_id, is_group_summary = _classify_card(label)
    title, machine_type = _parse_card_title(label)
    return {
        "widget_id": widget.get("widget_id"),
        "label": label,
        "title": title,
        "machine_type": machine_type,
        "group_id": group_id,
        "is_group_summary": is_group_summary,
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


def fetch_canvas_dashboard(
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
    }


def parse_range_from_request(args: dict[str, Any]) -> tuple[str, str]:
    lower = (args.get("from") or args.get("lower") or "").strip()
    upper = (args.get("to") or args.get("upper") or "").strip()
    if lower and upper:
        return lower, upper
    return _default_range()
