"""Guards so S/O planner page load stays off DDL and pp_vouchers_cache scans."""

from planning.catalog import (
    _trial_catalog_temp_assigned_sql,
    _trial_catalog_temp_unassigned_sql,
)
from planning.catalog_sql import catalog_erp_cache_with_clause
from planning.process_sheets import tooling_map_for_operation_ids, tooling_map_for_ps_op_keys


def test_empty_erp_cache_skips_pp_vouchers_table():
    sql = catalog_erp_cache_with_clause(assigned=True, empty=True)
    assert "pp_vouchers_cache" not in sql
    assert "voucher_partials" in sql
    assert "WHERE FALSE" in sql


def test_temp_catalog_sql_skips_pp_vouchers_and_erp_ctes():
    assigned = _trial_catalog_temp_assigned_sql(" AND ps.planner_ps_id = ANY(%s)")
    unassigned = _trial_catalog_temp_unassigned_sql(" AND ps.planner_ps_id = ANY(%s)")
    for sql in (assigned, unassigned):
        assert "pp_vouchers_cache" not in sql
        assert "voucher_partials" not in sql
        assert "planner_process_sheet" in sql



def test_tooling_map_does_not_run_alter_table(monkeypatch):
    def boom(_con):
        raise AssertionError("board load must not ALTER planner_operation")

    monkeypatch.setattr(
        "planning.process_sheets._apply_tooling_assumed_ready_defaults",
        boom,
    )
    monkeypatch.setattr(
        "planning.process_sheets._tooling_column_flags",
        lambda _con: {"tooling_ready": False, "tooling_ready_date": False},
    )
    assert tooling_map_for_operation_ids(object(), [11, 12]) == {11: True, 12: True}
    assert tooling_map_for_ps_op_keys(object(), [("PS-1", 40)]) == {("PS-1", 40): True}
