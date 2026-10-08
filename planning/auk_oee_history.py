"""Persist Seletar OEE samples and the shared canvas layout.

Day-to-date donuts stay on Auk's 15-minute aggregate. This module stores
those closed buckets for the day chart, and a short 1-minute series so a
low-OEE notice can fire before the quarter hour ends.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from .auk_oee_service import (
    _parse_iso,
    _slots_for_site_row,
    fetch_site_oee,
    overall_from_oee_slots,
)
from .helpers import planner_db, rows

logger = logging.getLogger(__name__)

BUCKET_GRAIN = "bucket"
MINUTE_GRAIN = "minute"
MINUTE_KEEP_MINUTES = 5
MINUTE_LOOKBACK_MINUTES = 30
BUCKET_RETENTION_DAYS = 90
MINUTE_RETENTION_DAYS = 14
ALERT_MINUTES = (5, 10, 15, 30)
DEFAULT_ALERT_MINUTES = 10
MACHINE_OEE_LIMIT = 40.0
MACHINE_LOADING_MIN = 50.0
PLANT_OEE_LIMIT = 50.0
WIDGET_TYPES = ("card", "today", "lowest", "report")
CARD_COLORS = ("red", "amber", "green", "blue", "violet", "slate")

_SCHEMA_READY = False
_SCHEMA_LOCK = threading.Lock()


def is_plant_card(card: dict[str, Any]) -> bool:
    label = (card.get("label") or "").lower()
    return bool(card.get("is_group_summary")) and "manufacturing" in label


def slot_bucket_start(slot: dict[str, Any]) -> datetime | None:
    raw = slot.get("time")
    if raw is None:
        raw = slot.get("timestamp") or slot.get("ts")
    if isinstance(raw, (int, float)):
        seconds = float(raw)
        if seconds > 10_000_000_000:
            seconds /= 1000.0
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    if isinstance(raw, str) and raw.strip():
        parsed = _parse_iso(raw)
        if parsed is None:
            return None
        return parsed.astimezone(timezone.utc)
    return None


def slots_are_minutes(site_rows: list[dict[str, Any]]) -> bool:
    for row in site_rows:
        for slot in _slots_for_site_row(row)[:3]:
            try:
                interval = float(slot.get("int") or 0)
            except (TypeError, ValueError):
                continue
            if interval <= 0:
                continue
            return interval <= 120_000
    return False


def samples_from_site_rows(
    site_rows: list[dict[str, Any]],
    cards_by_equipment: dict[int, dict[str, Any]],
    *,
    grain: str,
) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for row in site_rows:
        try:
            equipment_id = int(row.get("equipment_id"))
        except (TypeError, ValueError):
            continue
        card = cards_by_equipment.get(equipment_id) or {}
        plant = is_plant_card(card)
        for slot in _slots_for_site_row(row):
            start = slot_bucket_start(slot)
            overall = overall_from_oee_slots([slot])
            if start is None or not overall:
                continue
            samples.append(
                {
                    "equipment_id": equipment_id,
                    "bucket_start": start,
                    "grain": grain,
                    "label": card.get("label") or "",
                    "group_id": card.get("group_id") or "",
                    "is_plant": plant,
                    "is_machine": bool(card.get("is_machine")),
                    "oee_pct": overall["final_effective"],
                    "loading_pct": overall["loading"],
                    "availability_pct": overall["availability"],
                    "performance_pct": overall["performance"],
                    "quality_pct": overall["quality"],
                    "day_oee_pct": card.get("oee_pct") if plant else None,
                }
            )
    return samples


def poll_snapshots(
    site_rows: list[dict[str, Any]],
    cards_by_equipment: dict[int, dict[str, Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    """One row per equipment at the current minute, from the open slot."""
    minute = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    snapshots: list[dict[str, Any]] = []
    for row in site_rows:
        try:
            equipment_id = int(row.get("equipment_id"))
        except (TypeError, ValueError):
            continue
        slots = _slots_for_site_row(row)
        if not slots:
            continue
        overall = overall_from_oee_slots([slots[-1]])
        if not overall:
            continue
        card = cards_by_equipment.get(equipment_id) or {}
        plant = is_plant_card(card)
        snapshots.append(
            {
                "equipment_id": equipment_id,
                "bucket_start": minute,
                "grain": MINUTE_GRAIN,
                "label": card.get("label") or "",
                "group_id": card.get("group_id") or "",
                "is_plant": plant,
                "is_machine": bool(card.get("is_machine")),
                "oee_pct": overall["final_effective"],
                "loading_pct": overall["loading"],
                "availability_pct": overall["availability"],
                "performance_pct": overall["performance"],
                "quality_pct": overall["quality"],
                "day_oee_pct": card.get("oee_pct") if plant else None,
            }
        )
    return snapshots


def latest_slot_samples(samples: list[dict[str, Any]], *, per_equipment: int = 2) -> list[dict[str, Any]]:
    """Keep the newest slots even when the API upper bound lags the clock."""
    grouped: dict[int, list[dict[str, Any]]] = {}
    for sample in samples:
        grouped.setdefault(int(sample["equipment_id"]), []).append(sample)
    kept: list[dict[str, Any]] = []
    for group in grouped.values():
        group.sort(key=lambda sample: sample["bucket_start"])
        kept.extend(group[-per_equipment:])
    return kept


def recent_samples(
    samples: list[dict[str, Any]],
    *,
    now: datetime,
    minutes: int,
) -> list[dict[str, Any]]:
    cutoff = now.astimezone(timezone.utc) - timedelta(minutes=minutes)
    kept = []
    for sample in samples:
        start = sample["bucket_start"]
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if start >= cutoff:
            kept.append(sample)
    return kept


def default_layout_from_cards(
    cards: list[dict[str, Any]],
    *,
    alert_minutes: int = DEFAULT_ALERT_MINUTES,
) -> dict[str, Any]:
    ordered = sorted(
        cards,
        key=lambda card: (
            int(card.get("position_y") or 0),
            int(card.get("position_x") or 0),
            int(card.get("equipment_id") or 0),
        ),
    )
    items: list[dict[str, Any]] = []
    seen: set[int] = set()
    for card in ordered:
        equipment_id = card.get("equipment_id")
        if equipment_id is None:
            continue
        try:
            equipment_id = int(equipment_id)
        except (TypeError, ValueError):
            continue
        if equipment_id in seen:
            continue
        seen.add(equipment_id)
        index = len(items)
        items.append(
            {
                "id": f"card-{equipment_id}",
                "type": "card",
                "equipment_id": equipment_id,
                "x": (index % 6) * 2,
                "y": index // 6,
                "w": 2,
                "h": 1,
            }
        )
    base_y = (len(items) + 5) // 6
    items.extend(
        [
            {"id": "today", "type": "today", "x": 0, "y": base_y, "w": 6, "h": 2},
            {"id": "lowest", "type": "lowest", "x": 6, "y": base_y, "w": 3, "h": 2},
            {"id": "report", "type": "report", "x": 9, "y": base_y, "w": 3, "h": 2},
        ]
    )
    return {
        "columns": 12,
        "alert_minutes": _alert_minutes(alert_minutes),
        "items": items,
    }


def normalize_layout(data: dict[str, Any] | None) -> dict[str, Any]:
    raw = data if isinstance(data, dict) else {}
    items: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for entry in raw.get("items") or []:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("type") or "")
        if kind not in WIDGET_TYPES:
            continue
        try:
            x = int(entry.get("x") or 0)
            y = int(entry.get("y") or 0)
            w = int(entry.get("w") or (4 if kind != "card" else 2))
            h = int(entry.get("h") or (2 if kind != "card" else 1))
        except (TypeError, ValueError):
            continue
        min_h = 1 if kind == "card" else 2
        w = max(2, min(12, w))
        h = max(min_h, min(4, h))
        x = max(0, min(11, x))
        y = max(0, min(80, y))
        if x + w > 12:
            x = 12 - w
        item: dict[str, Any] = {"type": kind, "x": x, "y": y, "w": w, "h": h}
        color = str(entry.get("color") or "")
        if kind == "card" and color in CARD_COLORS:
            item["color"] = color
        if kind == "card":
            try:
                item["equipment_id"] = int(entry.get("equipment_id"))
            except (TypeError, ValueError):
                continue
            item["id"] = f"card-{item['equipment_id']}"
        else:
            item["id"] = kind
        if item["id"] in seen_ids:
            continue
        seen_ids.add(item["id"])
        items.append(item)
    return {
        "columns": 12,
        "alert_minutes": _alert_minutes(raw.get("alert_minutes")),
        "items": items,
    }


def low_oee_notices(
    samples: list[dict[str, Any]],
    *,
    minutes: int,
    now: datetime,
    machine_oee: float = MACHINE_OEE_LIMIT,
    machine_loading: float = MACHINE_LOADING_MIN,
    plant_oee: float = PLANT_OEE_LIMIT,
) -> list[dict[str, Any]]:
    """List equipment that stayed low for the whole watch window.

    A machine counts only when it was loaded. Idle CNCs stay off the list.
    The window must actually be covered: the earliest sample sits at the
    start, the latest is current, and most of the minutes are present.
    """
    minutes = _alert_minutes(minutes)
    now = now.astimezone(timezone.utc)
    cutoff = now - timedelta(minutes=minutes)
    grouped: dict[int, list[dict[str, Any]]] = {}
    for sample in samples:
        start = sample.get("bucket_start")
        if not isinstance(start, datetime):
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if start < cutoff or start > now + timedelta(seconds=5):
            continue
        try:
            equipment_id = int(sample["equipment_id"])
        except (TypeError, ValueError, KeyError):
            continue
        grouped.setdefault(equipment_id, []).append(sample)

    notices: list[dict[str, Any]] = []
    minimum_count = max(2, int(minutes * 0.6))
    for equipment_id, group in grouped.items():
        group.sort(key=lambda sample: sample["bucket_start"])
        first = group[0]["bucket_start"]
        last = group[-1]["bucket_start"]
        if first.tzinfo is None:
            first = first.replace(tzinfo=timezone.utc)
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if first > cutoff + timedelta(minutes=1):
            continue
        if now - last > timedelta(seconds=180):
            continue
        if len(group) < minimum_count:
            continue
        latest = group[-1]
        if latest.get("is_plant"):
            if any(_num(sample.get("oee_pct")) >= plant_oee for sample in group):
                continue
            kind = "plant"
            limit = plant_oee
        elif latest.get("is_machine"):
            if any(
                _num(sample.get("oee_pct")) >= machine_oee
                or _num(sample.get("loading_pct")) <= machine_loading
                for sample in group
            ):
                continue
            kind = "machine"
            limit = machine_oee
        else:
            continue
        notices.append(
            {
                "equipment_id": equipment_id,
                "label": latest.get("label") or "",
                "kind": kind,
                "oee_pct": _num(latest.get("oee_pct")),
                "loading_pct": _num(latest.get("loading_pct")),
                "minutes": round((now - first).total_seconds() / 60.0, 1),
                "limit": limit,
            }
        )
    notices.sort(key=lambda notice: (notice["kind"] != "plant", notice["oee_pct"], notice["label"]))
    return notices


def _sample_is_low(
    sample: dict[str, Any],
    *,
    machine_oee: float,
    machine_loading: float,
    plant_oee: float,
) -> bool:
    if sample.get("is_plant"):
        return _num(sample.get("oee_pct")) < plant_oee
    if sample.get("is_machine"):
        return (
            _num(sample.get("oee_pct")) < machine_oee
            and _num(sample.get("loading_pct")) > machine_loading
        )
    return False


def current_low_streaks(
    samples: list[dict[str, Any]],
    *,
    minutes: int,
    now: datetime,
    machine_oee: float = MACHINE_OEE_LIMIT,
    machine_loading: float = MACHINE_LOADING_MIN,
    plant_oee: float = PLANT_OEE_LIMIT,
) -> list[dict[str, Any]]:
    """Machines that are low on the latest sample, and how long that streak has run.

    ``triggered`` is true once the streak covers the selected duration.
    Shorter streaks stay in the list so the page can show the watch immediately.
    """
    minutes = _alert_minutes(minutes)
    now = now.astimezone(timezone.utc)
    grouped: dict[int, list[dict[str, Any]]] = {}
    for sample in samples:
        start = sample.get("bucket_start")
        if not isinstance(start, datetime):
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
            sample = {**sample, "bucket_start": start}
        if start > now + timedelta(seconds=5):
            continue
        try:
            equipment_id = int(sample["equipment_id"])
        except (TypeError, ValueError, KeyError):
            continue
        grouped.setdefault(equipment_id, []).append(sample)

    streaks: list[dict[str, Any]] = []
    for equipment_id, group in grouped.items():
        group.sort(key=lambda sample: sample["bucket_start"])
        latest = group[-1]
        last = latest["bucket_start"]
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if now - last > timedelta(seconds=180):
            continue
        if not _sample_is_low(
            latest,
            machine_oee=machine_oee,
            machine_loading=machine_loading,
            plant_oee=plant_oee,
        ):
            continue
        streak = []
        for sample in reversed(group):
            if not _sample_is_low(
                sample,
                machine_oee=machine_oee,
                machine_loading=machine_loading,
                plant_oee=plant_oee,
            ):
                break
            streak.append(sample)
        first = streak[-1]["bucket_start"]
        if first.tzinfo is None:
            first = first.replace(tzinfo=timezone.utc)
        elapsed = round(max(0.0, (now - first).total_seconds() / 60.0), 1)
        kind = "plant" if latest.get("is_plant") else "machine"
        streaks.append(
            {
                "equipment_id": equipment_id,
                "label": latest.get("label") or "",
                "kind": kind,
                "oee_pct": _num(latest.get("oee_pct")),
                "loading_pct": _num(latest.get("loading_pct")),
                "minutes": elapsed,
                "limit": plant_oee if kind == "plant" else machine_oee,
                "triggered": elapsed >= minutes and len(streak) >= 2,
            }
        )
    streaks.sort(key=lambda notice: (not notice["triggered"], notice["kind"] != "plant", notice["oee_pct"]))
    return streaks


def lowest_machines(samples: list[dict[str, Any]], *, limit: int = 5) -> list[dict[str, Any]]:
    latest: dict[int, dict[str, Any]] = {}
    for sample in samples:
        if not sample.get("is_machine"):
            continue
        try:
            equipment_id = int(sample["equipment_id"])
        except (TypeError, ValueError, KeyError):
            continue
        current = latest.get(equipment_id)
        if current is None or sample["bucket_start"] >= current["bucket_start"]:
            latest[equipment_id] = sample
    rows_ = list(latest.values())
    loaded = [row for row in rows_ if _num(row.get("loading_pct")) > MACHINE_LOADING_MIN]
    pool = loaded or rows_
    pool.sort(key=lambda row: (_num(row.get("oee_pct")), row.get("label") or ""))
    return [
        {
            "equipment_id": int(row["equipment_id"]),
            "label": row.get("label") or "",
            "oee_pct": _num(row.get("oee_pct")),
            "loading_pct": _num(row.get("loading_pct")),
        }
        for row in pool[:limit]
    ]


def _alert_minutes(value: Any) -> int:
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return DEFAULT_ALERT_MINUTES
    return minutes if minutes in ALERT_MINUTES else DEFAULT_ALERT_MINUTES


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _ensure_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    with _SCHEMA_LOCK:
        if _SCHEMA_READY:
            return
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS auk_oee_sample (
                equipment_id      BIGINT       NOT NULL,
                bucket_start      TIMESTAMPTZ  NOT NULL,
                grain             TEXT         NOT NULL,
                label             TEXT         NOT NULL DEFAULT '',
                group_id          TEXT         NOT NULL DEFAULT '',
                is_plant          BOOLEAN      NOT NULL DEFAULT FALSE,
                is_machine        BOOLEAN      NOT NULL DEFAULT FALSE,
                oee_pct           NUMERIC,
                loading_pct       NUMERIC,
                availability_pct  NUMERIC,
                performance_pct   NUMERIC,
                quality_pct       NUMERIC,
                day_oee_pct       NUMERIC,
                updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                PRIMARY KEY (equipment_id, bucket_start, grain)
            )
            """
        )
        con.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_auk_oee_sample_grain_time
            ON auk_oee_sample (grain, bucket_start)
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS auk_oee_layout (
                layout_id    INTEGER      PRIMARY KEY,
                layout_json  TEXT         NOT NULL,
                updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
            )
            """
        )
        _SCHEMA_READY = True


def _upsert_samples(con, samples: list[dict[str, Any]]) -> None:
    if not samples:
        return
    payload = [
        (
            sample["equipment_id"],
            sample["bucket_start"],
            sample["grain"],
            sample.get("label") or "",
            sample.get("group_id") or "",
            bool(sample.get("is_plant")),
            bool(sample.get("is_machine")),
            sample.get("oee_pct"),
            sample.get("loading_pct"),
            sample.get("availability_pct"),
            sample.get("performance_pct"),
            sample.get("quality_pct"),
            sample.get("day_oee_pct"),
        )
        for sample in samples
    ]
    con.execute_values(
        """
        INSERT INTO auk_oee_sample (
            equipment_id, bucket_start, grain, label, group_id, is_plant, is_machine,
            oee_pct, loading_pct, availability_pct, performance_pct, quality_pct,
            day_oee_pct
        ) VALUES %s
        ON CONFLICT (equipment_id, bucket_start, grain) DO UPDATE SET
            label = EXCLUDED.label,
            group_id = EXCLUDED.group_id,
            is_plant = EXCLUDED.is_plant,
            is_machine = EXCLUDED.is_machine,
            oee_pct = EXCLUDED.oee_pct,
            loading_pct = EXCLUDED.loading_pct,
            availability_pct = EXCLUDED.availability_pct,
            performance_pct = EXCLUDED.performance_pct,
            quality_pct = EXCLUDED.quality_pct,
            day_oee_pct = EXCLUDED.day_oee_pct,
            updated_at = NOW()
        """,
        payload,
    )


def _purge_old_samples(con, now: datetime) -> None:
    con.execute(
        """
        DELETE FROM auk_oee_sample
        WHERE (grain = ? AND bucket_start < ?)
           OR (grain = ? AND bucket_start < ?)
        """,
        (
            BUCKET_GRAIN,
            now - timedelta(days=BUCKET_RETENTION_DAYS),
            MINUTE_GRAIN,
            now - timedelta(days=MINUTE_RETENTION_DAYS),
        ),
    )


def record_live_oee(
    *,
    cards: list[dict[str, Any]],
    site_rows: list[dict[str, Any]],
    upper: str,
    entity_id: int,
    now: datetime | None = None,
) -> None:
    """Store the open 15-minute buckets and the latest minute of truth."""
    now = now or datetime.now(timezone.utc)
    cards_by_equipment: dict[int, dict[str, Any]] = {}
    for card in cards:
        equipment_id = card.get("equipment_id")
        if equipment_id is None:
            continue
        try:
            cards_by_equipment[int(equipment_id)] = card
        except (TypeError, ValueError):
            continue
    if not cards_by_equipment:
        return

    bucket_samples = latest_slot_samples(
        samples_from_site_rows(site_rows, cards_by_equipment, grain=BUCKET_GRAIN),
        per_equipment=2,
    )
    minute_samples = _minute_samples(
        cards_by_equipment,
        upper=upper,
        entity_id=entity_id,
        now=now,
        fallback_rows=site_rows,
    )
    if not bucket_samples and not minute_samples:
        logger.info("OEE record produced no samples")
    try:
        with planner_db() as con:
            _ensure_schema(con)
            _upsert_samples(con, bucket_samples + minute_samples)
            _purge_old_samples(con, now)
    except Exception:
        logger.exception("Could not store OEE samples")


def _minute_samples(
    cards_by_equipment: dict[int, dict[str, Any]],
    *,
    upper: str,
    entity_id: int,
    now: datetime,
    fallback_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    upper_dt = now
    lower_dt = now - timedelta(minutes=MINUTE_LOOKBACK_MINUTES)
    try:
        minute_rows = fetch_site_oee(
            list(cards_by_equipment),
            lower=_iso(lower_dt),
            upper=_iso(upper_dt),
            res_x=1,
            res_period="minutes",
            entity_id=entity_id,
        )
    except Exception:
        logger.warning("1-minute OEE window failed; storing the open bucket instead", exc_info=True)
        minute_rows = []
    if minute_rows and slots_are_minutes(minute_rows):
        kept = recent_samples(
            samples_from_site_rows(minute_rows, cards_by_equipment, grain=MINUTE_GRAIN),
            now=now,
            minutes=MINUTE_KEEP_MINUTES,
        )
        if kept:
            return kept
    return poll_snapshots(fallback_rows, cards_by_equipment, now)


def load_board(
    *,
    minutes: int = DEFAULT_ALERT_MINUTES,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Day line, recent low machines, and the page-only notice."""
    minutes = _alert_minutes(minutes)
    now = now or datetime.now(timezone.utc)
    # Singapore midnight, so the chart matches the factory day the donuts use.
    from .utils import PLANNER_TZ

    local_now = now.astimezone(PLANNER_TZ)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    watch_start = now - timedelta(minutes=max(minutes, MINUTE_LOOKBACK_MINUTES))
    try:
        with planner_db() as con:
            _ensure_schema(con)
            plant_rows = rows(
                con.execute(
                    """
                    SELECT bucket_start, oee_pct, loading_pct, day_oee_pct
                    FROM auk_oee_sample
                    WHERE grain = ? AND is_plant = TRUE AND bucket_start >= ?
                    ORDER BY bucket_start
                    """,
                    (BUCKET_GRAIN, local_midnight),
                )
            )
            recent_rows = rows(
                con.execute(
                    """
                    SELECT equipment_id, bucket_start, label, is_plant, is_machine,
                           oee_pct, loading_pct, day_oee_pct
                    FROM auk_oee_sample
                    WHERE grain = ? AND bucket_start >= ?
                    ORDER BY bucket_start
                    """,
                    (MINUTE_GRAIN, watch_start),
                )
            )
    except Exception:
        logger.exception("Could not read OEE history")
        plant_rows = []
        recent_rows = []

    recent = [_sample_from_row(row) for row in recent_rows]
    watching = current_low_streaks(recent, minutes=minutes, now=now)
    alerts = [notice for notice in watching if notice.get("triggered")]
    plant_latest = next((sample for sample in reversed(recent) if sample.get("is_plant")), None)
    loaded = [
        sample
        for sample in _latest_by_equipment(recent)
        if sample.get("is_machine") and _num(sample.get("loading_pct")) > MACHINE_LOADING_MIN
    ]
    machines = [sample for sample in _latest_by_equipment(recent) if sample.get("is_machine")]
    plant_oee = None
    if plant_rows:
        plant_oee = plant_rows[-1].get("day_oee_pct")
        if plant_oee is None:
            plant_oee = plant_rows[-1].get("oee_pct")
    elif plant_latest is not None:
        plant_oee = plant_latest.get("day_oee_pct") or plant_latest.get("oee_pct")
    return {
        "alert_minutes": minutes,
        "plant": [
            {
                "t": _iso(row["bucket_start"]),
                "oee": _none_num(row.get("oee_pct")),
                "loading": _none_num(row.get("loading_pct")),
                "day_oee": _none_num(row.get("day_oee_pct")),
            }
            for row in plant_rows
        ],
        "lowest": lowest_machines(recent),
        "watching": watching,
        "alerts": alerts,
        "report": {
            "plant_oee": _none_num(plant_oee),
            "loaded_count": len({sample["equipment_id"] for sample in loaded}),
            "machine_count": len({sample["equipment_id"] for sample in machines}),
            "low": watching,
            "updated_at": _iso(now),
        },
        "has_samples": bool(plant_rows or recent_rows),
        "day_start": _iso(local_midnight),
    }


