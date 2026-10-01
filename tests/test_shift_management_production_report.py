"""Production summary lines on the Queue reporting tab. No database."""

from datetime import date

from planning.shift_management_service import (
    PRODUCTION_REPORT_MIN_ROWS,
    blank_production_report,
    normalize_production_lines,
    suggest_process_sheets,
)


def test_blank_report_has_eight_empty_lines():
    sheet = blank_production_report(date(2026, 9, 30), "Night")
    assert sheet["saved"] is False
    assert sheet["shift_out"] == "Night"
    assert sheet["work_date"] == "2026-09-30"
    assert len(sheet["lines"]) == PRODUCTION_REPORT_MIN_ROWS
    assert sheet["lines"][0]["no"] == 1
    assert sheet["lines"][0]["process_sheet_no"] == ""
    assert sheet["lines"][0]["produced_qty"] is None
    assert sheet["lines"][0]["scanned_erp"] == ""


def test_lines_keep_gaps_normalize_qty_and_pad():
    lines = normalize_production_lines(
        [
            {
                "process_sheet_no": " nps26-1234 ",
                "description": " Pilot Housing ",
                "target_qty": "500",
                "produced_qty": 480,
                "rejected_qty": "5",
                "cnc": " CNC 31 ",
                "scanned_erp": "y",
            },
            {},
            {
                "description": "Manual row",
                "produced_qty": -3,
                "rejected_qty": "nope",
                "scanned_erp": "maybe",
            },
        ]
    )
    assert len(lines) == 8
    assert lines[0]["no"] == 1
    assert lines[0]["process_sheet_no"] == "NPS26-1234"
    assert lines[0]["description"] == "Pilot Housing"
    assert lines[0]["target_qty"] == 500
    assert lines[0]["produced_qty"] == 480
    assert lines[0]["rejected_qty"] == 5
    assert lines[0]["cnc"] == "CNC 31"
    assert lines[0]["scanned_erp"] == "Y"
    assert lines[1]["process_sheet_no"] == ""
    assert lines[2]["description"] == "Manual row"
    assert lines[2]["produced_qty"] is None
    assert lines[2]["rejected_qty"] is None
    assert lines[2]["scanned_erp"] == ""
    assert lines[7]["no"] == 8


def test_extra_blank_lines_trim_back_to_eight():
    raw = [{"process_sheet_no": "NPS1", "produced_qty": 1}]
    raw.extend({} for _ in range(12))
    lines = normalize_production_lines(raw)
    assert len(lines) == 8
    assert lines[0]["process_sheet_no"] == "NPS1"


def test_filled_ninth_line_is_kept():
    raw = [{} for _ in range(8)]
    raw.append({"process_sheet_no": "NPS9", "rejected_qty": 2, "scanned_erp": "N"})
    lines = normalize_production_lines(raw)
    assert len(lines) == 9
    assert lines[8]["process_sheet_no"] == "NPS9"
    assert lines[8]["rejected_qty"] == 2
    assert lines[8]["scanned_erp"] == "N"


class _Cur:
    def __init__(self, data):
        self._data = data

    def fetchall(self):
        return self._data


class _Con:
    def __init__(self, cache, info=None, descriptions=None):
        self.cache = cache
        self.info = info or []
        self.descriptions = descriptions or []
        self.params = []
        self.executed = []

    def execute(self, sql, params=None):
        text = " ".join(str(sql).split())
        self.executed.append(text)
        if params is not None:
            self.params.append(params)
        if text.startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
            return self
        if "pp_vouchers_cache" in text:
            return _Cur(self.cache)
        if "mfg_process_sheet_info" in text:
            return _Cur(self.info)
        if "part_desc" in text:
            return _Cur(self.descriptions)
        return _Cur([])


def test_suggest_needs_two_characters():
    con = _Con([])

    assert suggest_process_sheets(con, " N ") == []
    assert con.executed == []


def test_suggest_ranks_prefix_fills_description_and_keeps_info_only_sheets():
    con = _Con(
        cache=[
            {
                "ps_key": "NP900-0321",
                "process_sheet_no": "NP900-0321",
                "description": "Other part",
                "part_no": "P-9",
                "total_qty": 4,
            },
            {
                "ps_key": "NP526-0321",
                "process_sheet_no": "np526-0321",
                "description": "",
                "part_no": "RIMS-1",
                "total_qty": "30",
            },
        ],
        info=[
            {
                "ps_key": "NP526-0321",
                "process_sheet_no": "NP526-0321",
                "description": "",
                "part_no": "SHOULD-NOT-WIN",
                "total_qty": 1,
            },
            {
                "ps_key": "NP526-0999",
                "process_sheet_no": "NP526-0999",
                "description": "",
                "part_no": "ONLY-INFO",
                "total_qty": 2,
            },
        ],
        descriptions=[
            {"inventory_code": "RIMS-1", "main_desc": "R.I.M.S LOCKDOWN MECHAN"},
            {"inventory_code": "ONLY-INFO", "main_desc": "Info only"},
        ],
    )

    hits = suggest_process_sheets(con, "np526")

    assert [hit["process_sheet_no"] for hit in hits] == ["NP526-0321", "NP526-0999", "NP900-0321"]
    assert hits[0]["description"] == "R.I.M.S LOCKDOWN MECHAN"
    assert hits[0]["target_qty"] == 30
    assert hits[1]["description"] == "Info only"
    assert hits[2]["description"] == "Other part"
    assert any("ESCAPE" in text and "pp_vouchers_cache" in text for text in con.executed)


def test_suggest_escapes_like_wildcards():
    con = _Con([])
    suggest_process_sheets(con, "NP_5%")
    assert con.params
    contains, compact, prefix, compact_prefix, cap = con.params[0]
    assert contains == "%NP\\_5\\%%"
    assert prefix == "NP\\_5\\%%"
    assert compact == contains.replace("-", "")
    assert compact_prefix.startswith("NP\\_5\\%")
    assert cap == 8
