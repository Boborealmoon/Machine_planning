from planning.programme_list_service import (
    assemble_programme_checklist,
    clean_prefix,
    programme_entries_from_tool_rows,
)


def _bom(part, bom, stage, op=None):
    return {
        "inventory_code": part,
        "bom_code": bom,
        "stage_desc": stage,
        "op_no": op,
        "stage_no": op or 0,
    }


def _tool(part, bom, op, program_no, **extra):
    row = {
        "part_no_erp": part,
        "part_number": part,
        "bom_code": bom,
        "operation_no": op,
        "operation_type": extra.pop("operation_type", "Turning"),
        "program_no": program_no,
        "program_file": extra.pop("program_file", "https://example.com/prog"),
        "programmer_name": extra.pop("programmer_name", "Alex"),
    }
    row.update(extra)
    return row


def test_clean_prefix():
    assert clean_prefix("bb") == "BB"
    assert clean_prefix("BB-18") == "BB18"
    assert clean_prefix("*") == ""
    assert clean_prefix("all") == ""
    assert clean_prefix("") == ""


def test_bb_part_fully_collected_against_latest_bom():
    bom_rows = [
        _bom("BB18-KS1214-02", "SMP-MAT-01-REV00", "Turning 10", 10),
        _bom("BB18-KS1214-02", "SMP-MAT-01-REV00", "Milling 20", 20),
        _bom("BB18-KS1214-02", "SMP-MAT-01-REV01", "Turning 10", 10),
        _bom("BB18-KS1214-02", "SMP-MAT-01-REV01", "Milling 20", 20),
    ]
    programmes = programme_entries_from_tool_rows(
        [
            _tool("bb18-ks1214-02", "SMP-MAT-01_REV01", "10", "P-10"),
            _tool("BB18-KS1214-02", "SMP-MAT-01-REV01", "20", "P-20", operation_type="Milling"),
            _tool("BB18-KS1214-02", "SMP-MAT-01-REV00", "10", "OLD", operation_type="Turning"),
        ]
    )
    rows, stats = assemble_programme_checklist(
        bom_rows,
        programmes,
        {"BB18-KS1214-02": "One Subsea body"},
    )
    assert [row["part_no"] for row in rows] == ["BB18-KS1214-02"]
    row = rows[0]
    assert row["status"] == "have"
    assert row["bom_code"] == "SMP-MAT-01-REV01"
    assert row["description"] == "One Subsea body"
    assert row["ops_collected"] == 2
    assert row["ops_required"] == 2
    assert row["programme_nos"] == ["P-10", "P-20"]
    assert row["bom_count"] == 2
    assert stats["parts"] == 1
    assert stats["have"] == 1
    assert stats["pct_parts"] == 100.0
    assert stats["pct_programmes"] == 100.0


def test_partial_and_missing_parts():
    bom_rows = [
        _bom("BB1", "REV01", "Turning 10", 10),
        _bom("BB1", "REV01", "Milling 20", 20),
        _bom("BB2", "REV01", "Turning 10", 10),
        _bom("BB3", "REV00", "Turnmill 30", 30),
    ]
    programmes = programme_entries_from_tool_rows(
        [
            _tool("BB1", "REV01", "10", "P-1"),
            {
                "part_number": "BB3",
                "operation_no": "30",
                "operation_type": "Turnmill",
                "program_no": "P-3",
                "program_file": "",
            },
            _tool("BB2", "REV01", "10", "", operation_type="Deburr", program_file="https://example.com/deburr"),
        ]
    )
    rows, stats = assemble_programme_checklist(bom_rows, programmes)
    by_part = {row["part_no"]: row for row in rows}
    assert by_part["BB1"]["status"] == "partial"
    assert by_part["BB1"]["missing_ops"] == ["Milling 20"]
    assert by_part["BB2"]["status"] == "missing"
    assert by_part["BB3"]["status"] == "have"
    assert by_part["BB3"]["programme_nos"] == ["P-3"]
    assert [row["part_no"] for row in rows] == ["BB2", "BB1", "BB3"]
    assert stats["parts"] == 3
    assert stats["have"] == 1
    assert stats["partial"] == 1
    assert stats["missing"] == 1
    assert stats["ops_collected"] == 2
    assert stats["ops_required"] == 4
    assert stats["pct_programmes"] == 50.0
    assert stats["pct_parts"] == 33.3


def test_latest_bom_is_the_checklist_even_when_an_older_route_is_complete():
    bom_rows = [
        _bom("BB9", "REV00", "Turning 10", 10),
        _bom("BB9", "REV01", "Turning 10", 10),
        _bom("BB9", "REV01", "Milling 20", 20),
    ]
    programmes = programme_entries_from_tool_rows(
        [_tool("BB9", "REV00", "10", "OLD")]
    )
    rows, stats = assemble_programme_checklist(bom_rows, programmes)
    assert rows[0]["status"] == "partial"
    assert rows[0]["bom_code"] == "REV01"
    assert rows[0]["ops_collected"] == 0
    assert rows[0]["other_programmes"][0]["program_no"] == "OLD"
    assert stats["pct_programmes"] == 0.0
    assert stats["pct_parts"] == 0.0