def load_layout() -> dict[str, Any] | None:
    try:
        with planner_db() as con:
            _ensure_schema(con)
            found = rows(con.execute("SELECT layout_json FROM auk_oee_layout WHERE layout_id = 1"))
    except Exception:
        logger.exception("Could not read OEE layout")
        return None
    if not found:
        return None
    try:
        parsed = json.loads(found[0]["layout_json"])
    except (TypeError, ValueError):
        return None
    layout = normalize_layout(parsed)
    return layout if layout["items"] else None


def save_layout(data: dict[str, Any]) -> dict[str, Any]:
    layout = normalize_layout(data)
    encoded = json.dumps(layout)
    with planner_db() as con:
        _ensure_schema(con)
        con.execute(
            """
            INSERT INTO auk_oee_layout (layout_id, layout_json, updated_at)
            VALUES (1, ?, NOW())
            ON CONFLICT (layout_id) DO UPDATE SET
                layout_json = EXCLUDED.layout_json,
                updated_at = NOW()
            """,
            (encoded,),
        )
    return layout


def _latest_by_equipment(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest: dict[int, dict[str, Any]] = {}
    for sample in samples:
        equipment_id = int(sample["equipment_id"])
        current = latest.get(equipment_id)
        if current is None or sample["bucket_start"] >= current["bucket_start"]:
            latest[equipment_id] = sample
    return list(latest.values())


def _sample_from_row(row: dict[str, Any]) -> dict[str, Any]:
    start = row["bucket_start"]
    if isinstance(start, datetime) and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return {
        "equipment_id": int(row["equipment_id"]),
        "bucket_start": start,
        "label": row.get("label") or "",
        "is_plant": bool(row.get("is_plant")),
        "is_machine": bool(row.get("is_machine")),
        "oee_pct": _none_num(row.get("oee_pct")),
        "loading_pct": _none_num(row.get("loading_pct")),
        "day_oee_pct": _none_num(row.get("day_oee_pct")),
    }


def _none_num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def sample_loop(interval_seconds: int = 60) -> None:
    """Keep minute samples flowing while the planner is up, even if the page is closed."""
    import time

    from .auk_oee_service import fetch_canvas_dashboard, range_for_preset

    while True:
        try:
            lower, upper, _preset = range_for_preset("day")
            fetch_canvas_dashboard(lower=lower, upper=upper, res_x=15, res_period="minutes")
        except Exception:
            logger.exception("OEE sample loop failed")
        time.sleep(max(30, int(interval_seconds)))


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
