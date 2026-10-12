"""Daily OEE calendar rows, without calling Auk."""

from datetime import date

from planning.auk_oee_service import (
    build_calendar_rows,
    daily_oee_from_site_rows,
    parse_calendar_range,
)


def test_daily_bucket_uses_singapore_date_and_rounds_oee():
    # 2026-08-31 16:00 UTC is 2026-09-01 in Singapore.
    # Same waterfall as the dashboard test: OEE2 is 83.33, shown as 83.
    rows = daily_oee_from_site_rows(
        [
            {
                "equipment_id": 5462,
                "data": [
                    {
                        "time": "2026-08-31T16:00:00.000Z",
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
                ],
            }
        ]
    )
    assert rows[5462][date(2026, 9, 1)] == 83


def test_calendar_tree_matches_the_shop_groups():
    entries = [
        {"label": "Seletar Overall", "equipment_id": 1, "cnc_number": None, "group_id": "overall", "is_machine": False},
        {"label": "Seletar Manufacturing Overall", "equipment_id": 2, "cnc_number": None, "group_id": "overall", "is_machine": False},
        {"label": "MPP", "equipment_id": 3, "cnc_number": None, "group_id": "mpp", "is_machine": False},
        {"label": "CNC 36 (Milling)", "equipment_id": 4, "cnc_number": 36, "group_id": "mpp", "is_machine": True},
        {"label": "CNC 35 (Milling)", "equipment_id": 5, "cnc_number": 35, "group_id": "mpp", "is_machine": True},
        {"label": "Turning", "equipment_id": 6, "cnc_number": None, "group_id": "turning", "is_machine": False},
        {"label": "APS Turn", "equipment_id": 7, "cnc_number": None, "group_id": "turning", "is_machine": False},
        {"label": "CNC 10 (Turning)", "equipment_id": 8, "cnc_number": 10, "group_id": "turning", "is_machine": True},
        {"label": "PS Turn", "equipment_id": 9, "cnc_number": None, "group_id": "turning", "is_machine": False},
        {"label": "CNC 15 (Turning)", "equipment_id": 10, "cnc_number": 15, "group_id": "turning", "is_machine": True},
        {"label": "CNC 99 (Turning)", "equipment_id": 11, "cnc_number": 99, "group_id": "turning", "is_machine": True},
    ]
    days = [date(2026, 9, 1)]
    daily = {1: {date(2026, 9, 1): 40}, 8: {date(2026, 9, 1): 55}}
    rows = build_calendar_rows(entries, daily, days)
    labels = [row["label"] for row in rows]
    assert labels[:6] == [
        "Seletar Overall",
        "Seletar Manufacturing Overall",
        "MPP",
        "CNC 35 (Milling)",
        "CNC 36 (Milling)",
        "Turning",
    ]
    assert "APS Turn" in labels
    assert labels.index("CNC 10 (Turning)") == labels.index("APS Turn") + 1
    assert labels.index("CNC 15 (Turning)") == labels.index("PS Turn") + 1
    assert labels.index("CNC 99 (Turning)") > labels.index("PS Turn")
    assert rows[0]["values"] == [40]
    assert rows[0]["parent_id"] is None
    mpp = next(row for row in rows if row["label"] == "MPP")
    assert mpp["expandable"] is True
    machine = next(row for row in rows if row["label"] == "CNC 35 (Milling)")
    assert machine["parent_id"] == "mpp"
    assert machine["depth"] == 1


def test_calendar_range_defaults_to_the_current_month():
    start, end = parse_calendar_range("", "", today=date(2026, 10, 8))
    assert start == date(2026, 10, 1)
    assert end == date(2026, 10, 31)

    start, end = parse_calendar_range("2026-09-30", "2026-09-01", today=date(2026, 10, 8))
    assert start == date(2026, 9, 1)
    assert end == date(2026, 9, 30)
