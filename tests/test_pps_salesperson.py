"""PPS tracking should carry the sales order's salesperson onto each job."""

from planning.pps_route import _PPS_SO_VALUES_SQL


def _norm(sql: str) -> str:
    return " ".join(sql.split()).lower()


def test_pps_sales_order_lookup_includes_salesperson():
    sql = _norm(_PPS_SO_VALUES_SQL)
    assert "from public.so_order_header" in sql
    assert "sales_person_code" in sql
    assert "sales_person_name" in sql
    assert "sales_order_value" in sql
