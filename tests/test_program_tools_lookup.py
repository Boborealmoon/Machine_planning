from program_tools_lookup import build_program_tools_lookup, lookup_program_tools, normalize_bom_code


def test_bom_code_aliases_share_lookup_key():
    assert normalize_bom_code("SMP-MAT01-REV00") == normalize_bom_code("SMP-MAT-01_REV00")
    assert normalize_bom_code("SMP-MAT-01-REV00") == "SMPMAT01REV00"


def test_lookup_program_tools_by_part_and_bom_alias():
    lookup = build_program_tools_lookup(
        [
            {
                "part_no_erp": "BB18-KS1214-02 REV 02",
                "bom_code": "SMP-MAT01-REV00",
                "operation_no": "20",
                "program_no": "P-1214-20",
                "program_file": "https://example.com/prog",
                "tool_list_files": "https://example.com/tools",
                "programmer_name": "Alex",
            }
        ]
    )
    hit = lookup_program_tools(
        lookup,
        ps_id="NPS26-0321-5",
        part_no="BB18-KS1214-02 REV 02",
        bom_code="SMP-MAT-01_REV00",
        source_op_no="20",
    )
    assert hit is not None
    assert hit["program_no"] == "P-1214-20"
    assert hit["programmer_name"] == "Alex"
