"""OEE sample shaping, the low-OEE rule, and the default canvas layout."""

from datetime import datetime, timedelta, timezone

from planning.auk_oee_history import (
    current_low_streaks,
    default_layout_from_cards,
    latest_slot_samples,
    low_oee_notices,
    lowest_machines,
    normalize_layout,
    poll_snapshots,
    recent_samples,
    samples_from_site_rows,
    slots_are_minutes,
)

NOW = datetime(2026, 10, 7, 8, 0, tzinfo=timezone.utc)


def _slot(minute_offset, *, oee=30, loading=80, interval_ms=60_000):
    start = NOW - timedelta(minutes=minute_offset)
    # Split the bucket so loading and OEE come out of the waterfall.
    # A single slot's percents are passed through overall_from_oee_slots.
    return {
        "time": start.isoformat().replace("+00:00", "Z"),
        "int": interval_ms,
        "oee": {
            "na": 0,
            "us": 0,
            "pd": max(0, 100 - loading),
            "uu": 0,
            "bd": 0,
            "st": 0,
            "ms": 0,
            "sl": 0,
            "rj": 0,
            "rw": 0,
            "ef": oee,
        },
    }


def _machine(equipment_id=10, label="CNC 10 (Turning)"):
    return {
        "equipment_id": equipment_id,
        "label": label,
        "group_id": "turning",
        "is_machine": True,
        "is_group_summary": False,
        "oee_pct": 40,
        "position_x": 0,
        "position_y": 0,
    }


def test_minute_slots_are_detected_and_quarter_hours_are_not():
    minute = {"equipment_id": 1, "data": [_slot(1, interval_ms=60_000)]}
    quarter = {"equipment_id": 1, "data": [_slot(1, interval_ms=900_000)]}
    assert slots_are_minutes([minute]) is True
    assert slots_are_minutes([quarter]) is False


def test_recent_samples_keep_only_the_open_window():
    card = _machine()
    row = {"equipment_id": 10, "data": [_slot(1), _slot(40)]}
    samples = samples_from_site_rows([row], {10: card}, grain="minute")
    assert len(samples) == 2
    kept = recent_samples(samples, now=NOW, minutes=5)
    assert len(kept) == 1
    assert kept[0]["is_machine"] is True
    assert kept[0]["is_plant"] is False


def test_latest_slot_samples_keep_the_newest_two_per_machine():
    card = _machine()
    row = {"equipment_id": 10, "data": [_slot(60), _slot(30), _slot(1)]}
    samples = samples_from_site_rows([row], {10: card}, grain="bucket")
    kept = latest_slot_samples(samples, per_equipment=2)
    assert len(kept) == 2
    assert kept[-1]["bucket_start"] > kept[0]["bucket_start"]


def test_poll_snapshot_uses_the_latest_slot():
    card = _machine()
    row = {"equipment_id": 10, "data": [_slot(20, oee=10), _slot(1, oee=70, loading=90)]}
    snaps = poll_snapshots([row], {10: card}, NOW)
    assert len(snaps) == 1
    assert snaps[0]["bucket_start"] == NOW.replace(second=0, microsecond=0)
    assert snaps[0]["grain"] == "minute"
    assert snaps[0]["oee_pct"] > 0


def test_loaded_machine_alerts_after_the_watch_window():
    samples = []
    for minute in range(0, 11):
        samples.append(
            {
                "equipment_id": 10,
                "bucket_start": NOW - timedelta(minutes=minute),
                "label": "CNC 10 (Turning)",
                "is_plant": False,
                "is_machine": True,
                "oee_pct": 20,
                "loading_pct": 80,
            }
        )
    notices = low_oee_notices(samples, minutes=10, now=NOW)
    assert len(notices) == 1
    assert notices[0]["kind"] == "machine"
    assert notices[0]["equipment_id"] == 10


