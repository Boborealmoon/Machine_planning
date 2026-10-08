"""Factory-dashboard OEE aggregation, without calling Auk."""

from planning.auk_oee_service import overall_from_oee_slots, range_for_preset, segments_from_slots


def test_overall_matches_auk_waterfall():
    # 15-minute bucket. Losses sum to 100 with the waterfall keys.
    slot = {
        "int": 15 * 60 * 1000,
        "oee": {
            "na": 0,
            "us": 20,
            "pd": 20,
            "uu": 10,
            "bd": 0,
            "st": 0,
            "ms": 0,
            "sl": 0,
            "rj": 0,
            "rw": 0,
            "ef": 50,
        },
    }
    overall = overall_from_oee_slots([slot])
    assert overall is not None
    assert overall["loading"] == 60.0
    assert overall["availability"] == 83.33
    assert overall["performance"] == 100.0
    assert overall["quality"] == 100.0
    # OEE2 = availability x performance x quality, which is what the donut shows.
    assert overall["final_effective"] == 83.33


def test_each_time_slice_keeps_its_own_oee():
    slots = [
        {"time": "2026-10-08T00:00:00.000Z", "int": 3600000, "oee": {"ef": 100, "pd": 0}},
        {"time": "2026-10-08T01:00:00.000Z", "int": 3600000, "oee": {"ef": 33, "pd": 40, "us": 27}},
    ]
    segments = segments_from_slots(slots)
    assert len(segments) == 2
    assert segments[0]["start"].startswith("2026-10-08T00:00:00")
    assert segments[0]["oee_pct"] == 100.0
    assert segments[1]["loading_pct"] < segments[0]["loading_pct"]
    assert segments[1]["losses"]["pd"] == 40.0


def test_day_preset_starts_at_local_midnight():
    lower, upper, preset = range_for_preset("day")
    assert preset == "day"
    assert lower.endswith("Z") and upper.endswith("Z")
    assert lower < upper
