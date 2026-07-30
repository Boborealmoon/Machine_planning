from datetime import date

from planning.capacity_group_service import (
    add_calendar_months,
    calendar_month_bounds,
    parse_capacity_basis,
    planning_period,
    resolve_capacity_basis_window,
)


def test_parse_capacity_basis_aliases():
    assert parse_capacity_basis("rolling_period") == "rolling_period"
    assert parse_capacity_basis("forecast") == "rest_of_month"
    assert parse_capacity_basis("queue") == "calendar_month"
    assert parse_capacity_basis("plan") == "rolling_period"


def test_rest_of_month_from_today_through_calendar_end():
    window = resolve_capacity_basis_window("rest_of_month", 2026, 6, date(2026, 6, 25))
    assert window["capacity_start"] == date(2026, 6, 25)
    assert window["capacity_end"] == date(2026, 6, 30)
    assert window["segment_start"] == date(2026, 6, 25)
    assert window["segment_end"] == date(2026, 6, 30)


def test_calendar_month_is_first_through_last_day():
    window = resolve_capacity_basis_window("calendar_month", 2026, 7, date(2026, 6, 25))
    assert window["capacity_start"] == date(2026, 7, 1)
    assert window["capacity_end"] == date(2026, 7, 31)


def test_rolling_period_is_as_of_to_same_day_next_month():
    as_of = date(2026, 6, 25)
    window = resolve_capacity_basis_window("rolling_period", 2026, 7, as_of)
    period_start, period_end = planning_period(as_of)
    assert period_start == date(2026, 6, 25)
    assert period_end == date(2026, 7, 25)
    assert window["capacity_start"] == period_start
    assert window["capacity_end"] == period_end


def test_rolling_period_clamps_month_end_days():
    # 31 Jan → 28 Feb in a non-leap year
    assert planning_period(date(2026, 1, 31)) == (date(2026, 1, 31), date(2026, 2, 28))
    assert add_calendar_months(date(2024, 1, 31), 1) == date(2024, 2, 29)


def test_rest_of_month_future_selection_warns():
    window = resolve_capacity_basis_window("rest_of_month", 2026, 7, date(2026, 6, 25))
    assert window["warning"]
    assert window["capacity_start"] == date(2026, 7, 1)
    assert window["capacity_end"] == date(2026, 7, 31)


def test_calendar_month_bounds():
    start, end = calendar_month_bounds(2026, 2)
    assert start == date(2026, 2, 1)
    assert end == date(2026, 2, 28)
