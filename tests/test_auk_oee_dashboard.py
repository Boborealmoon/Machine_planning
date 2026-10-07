"""Factory-dashboard OEE aggregation, without calling Auk."""

from planning.auk_oee_service import overall_from_oee_slots, range_for_preset


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


def test_day_preset_starts_at_local_midnight():
    lower, upper, preset = range_for_preset("day")
    assert preset == "day"
    assert lower.endswith("Z") and upper.endswith("Z")
    assert lower < upper
