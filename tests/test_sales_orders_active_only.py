"""S/O Management active load must not rebuild complete ERP history."""

import planning.erp_route_cache as erp_route_cache
from planning.sales_orders_route import (
    _ACTIVE_PP_AND,
    _COMPLETE_PP_AND,
    _MFG_PP_VCH_SQL,
    _build_sales_orders,
    _fetch_sales_orders,
    _patch_sales_orders_pp_notes,
    _restrict_sql,
    _sales_orders_cache_key,
    _scoped_pp_sql,
    patch_sales_orders_material_in,
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
    assert erp_route_cache.get("sales_orders:v23:active", ttl_sec=999) is None
    assert erp_route_cache.get("sales_orders:v23:active", ttl_sec=0) == {"active": []}


def test_cached_fetch_serves_stale_after_expire(monkeypatch, tmp_path):
    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    monkeypatch.setattr(erp_route_cache, "_spawn_refresh", lambda *_args, **_kwargs: None)
    erp_route_cache.set("sales_orders:v23:active:lite", {"active": [{"so": "1"}]})
    erp_route_cache.invalidate_prefix("sales_orders:")
    loaded = []
    payload = erp_route_cache.cached_fetch(
        "sales_orders:v23:active:lite",
        lambda: loaded.append("hit") or {"active": [{"so": "2"}]},
        ttl_sec=10,
    )
    assert payload == {"active": [{"so": "1"}]}
    assert loaded == []


def test_sales_orders_cache_keys_are_scoped():
    assert _sales_orders_cache_key("active").endswith(":active")
    assert _sales_orders_cache_key("complete").endswith(":complete")
    assert _sales_orders_cache_key("active") != _sales_orders_cache_key("complete")
    assert _sales_orders_cache_key("active", lite=True).endswith(":active:lite")
    assert _sales_orders_cache_key("active", lite=True) != _sales_orders_cache_key("active")


def test_active_only_fetch_does_not_build_complete(monkeypatch):
    built = []

    def fake_build(*, scope, lite=False):
        built.append(scope)
        return {
            "active": [{"sales_order_no": "SO/1", "pp_vouchers": [{}]}],
            "complete": [{"sales_order_no": "SO/9", "pp_vouchers": [{}]}],
            "frame_agreement_parts": [],
        }

    monkeypatch.setattr("planning.erp_route_cache.cached_fetch", lambda _key, loader, **_kwargs: loader())
    monkeypatch.setattr("planning.erp_route_cache.get", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("planning.sales_orders_route._build_sales_orders", fake_build)
    monkeypatch.setattr("planning.sales_orders_route._overlay_planner_edits", lambda payload: payload)

    payload = _fetch_sales_orders(active_only=True)
    assert built == ["active"]
    assert payload["complete"] == []
    assert len(payload["active"]) == 1


def test_full_fetch_builds_active_then_complete(monkeypatch):
    built = []

    def fake_build(*, scope, lite=False):
        built.append(scope)
        bucket = "active" if scope == "active" else "complete"
        return {
            "active": [{"sales_order_no": "SO/A", "pp_vouchers": [{}]}] if bucket == "active" else [],
            "complete": [{"sales_order_no": "SO/C", "pp_vouchers": [{}, {}]}] if bucket == "complete" else [],
            "frame_agreement_parts": [],
        }

    monkeypatch.setattr("planning.erp_route_cache.cached_fetch", lambda _key, loader, **_kwargs: loader())
    monkeypatch.setattr("planning.sales_orders_route._build_sales_orders", fake_build)
    monkeypatch.setattr("planning.sales_orders_route._overlay_planner_edits", lambda payload: payload)

    payload = _fetch_sales_orders(active_only=False)
    assert built == ["active", "complete"]
    assert payload["complete_job_count"] == 2
    assert len(payload["complete"]) == 1


def test_complete_build_skips_live_wo_overlays(monkeypatch):
    called = []

    monkeypatch.setattr("planning.sales_orders_route._erp_query", lambda *_args, **_kwargs: [])
    monkeypatch.setattr("planning.sales_orders_route._erp_query_for_ids", lambda *_args, **_kwargs: [])
    monkeypatch.setattr("planning.sales_orders_route._load_notes_map", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_process_sheet_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_part_desc_map", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_coway_edd_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr(
        "planning.sales_orders_route._load_stage_overlay",
        lambda _ids, **_kwargs: called.append("stage") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._load_wo_qty_overlay",
        lambda _ids, **_kwargs: called.append("wo") or {},
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


def _stub_sales_order_build(monkeypatch, called):
    monkeypatch.setattr("planning.sales_orders_route._erp_query", lambda *_args, **_kwargs: [])
    monkeypatch.setattr("planning.sales_orders_route._erp_query_for_ids", lambda *_args, **_kwargs: [])
    monkeypatch.setattr("planning.sales_orders_route._load_notes_map", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_process_sheet_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_part_desc_map", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_coway_edd_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr(
        "planning.sales_orders_route._load_stage_overlay",
        lambda _ids, **_kwargs: called.append("stage") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._load_wo_qty_overlay",
        lambda _ids, **_kwargs: called.append("wo") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._load_queued_machines_by_canonical_ps",
        lambda: called.append("queue") or {},
    )
    monkeypatch.setattr(
        "planning.sales_orders_route._apply_new_part_overlay",
        lambda _orders: called.append("newpart"),
    )


def test_lite_active_build_skips_new_part_and_queue(monkeypatch):
    called = []
    _stub_sales_order_build(monkeypatch, called)
    payload = _build_sales_orders(scope="active", lite=True)
    assert "newpart" not in called
    assert "queue" not in called
    assert "stage" in called
    assert "wo" in called
    assert payload["complete"] == []


def test_lite_fetch_uses_lite_cache_key(monkeypatch):
    keys = []

    def fake_build(*, scope, lite=False):
        return {
            "active": [{"sales_order_no": "SO/1", "pp_vouchers": [{}]}],
            "complete": [],
            "frame_agreement_parts": [],
        }

    def fake_cached_fetch(key, loader, **_kwargs):
        keys.append(key)
        return loader()

    monkeypatch.setattr("planning.erp_route_cache.cached_fetch", fake_cached_fetch)
    monkeypatch.setattr("planning.erp_route_cache.get", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("planning.sales_orders_route._build_sales_orders", fake_build)
    monkeypatch.setattr("planning.sales_orders_route._overlay_planner_edits", lambda payload: payload)

    payload = _fetch_sales_orders(active_only=True, lite=True)
    assert keys == [_sales_orders_cache_key("active", lite=True)]
    assert payload["complete"] == []
    assert len(payload["active"]) == 1


def test_lite_active_build_uses_staging_not_live(monkeypatch):
    live_flags = []

    def capture_erp(*_args, **kwargs):
        live_flags.append(kwargs.get("live"))
        return []

    def capture_ids(*_args, **kwargs):
        live_flags.append(kwargs.get("live"))
        return []

    def capture_overlay(_ids, **kwargs):
        live_flags.append(kwargs.get("live"))
        return {}

    monkeypatch.setattr("planning.sales_orders_route._erp_query", capture_erp)
    monkeypatch.setattr("planning.sales_orders_route._erp_query_for_ids", capture_ids)
    monkeypatch.setattr("planning.sales_orders_route._load_notes_map", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_process_sheet_overlay", capture_overlay)
    monkeypatch.setattr("planning.sales_orders_route._load_part_desc_map", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_coway_edd_overlay", lambda _ids, **_kwargs: {})
    monkeypatch.setattr("planning.sales_orders_route._load_stage_overlay", capture_overlay)
    monkeypatch.setattr("planning.sales_orders_route._load_wo_qty_overlay", capture_overlay)
    monkeypatch.setattr(
        "planning.sales_orders_route._load_queued_machines_by_canonical_ps",
        lambda: {},
    )
    monkeypatch.setattr("planning.sales_orders_route._apply_new_part_overlay", lambda _orders: None)

    _build_sales_orders(scope="active", lite=True)
    assert live_flags
    assert all(flag is False for flag in live_flags)


def test_cached_fetch_single_flight(monkeypatch, tmp_path):
    import threading
    import time

    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    started = threading.Barrier(2)
    loads = []

    def loader():
        loads.append("load")
        time.sleep(0.2)
        return {"active": [{"so": "1"}]}

    results = []

    def run():
        started.wait()
        results.append(
            erp_route_cache.cached_fetch("sales_orders:v23:active:lite", loader, ttl_sec=10)
        )

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert loads == ["load"]
    assert results == [{"active": [{"so": "1"}]}, {"active": [{"so": "1"}]}]


def _pp_payload(pp_voucher_no, *, material_subcon="", process_sheet_no=None, material_in=False):
    return {
        "active": [
            {
                "sales_order_no": "SO/1",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": pp_voucher_no,
                        "process_sheet_no": process_sheet_no or pp_voucher_no,
                        "material_subcon": material_subcon,
                        "material_in": material_in,
                        "material_in_date": None,
                    }
                ],
            }
        ],
        "complete": [],
    }


def test_update_data_patches_stale_cache_without_clearing_expire(monkeypatch, tmp_path):
    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    key = "sales_orders:v23:active:lite"
    erp_route_cache.set(key, {"active": [{"so": "1"}]})
    cached_at = erp_route_cache._cache_path(key).read_text(encoding="utf-8")
    erp_route_cache.invalidate_prefix("sales_orders:")

    patched = erp_route_cache.update_data(key, lambda data: data.update(active=[{"so": "2"}]) or True)

    assert patched is True
    assert erp_route_cache.get(key, ttl_sec=999) is None
    assert erp_route_cache.get(key, ttl_sec=0) == {"active": [{"so": "2"}]}
    after = erp_route_cache._cache_path(key).read_text(encoding="utf-8")
    assert '"cached_at"' in after
    import json

    before_ts = json.loads(cached_at)["cached_at"]
    after_ts = json.loads(after)["cached_at"]
    assert after_ts == before_ts


def test_fetch_restores_material_dates_from_notes(monkeypatch):
    cached = _pp_payload("PP/1", material_subcon="")
    monkeypatch.setattr("planning.erp_route_cache.cached_fetch", lambda *_args, **_kwargs: cached)
    monkeypatch.setattr("planning.erp_route_cache.get", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "planning.sales_orders_route._load_notes_map",
        lambda _ids: {
            "PP/1": {
                "material_subcon": "2026-08-01",
                "mtl_part_order": "rush",
                "material_need_date": "2026-09-15",
            }
        },
    )
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: {})

    payload = _fetch_sales_orders(active_only=True, lite=True)
    pp = payload["active"][0]["pp_vouchers"][0]
    assert pp["material_subcon"] == "2026-08-01"
    assert pp["mtl_part_order"] == "rush"
    assert pp["material_need_date"] == "2026-09-15"


def test_overlay_skips_wipe_when_notes_load_fails(monkeypatch):
    cached = _pp_payload("PP/1", material_subcon="2026-07-15")
    monkeypatch.setattr(
        "planning.sales_orders_route._load_notes_map",
        lambda _ids: None,
    )
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: None)

    from planning.sales_orders_route import _overlay_planner_edits

    payload = _overlay_planner_edits(cached)
    assert payload["active"][0]["pp_vouchers"][0]["material_subcon"] == "2026-07-15"


def test_patch_sales_orders_pp_notes_updates_file_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    key = _sales_orders_cache_key("active", lite=True)
    erp_route_cache.set(key, _pp_payload("PP/1"))

    _patch_sales_orders_pp_notes("PP/1", {"material_subcon": "2026-08-21"})

    cached = erp_route_cache.get(key, ttl_sec=999)
    assert cached["active"][0]["pp_vouchers"][0]["material_subcon"] == "2026-08-21"


def test_material_in_patch_updates_file_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    key = _sales_orders_cache_key("active", lite=True)
    erp_route_cache.set(key, _pp_payload("PP/1", process_sheet_no="NPS25-0335"))

    patch_sales_orders_material_in("NPS25-0335", {"material_in": True, "material_in_date": "2026-08-19"})

    cached = erp_route_cache.get(key, ttl_sec=999)
    pp = cached["active"][0]["pp_vouchers"][0]
    assert pp["material_in"] is True
    assert pp["material_in_date"] == "2026-08-19"


def test_parse_material_need_date_accepts_iso_and_dmy():
    from datetime import date

    from planning.sales_orders_route import _empty_notes, _notes_from_row, _parse_material_need_date

    assert _parse_material_need_date("2026-09-15") == "2026-09-15"
    assert _parse_material_need_date("15/09/2026") == "2026-09-15"
    assert _parse_material_need_date(date(2026, 9, 15)) == "2026-09-15"
    assert _parse_material_need_date("") == ""
    assert _parse_material_need_date(None) == ""
    assert _parse_material_need_date("not-a-date") == ""

    empty = _empty_notes()
    assert empty["material_need_date"] == ""
    assert empty["material_delay"] is False

    parsed = _notes_from_row({"material_need_date": date(2026, 9, 15), "material_delay": True})
    assert parsed["material_need_date"] == "2026-09-15"
    assert parsed["material_delay"] is True


def test_notes_api_accepts_material_need_date(monkeypatch):
    import os
    from unittest.mock import patch

    from app import app
    from planning.sales_orders_route import _empty_notes

    captured = []

    def fake_upsert(pp_voucher_no, patch):
        captured.append({"pp": pp_voucher_no, "patch": dict(patch)})
        return {"pp_voucher_no": pp_voucher_no, **_empty_notes(), **patch}

    monkeypatch.setattr("planning.sales_orders_route._upsert_notes", fake_upsert)
    monkeypatch.setattr("planning.sales_orders_route._patch_sales_orders_pp_notes", lambda *_args, **_kwargs: None)

    client = app.test_client()
    with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
        ok = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"material_need_date": "15/09/2026"},
        )
        bad = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"material_need_date": "soon"},
        )
        cleared = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"material_need_date": ""},
        )

    assert ok.status_code == 200
    assert ok.get_json()["material_need_date"] == "2026-09-15"
    assert captured[0]["pp"] == "PP/1"
    assert captured[0]["patch"]["material_need_date"] == "2026-09-15"
    assert bad.status_code == 400
    assert "YYYY-MM-DD" in bad.get_json()["error"]
    assert cleared.status_code == 200
    assert cleared.get_json()["material_need_date"] == ""
    assert captured[1]["patch"]["material_need_date"] == ""