from planning.cycle_time_service import (
    MasterTimeCache,
    _part_no_lookup_candidates,
    _pick_master_row,
)


def _row(**overrides):
    row = {
        "id": 1,
        "part_no": "BB18-KS1214-02 REV 02",
        "bom_code": "SMP-MAT01-REV00",
        "op_no": 20,
        "op_type": "Turning",
        "stage_no": 20,
        "program_no": "",
        "program_file": "",
        "tool_list_file": "",
        "ideal_cycle_time": 4.5,
        "cycle_time": 4.5,
        "set_up_time": 30,
    }
    row.update(overrides)
    return row


def test_part_candidates_strip_rev_suffix():
    assert "BB18-KS1214-02" in _part_no_lookup_candidates("BB18-KS1214-02 REV 02")
    assert "BB18-KS1214-02 REV 02" in _part_no_lookup_candidates("BB18-KS1214-02 REV 02")


def test_master_lookup_matches_bom_aliases():
    rows = [_row()]
    hit = _pick_master_row(
        rows,
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01_REV00",
        op_no=20,
    )
    assert hit is not None
    assert hit["cycle_time"] == 4.5

    alias_hit = _pick_master_row(
        rows,
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01-REV00",
        op_no=20,
        extra_bom_codes=["ERP SMP-MAT01-REV00"],
    )
    assert alias_hit is not None


def test_master_lookup_matches_rev_stripped_part():
    rows = [_row(part_no="BB18-KS1214-02")]
    hit = _pick_master_row(
        rows,
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01_REV00",
        op_no=20,
    )
    assert hit is not None
    assert hit["part_no"] == "BB18-KS1214-02"


def test_master_lookup_falls_back_to_part_and_op():
    rows = [_row(bom_code="OTHER-ROUTE")]
    hit = _pick_master_row(
        rows,
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01_REV00",
        op_no=20,
    )
    assert hit is not None
    assert hit["bom_code"] == "OTHER-ROUTE"


def test_schedule_lookup_prefers_child_part_and_bom_alias():
    from planning.cycle_time_service import schedule_time_lookup_keys

    part, bom, extra_parts, extra_boms = schedule_time_lookup_keys(
        ps={"inventory_code": "KIT-PARENT"},
        bom_row={"inventory_code": "KIT-PARENT", "bom_code": "SMP-MAT01-REV00"},
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01_REV00",
        extra_part_nos=["KIT-PARENT"],
        extra_bom_codes=["SMP-MAT01-REV00"],
    )
    assert part == "BB18-KS1214-02 REV 02"
    assert bom == "SMP-MAT-01_REV00"
    assert "KIT-PARENT" in extra_parts
    assert "SMP-MAT01-REV00" in extra_boms


def test_master_cache_prefers_aliased_bom_over_other_route():
    cache = MasterTimeCache(
        [
            _row(id=1, bom_code="OTHER-ROUTE", cycle_time=9),
            _row(id=2, bom_code="SMP-MAT01-REV00", cycle_time=4.5),
        ]
    )
    hit = cache.lookup(
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01_REV00",
        op_no=20,
    )
    assert hit["id"] == 2
    assert hit["cycle_time"] == 4.5
