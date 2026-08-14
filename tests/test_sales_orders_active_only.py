"""S/O Management active load must not rebuild complete ERP history."""

import planning.erp_route_cache as erp_route_cache
from planning.sales_orders_route import (
    _ACTIVE_PP_AND,
    _COMPLETE_PP_AND,
    _MFG_PP_VCH_SQL,
    _build_sales_orders,
    _fetch_sales_orders,
    _restrict_sql,
    _sales_orders_cache_key,
    _scoped_pp_sql,
)
from planning.utils import shipped_quantity_completed


def test_restrict_sql_inserts_before_order_by():
    sql = _restrict_sql(_MFG_PP_VCH_SQL, _ACTIVE_PP_AND)
    assert "COALESCE(sq.qty_shipped, 0) < det.qty - 0.0001" in sql
    assert sql.upper().rindex("AND (") < sql.upper().rindex("ORDER BY")


def test_restrict_sql_appends_when_no_order_by():
    sql = _restrict_sql("SELECT 1 FROM t", "WHERE id = ANY(%s)")
    assert sql.strip().endswith("WHERE id = ANY(%s)")


def test_active_and_complete_sql_match_shipped_helper():
    cases = [
        (None, 0, True),
        (10, 0, True),
        (10, 9, True),
        (10, 9.9998, True),
        (10, 9.9999, False),
        (10, 10, False),
        (0, 0, False),
    ]
    for qty, shipped, want_active in cases:
        py_complete = shipped_quantity_completed(qty, shipped)
        sql_active = qty is None or (shipped or 0) < qty - 0.0001
        sql_complete = qty is not None and (shipped or 0) >= qty - 0.0001
        assert sql_active is want_active, (qty, shipped)
        assert sql_active is (not py_complete), (qty, shipped)
        assert sql_complete is py_complete, (qty, shipped)


def test_scoped_pp_sql_filters_active_and_complete():
    active_staged, active_live = _scoped_pp_sql("active")
    complete_staged, complete_live = _scoped_pp_sql("complete")
    assert _ACTIVE_PP_AND.strip() in active_staged
    assert _ACTIVE_PP_AND.strip() in active_live
    assert _COMPLETE_PP_AND.strip() in complete_staged
    assert _COMPLETE_PP_AND.strip() in complete_live
    assert _COMPLETE_PP_AND.strip() not in active_live
    assert _ACTIVE_PP_AND.strip() not in complete_live


def test_erp_route_cache_stores_key_for_prefix_invalidation(monkeypatch, tmp_path):
    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    erp_route_cache.set("sales_orders:v23:active", {"active": []})
    erp_route_cache.set("other:v1", {"x": 1})
    assert erp_route_cache.invalidate_prefix("sales_orders:") == 1
    assert erp_route_cache.get("other:v1", ttl_sec=999) == {"x": 1}


def test_sales_orders_cache_keys_are_scoped():
    assert _sales_orders_cache_key("active").endswith(":active")
    assert _sales_orders_cache_key("complete").endswith(":complete")
    assert _sales_orders_cache_key("active") != _sales_orders_cache_key("complete")


def test_active_only_fetch_does_not_build_complete(monkeypatch):
    built = []

    def fake_build(*, scope):
        built.append(scope)
        return {
            "active": [{"sales_order_no": "SO/1", "pp_vouchers": [{}]}],
            "complete": [{"sales_order_no": "SO/9", "pp_vouchers": [{}]}],
            "frame_agreement_parts": [],
        }

    monkeypatch.setattr("planning.erp_route_cache.cached_fetch", lambda _key, loader, **_kwargs: loader())
    monkeypatch.setattr("planning.erp_route_cache.get", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("planning.sales_orders_route._build_sales_orders", fake_build)

    payload = _fetch_sales_orders(active_only=True)
    assert built == ["active"]
    assert payload["complete"] == []
    assert len(payload["active"]) == 1


def test_full_fetch_builds_active_then_complete(monkeypatch):
    built = []

    def fake_build(*, scope):
        built.append(scope)
        bucket = "active" if scope == "active" else "complete"
        return {
            "active": [{"sales_order_no": "SO/A", "pp_vouchers": [{}]}] if bucket == "active" else [],
            "complete": [{"sales_order_no": "SO/C", "pp_vouchers": [{}, {}]}] if bucket == "complete" else [],
            "frame_agreement_parts": [],
        }

    monkeypatch.setattr("planning.erp_route_cache.cached_fetch", lambda _key, loader, **_kwargs: loader())
    monkeypatch.setattr("planning.sales_orders_route._build_sales_orders", fake_build)

    payload = _fetch_sales_orders(active_only=False)
    assert built == ["active", "complete"]
    assert payload["complete_job_count"] == 2
    assert len(payload["complete"]) == 1


def test_complete_build_skips_live_wo_overlays(monkeypatch):
    called = []

    monkeypatch.setattr("planning.sales_orders_route._erp_query", lambda *_args, **_kwargs: [])
    monkeypatch.setattr("planning.sales_orders_route._erp_query_for_ids", lambda *_args, **_kwargs: [])
    monkeypatch.setattr("planning.sales_orders_route._load_notes_map", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._load_process_sheet_overlay", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._load_part_desc_map", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._load_coway_edd_overlay", lambda _ids: {})
    monkeypatch.setattr(
        "planning.sales_orders_route._load_stage_overlay",
        lambda _ids: called.append("stage") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._load_wo_qty_overlay",
        lambda _ids: called.append("wo") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._load_queued_machines_by_canonical_ps",
        lambda: called.append("queue") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._apply_new_part_overlay",
        lambda _orders: called.append("newpart"),
    )

    payload = _build_sales_orders(scope="complete")
    assert called == []
    assert payload["active"] == []
    assert payload["complete"] == []
