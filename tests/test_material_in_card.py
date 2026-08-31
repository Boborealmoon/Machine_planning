from datetime import date

from planning.process_sheets import material_in_card_date, material_in_date_from_subcon


def test_material_in_date_from_subcon_iso():
    assert material_in_date_from_subcon("2026-09-11") == "2026-09-11"


def test_material_in_date_from_subcon_dmy():
    assert material_in_date_from_subcon("11/09/2026") == "2026-09-11"


def test_material_in_date_from_subcon_arrived_is_empty():
    assert material_in_date_from_subcon("ARRIVED") == ""
    assert material_in_date_from_subcon("Arrived") == ""


def test_material_in_date_from_subcon_blank_and_notes():
    assert material_in_date_from_subcon("") == ""
    assert material_in_date_from_subcon(None) == ""
    assert material_in_date_from_subcon("Chuan Heng for programming") == ""


def test_material_in_card_date_prefers_subcon_over_sheet():
    assert material_in_card_date("11/09/2026", date(2026, 8, 31)) == "2026-09-11"


def test_material_in_card_date_uses_sheet_when_arrived():
    assert material_in_card_date("ARRIVED", date(2026, 8, 19)) == "2026-08-19"


def test_material_in_card_date_empty_without_either():
    assert material_in_card_date("ARRIVED", None) == ""
    assert material_in_card_date("", None) == ""



def test_material_in_date_from_subcon_iso():
    assert material_in_date_from_subcon("2026-09-11") == "2026-09-11"


def test_material_in_date_from_subcon_dmy():
    assert material_in_date_from_subcon("11/09/2026") == "2026-09-11"


def test_material_in_date_from_subcon_arrived_is_empty():
    assert material_in_date_from_subcon("ARRIVED") == ""
    assert material_in_date_from_subcon("Arrived") == ""


def test_material_in_date_from_subcon_blank_and_notes():
    assert material_in_date_from_subcon("") == ""
    assert material_in_date_from_subcon(None) == ""
    assert material_in_date_from_subcon("Chuan Heng for programming") == ""