def test_short_streak_is_visible_before_it_triggers():
    samples = [
        {
            "equipment_id": 38,
            "bucket_start": NOW - timedelta(minutes=minute),
            "label": "CNC 38 (TurnMill)",
            "is_plant": False,
            "is_machine": True,
            "oee_pct": 4.8,
            "loading_pct": 80,
        }
        for minute in range(0, 4)
    ]
    streaks = current_low_streaks(samples, minutes=10, now=NOW)
    assert len(streaks) == 1
    assert streaks[0]["triggered"] is False
    assert streaks[0]["minutes"] >= 3


def test_color_choice_is_kept_on_the_card():
    layout = normalize_layout(
        {
            "items": [
                {"type": "card", "equipment_id": 36, "x": 0, "y": 0, "w": 2, "h": 1, "color": "blue"},
            ]
        }
    )
    assert layout["items"][0]["color"] == "blue"
    assert layout["items"][0]["h"] == 1


def test_idle_machine_and_a_short_dip_stay_quiet():
    idle = [
        {
            "equipment_id": 15,
            "bucket_start": NOW - timedelta(minutes=minute),
            "label": "CNC 15 (Turning)",
            "is_plant": False,
            "is_machine": True,
            "oee_pct": 0,
            "loading_pct": 20,
        }
        for minute in range(0, 11)
    ]
    brief = [
        {
            "equipment_id": 36,
            "bucket_start": NOW - timedelta(minutes=minute),
            "label": "CNC 36 (Milling)",
            "is_plant": False,
            "is_machine": True,
            "oee_pct": 20 if minute < 3 else 80,
            "loading_pct": 90,
        }
        for minute in range(0, 11)
    ]
    assert low_oee_notices(idle + brief, minutes=10, now=NOW) == []


def test_lowest_machines_prefer_loaded_cncs():
    samples = [
        {
            "equipment_id": 15,
            "bucket_start": NOW,
            "label": "CNC 15",
            "is_machine": True,
            "oee_pct": 0,
            "loading_pct": 10,
        },
        {
            "equipment_id": 36,
            "bucket_start": NOW,
            "label": "CNC 36",
            "is_machine": True,
            "oee_pct": 55,
            "loading_pct": 90,
        },
        {
            "equipment_id": 41,
            "bucket_start": NOW,
            "label": "CNC 41",
            "is_machine": True,
            "oee_pct": 30,
            "loading_pct": 80,
        },
    ]
    lowest = lowest_machines(samples, limit=5)
    assert [row["equipment_id"] for row in lowest] == [41, 36]


def test_default_layout_packs_cards_and_keeps_charts_clear():
    cards = [
        {
            "equipment_id": index,
            "position_x": index,
            "position_y": 0,
            "label": f"CNC {index}",
        }
        for index in range(1, 8)
    ]
    layout = default_layout_from_cards(cards)
    cards_only = [item for item in layout["items"] if item["type"] == "card"]
    assert len(cards_only) == 7
    occupied = set()
    for item in cards_only:
        for x in range(item["x"], item["x"] + item["w"]):
            for y in range(item["y"], item["y"] + item["h"]):
                assert (x, y) not in occupied
                occupied.add((x, y))
    today = next(item for item in layout["items"] if item["type"] == "today")
    assert today["y"] >= max(item["y"] + item["h"] for item in cards_only)
    assert {item["type"] for item in layout["items"]} >= {"card", "today", "lowest", "report"}


def test_normalize_layout_drops_unknown_widgets_and_clamps_alert_time():
    layout = normalize_layout(
        {
            "alert_minutes": 7,
            "items": [
                {"type": "card", "equipment_id": 10, "x": 20, "y": -2, "w": 1, "h": 9},
                {"type": "siren", "x": 0, "y": 0, "w": 2, "h": 2},
                {"type": "today", "x": 0, "y": 0, "w": 6, "h": 3},
            ],
        }
    )
    assert layout["alert_minutes"] == 10
    assert [item["type"] for item in layout["items"]] == ["card", "today"]
    card = layout["items"][0]
    assert card["id"] == "card-10"
    assert card["w"] == 2
    assert card["h"] == 4
    assert card["x"] + card["w"] <= 12
