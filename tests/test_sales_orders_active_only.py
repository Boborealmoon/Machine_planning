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
    monkeypatch.setattr("planning.sales_orders_route._apply_proposed_cnc_overlay", lambda _orders: None)
    monkeypatch.setattr("planning.sales_orders_route._load_program_finish_overlay", lambda _ids: {})

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
    monkeypatch.setattr("planning.sales_orders_route._apply_proposed_cnc_overlay", lambda _orders: None)
    monkeypatch.setattr("planning.sales_orders_route._load_program_finish_overlay", lambda _ids: None)

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
    assert empty["material_need_date_history_count"] == 0
    assert empty["material_in_date_history_count"] == 0

    parsed = _notes_from_row({"material_need_date": date(2026, 9, 15), "material_delay": True})
    assert parsed["material_need_date"] == "2026-09-15"
    assert parsed["material_delay"] is True
    assert parsed["material_need_date_history_count"] == 0
    assert parsed["material_in_date_history_count"] == 0


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


def test_date_history_changes_need_and_in_dates():
    from planning.sales_orders_route import _date_history_changes, _in_date_history_value

    assert _in_date_history_value("2026-11-27") == "2026-11-27"
    assert _in_date_history_value("ARRIVED") == ""
    assert _in_date_history_value("") == ""

    need_changes = _date_history_changes(
        {"material_need_date": "", "material_subcon": ""},
        {"material_need_date": "2026-09-23", "material_subcon": ""},
    )
    assert need_changes == [{
        "field_name": "material_need_date",
        "old_value": "",
        "new_value": "2026-09-23",
    }]

    in_changes = _date_history_changes(
        {"material_need_date": "2026-09-23", "material_subcon": "2026-11-27"},
        {"material_need_date": "2026-09-23", "material_subcon": "2026-12-01"},
    )
    assert in_changes == [{
        "field_name": "material_in_date",
        "old_value": "2026-11-27",
        "new_value": "2026-12-01",
    }]

    arrived = _date_history_changes(
        {"material_need_date": "", "material_subcon": "2026-11-27"},
        {"material_need_date": "", "material_subcon": "ARRIVED"},
    )
    assert arrived == []

    unarrive_to_date = _date_history_changes(
        {"material_need_date": "", "material_subcon": "ARRIVED"},
        {"material_need_date": "", "material_subcon": "2026-11-27"},
    )
    assert unarrive_to_date == [{
        "field_name": "material_in_date",
        "old_value": "",
        "new_value": "2026-11-27",
    }]

    unchanged = _date_history_changes(
        {"material_need_date": "2026-09-23", "material_subcon": "2026-11-27"},
        {"material_need_date": "2026-09-23", "material_subcon": "2026-11-27"},
    )
    assert unchanged == []


def test_date_history_api_validates_and_lists(monkeypatch):
    import os
    from unittest.mock import patch

    from app import app

    monkeypatch.setattr("planning.sales_orders_route._patch_sales_orders_pp_notes", lambda *_args, **_kwargs: None)
    client = app.test_client()
    rows = [{
        "change_id": 1,
        "pp_voucher_no": "PP/1",
        "field_name": "material_need_date",
        "field_label": "Need date",
        "old_value": "",
        "new_value": "2026-09-23",
        "changed_at": "2026-09-10 11:00:00",
    }]
    with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
        missing_pp = client.get("/api/sales-orders/date-history?field=material_need_date")
        bad_field = client.get("/api/sales-orders/date-history?pp_voucher_no=PP/1&field=notes")
        with patch(
            "planning.sales_orders_route._list_date_history",
            return_value=rows,
        ) as list_fn:
            ok = client.get(
                "/api/sales-orders/date-history?pp_voucher_no=PP/1&field=material_need_date"
            )

    assert missing_pp.status_code == 400
    assert "pp_voucher_no" in missing_pp.get_json()["error"]
    assert bad_field.status_code == 400
    assert "material_need_date" in bad_field.get_json()["error"]
    assert ok.status_code == 200
    body = ok.get_json()
    assert body["ok"] is True
    assert body["count"] == 1
    assert body["field_label"] == "Need date"
    assert body["rows"][0]["new_value"] == "2026-09-23"
    list_fn.assert_called_once()
    assert list_fn.call_args.args[0] == "PP/1"
    assert list_fn.call_args.args[1] == "material_need_date"


def test_notes_api_accepts_buyer(monkeypatch):
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
            "/api/sales-orders/notes/APS26-1",
            json={"buyer": "  Jane  "},
        )

    assert ok.status_code == 200
    assert ok.get_json()["buyer"] == "Jane"
    assert captured[0]["pp"] == "APS26-1"
    assert captured[0]["patch"]["buyer"] == "Jane"


def test_notes_from_row_parses_exception_issues():
    from planning.sales_orders_route import (
        _apply_partial_exception,
        _empty_notes,
        _format_exception_issues,
        _normalize_exception_issue,
        _notes_from_row,
        _parse_exception_issues,
        _sync_exception_issues,
    )

    empty = _empty_notes()
    assert empty["exception_issues"] == {}
    assert empty["highlighted_partials"] == []

    assert _normalize_exception_issue("Process / Engr") == "process_engr"
    assert _normalize_exception_issue("Qlty") == "qlty"
    assert _normalize_exception_issue("supply chain") == "supply_chain"
    assert _parse_exception_issues('{"1":"qlty","2":"Sales"}') == {1: ["qlty"], 2: ["sales"]}
    assert _parse_exception_issues('{"1":["qlty","Sales"]}') == {1: ["qlty", "sales"]}
    assert _format_exception_issues({1: ["qlty", "sales"]}) == '{"1":["qlty","sales"]}'
    assert _format_exception_issues({1: "qlty", 2: "sales"}) == '{"1":["qlty"],"2":["sales"]}'
    assert _sync_exception_issues([1, 3], {1: "supply_chain"}) == {
        1: ["supply_chain"],
        3: ["others"],
    }

    parsed = _notes_from_row({
        "ps_highlighted": True,
        "highlighted_partials": "1,2",
        "exception_issues": '{"1":"supply_chain"}',
    })
    assert parsed["highlighted_partials"] == [1, 2]
    assert parsed["exception_issues"] == {"1": ["supply_chain"], "2": ["others"]}

    current = _empty_notes()
    _apply_partial_exception(current, partial_no=1, issues=["Qlty", "Sales"], issues_provided=True)
    assert current["highlighted_partials"] == [1]
    assert current["ps_highlighted"] is True
    assert current["exception_issues"] == {"1": ["qlty", "sales"]}
    _apply_partial_exception(current, partial_no=1, issues=[], issues_provided=True)
    assert current["highlighted_partials"] == []
    assert current["exception_issues"] == {}


def test_notes_api_accepts_exception_issue(monkeypatch):
    import os
    from unittest.mock import patch

    from app import app
    from planning.sales_orders_route import _apply_partial_exception, _empty_notes

    captured = []

    def fake_upsert(pp_voucher_no, patch):
        captured.append({"pp": pp_voucher_no, "patch": dict(patch)})
        toggle = patch.get("partial_highlight") or {}
        notes = _empty_notes()
        issue_provided = "issue" in toggle
        issues_provided = "issues" in toggle
        _apply_partial_exception(
            notes,
            partial_no=int(toggle.get("pp_partial_no") or 1),
            highlighted=None if (issue_provided or issues_provided) else bool(toggle.get("highlighted")),
            issue=toggle.get("issue") if issue_provided else None,
            issues=toggle.get("issues") if issues_provided else None,
            issue_provided=issue_provided and not issues_provided,
            issues_provided=issues_provided,
        )
        return {"pp_voucher_no": pp_voucher_no, **notes}

    monkeypatch.setattr("planning.sales_orders_route._upsert_notes", fake_upsert)
    monkeypatch.setattr("planning.sales_orders_route._patch_sales_orders_pp_notes", lambda *_args, **_kwargs: None)

    client = app.test_client()
    with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
        ok = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"partial_highlight": {"pp_partial_no": 2, "issue": "Process / Engr"}},
        )
        multi = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"partial_highlight": {"pp_partial_no": 2, "issues": ["Supply Chain", "Qlty"]}},
        )
        cleared = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"partial_highlight": {"pp_partial_no": 2, "issues": []}},
        )
        cleared_legacy = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"partial_highlight": {"pp_partial_no": 2, "issue": ""}},
        )
        bad = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"partial_highlight": {"pp_partial_no": 2, "issue": "unknown"}},
        )
        bad_issues = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"partial_highlight": {"pp_partial_no": 2, "issues": ["unknown"]}},
        )

    assert ok.status_code == 200
    assert ok.get_json()["exception_issues"] == {"2": ["process_engr"]}
    assert captured[0]["patch"]["partial_highlight"]["issue"] == "process_engr"
    assert multi.status_code == 200
    assert multi.get_json()["exception_issues"] == {"2": ["supply_chain", "qlty"]}
    assert captured[1]["patch"]["partial_highlight"]["issues"] == ["supply_chain", "qlty"]
    assert cleared.status_code == 200
    assert cleared.get_json()["exception_issues"] == {}
    assert cleared_legacy.status_code == 200
    assert cleared_legacy.get_json()["exception_issues"] == {}
    assert bad.status_code == 400
    assert "Supply Chain" in bad.get_json()["error"]
    assert bad_issues.status_code == 400
    assert "Supply Chain" in bad_issues.get_json()["error"]


def test_proposed_cnc_overlay_maps_by_part_number(monkeypatch):
    from planning.sales_orders_route import _apply_proposed_cnc_overlay

    orders = [
        {
            "sales_order_no": "SO/1",
            "pp_vouchers": [
                {
                    "process_sheet_no": "NPS26-100",
                    "pp_voucher_no": "PP/1",
                    "inventory_code": "BB27-KS0040-13 REV 03",
                    "partials": [
                        {"pp_partial_no": 1, "inventory_code": "BB27-KS0040-13 REV 03"},
                    ],
                }
            ],
        },
        {
            "sales_order_no": "SO/2",
            "pp_vouchers": [
                {
                    "process_sheet_no": "MPS26-999",
                    "pp_voucher_no": "PP/2",
                    "inventory_code": "BB27-KS0040-13 REV 03",
                    "partials": [],
                },
                {
                    "process_sheet_no": "APS26-111",
                    "pp_voucher_no": "PP/3",
                    "inventory_code": "OTHER-PART",
                    "partials": [],
                },
            ],
        },
    ]
    monkeypatch.setattr(
        "planning.first_article_service.load_proposed_cnc_by_part",
        lambda live_by_ps=None: {
            "BB27-KS0040-13 REV 03": ["CNC 20", "CNC 22"],
        },
    )

    _apply_proposed_cnc_overlay(orders)
    first = orders[0]["pp_vouchers"][0]
    assert first["proposed_cnc"] == ["CNC 20", "CNC 22"]
    assert first["partials"][0]["proposed_cnc"] == ["CNC 20", "CNC 22"]
    assert orders[1]["pp_vouchers"][0]["proposed_cnc"] == ["CNC 20", "CNC 22"]
    assert orders[1]["pp_vouchers"][1]["proposed_cnc"] == []


def test_proposed_cnc_overlay_uses_saved_override(monkeypatch):
    from planning.sales_orders_route import _apply_proposed_cnc_overlay

    orders = [
        {
            "pp_vouchers": [
                {
                    "process_sheet_no": "NPS26-100",
                    "pp_voucher_no": "PP/1",
                    "inventory_code": "PART-A",
                    "proposed_cnc_saved": ["CNC 38"],
                    "partials": [{"pp_partial_no": 1, "inventory_code": "PART-A"}],
                },
                {
                    "process_sheet_no": "NPS26-101",
                    "pp_voucher_no": "PP/2",
                    "inventory_code": "PART-A",
                    "proposed_cnc_saved": None,
                    "partials": [{"pp_partial_no": 1}],
                },
            ]
        }
    ]
    monkeypatch.setattr(
        "planning.first_article_service.load_proposed_cnc_by_part",
        lambda live_by_ps=None: {"PART-A": ["CNC 20", "CNC 22"]},
    )
    _apply_proposed_cnc_overlay(orders)
    first, second = orders[0]["pp_vouchers"]
    assert first["proposed_cnc"] == ["CNC 38"]
    assert first["partials"][0]["proposed_cnc"] == ["CNC 38"]
    assert second["proposed_cnc"] == ["CNC 20", "CNC 22"]


def test_notes_from_row_parses_proposed_cnc():
    from planning.sales_orders_route import _empty_notes, _format_proposed_cnc, _notes_from_row, _parse_proposed_cnc

    empty = _empty_notes()
    assert empty["proposed_cnc_saved"] is None
    assert _parse_proposed_cnc("CNC 10, 22") == ["CNC 10", "22"]
    assert _format_proposed_cnc(["CNC 10", "CNC 22"]) == "CNC 10, CNC 22"
    assert _format_proposed_cnc(None) is None
    assert _format_proposed_cnc([]) == ""

    unset = _notes_from_row({"material_subcon": "x"})
    assert unset["proposed_cnc_saved"] is None
    parsed = _notes_from_row({"proposed_cnc": "CNC 20, CNC 22"})
    assert parsed["proposed_cnc_saved"] == ["CNC 20", "CNC 22"]
    cleared = _notes_from_row({"proposed_cnc": ""})
    assert cleared["proposed_cnc_saved"] == []


def test_notes_api_accepts_proposed_cnc(monkeypatch):
    import os
    from unittest.mock import patch

    from app import app
    from planning.sales_orders_route import _empty_notes

    captured = []

    def fake_upsert(pp_voucher_no, patch):
        captured.append({"pp": pp_voucher_no, "patch": dict(patch)})
        notes = _empty_notes()
        machines = patch.get("proposed_cnc") or []
        notes["proposed_cnc_saved"] = machines
        notes["proposed_cnc"] = machines
        return {"pp_voucher_no": pp_voucher_no, **notes}

    monkeypatch.setattr("planning.sales_orders_route._upsert_notes", fake_upsert)
    monkeypatch.setattr("planning.sales_orders_route._patch_sales_orders_pp_notes", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "planning.sales_orders_route._resolve_proposed_cnc",
        lambda raw: ["CNC 22"] if raw else [],
    )

    client = app.test_client()
    with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
        ok = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"proposed_cnc": ["22", "CNC 38"]},
        )
        cleared = client.patch(
            "/api/sales-orders/notes/PP/1",
            json={"proposed_cnc": []},
        )

    assert ok.status_code == 200
    assert captured[0]["patch"]["proposed_cnc"] == ["22", "CNC 38"]
    assert ok.get_json()["proposed_cnc"] == ["22", "CNC 38"]
    assert cleared.status_code == 200
    assert cleared.get_json()["proposed_cnc"] == []


def test_program_finish_iso_normalizes_datetime():
    from datetime import date, datetime

    from planning.sales_orders_route import _program_finish_iso

    assert _program_finish_iso("2026-07-31") == "2026-07-31"
    assert _program_finish_iso("2026-07-31T16:00:00") == "2026-07-31"
    assert _program_finish_iso("2026-07-31 16:00:00") == "2026-07-31"
    assert _program_finish_iso(date(2026, 9, 4)) == "2026-09-04"
    assert _program_finish_iso(datetime(2026, 9, 4, 16, 0)) == "2026-09-04"
    assert _program_finish_iso("") == ""
    assert _program_finish_iso(None) == ""
    assert _program_finish_iso("31/07/2026") == ""


def test_program_finish_overlay_applies_by_process_sheet():
    from planning.sales_orders_route import _apply_program_finish_overlay

    orders = [
        {
            "pp_vouchers": [
                {"process_sheet_no": "nps26-0397", "pp_voucher_no": "PP/1"},
                {"process_sheet_no": "APS26-0001", "pp_voucher_no": "PP/2"},
            ]
        }
    ]
    _apply_program_finish_overlay(orders, {"NPS26-0397": "2026-07-31"})
    assert orders[0]["pp_vouchers"][0]["program_finish_at"] == "2026-07-31"
    assert orders[0]["pp_vouchers"][1]["program_finish_at"] == ""


def test_overlay_planner_edits_applies_program_finish(monkeypatch):
    cached = _pp_payload("PP/1", process_sheet_no="NPS26-0397")
    monkeypatch.setattr("planning.sales_orders_route._load_notes_map", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._apply_proposed_cnc_overlay", lambda _orders: None)
    monkeypatch.setattr(
        "planning.sales_orders_route._load_program_finish_overlay",
        lambda _ids: {"NPS26-0397": "2026-09-04"},
    )

    from planning.sales_orders_route import _overlay_planner_edits

    payload = _overlay_planner_edits(cached)
    assert payload["active"][0]["pp_vouchers"][0]["program_finish_at"] == "2026-09-04"

def test_overlay_child_process_sheet_notes_from_assembly_tracker(monkeypatch):
    from planning.sales_orders_route import _overlay_planner_edits

    cached = _pp_payload("PP/CHILD", process_sheet_no="NPS26-0321-1", material_subcon="")
    monkeypatch.setattr(
        "planning.sales_orders_route._load_notes_map",
        lambda _ids: {
            "NPS26-0321-1": {
                "material_subcon": "2027-01-08",
                "mtl_part_order": "Seq 1",
                "material_need_date": "2026-09-15",
            }
        },
    )
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._apply_proposed_cnc_overlay", lambda _orders: None)
    monkeypatch.setattr("planning.sales_orders_route._load_program_finish_overlay", lambda _ids: {})

    payload = _overlay_planner_edits(cached)
    pp = payload["active"][0]["pp_vouchers"][0]
    assert pp["material_subcon"] == "2027-01-08"
    assert pp["mtl_part_order"] == "Seq 1"
    assert pp["material_need_date"] == "2026-09-15"


def test_overlay_parent_uses_voucher_notes_not_child_sheet(monkeypatch):
    from planning.sales_orders_route import _overlay_planner_edits

    cached = _pp_payload("PP/1", process_sheet_no="NPS26-0321", material_subcon="")
    monkeypatch.setattr(
        "planning.sales_orders_route._load_notes_map",
        lambda _ids: {
            "PP/1": {
                "material_subcon": "2026-09-05",
                "mtl_part_order": "parent",
                "material_need_date": "",
            },
            "NPS26-0321-1": {
                "material_subcon": "2027-01-08",
                "mtl_part_order": "child",
                "material_need_date": "2026-12-01",
            },
        },
    )
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._apply_proposed_cnc_overlay", lambda _orders: None)
    monkeypatch.setattr("planning.sales_orders_route._load_program_finish_overlay", lambda _ids: {})

    payload = _overlay_planner_edits(cached)
    pp = payload["active"][0]["pp_vouchers"][0]
    assert pp["material_subcon"] == "2026-09-05"
    assert pp["mtl_part_order"] == "parent"


def test_queued_machines_overlay_matches_sheet_voucher_and_case():
    from planning.sales_orders_route import _apply_queued_machines_overlay

    orders = [
        {
            "pp_vouchers": [
                {
                    "process_sheet_no": "nps20-0358",
                    "pp_voucher_no": "PP/1",
                    "partials": [
                        {"pp_partial_no": 1},
                        {"pp_partial_no": 2},
                    ],
                },
                {
                    "process_sheet_no": "PP/2",
                    "pp_voucher_no": "NPS20-0400",
                    "partials": [],
                },
            ]
        }
    ]
    by_canonical = {
        "NPS20-0358": ["CNC 21"],
        "NPS20-0358::2": ["CNC 30"],
        "NPS20-0400": ["CNC 12"],
    }
    _apply_queued_machines_overlay(orders, by_canonical)
    first = orders[0]["pp_vouchers"][0]
    assert first["queued_machines"] == ["CNC 21", "CNC 30"]
    assert first["partials"][0]["queued_machines"] == ["CNC 21"]
    assert first["partials"][1]["queued_machines"] == ["CNC 30"]
    second = orders[0]["pp_vouchers"][1]
    assert second["queued_machines"] == ["CNC 12"]
    assert second["queued_machines_by_partial"]["1"] == ["CNC 12"]


def test_overlay_planner_edits_applies_queued_cnc(monkeypatch):
    from planning.sales_orders_route import _overlay_planner_edits

    cached = {
        "active": [
            {
                "sales_order_no": "SO/1",
                "pp_vouchers": [
                    {
                        "pp_voucher_no": "PP/1",
                        "process_sheet_no": "NPS20-0358",
                        "queued_machines": [],
                        "partials": [{"pp_partial_no": 1, "queued_machines": []}],
                    }
                ],
            }
        ],
        "complete": [],
    }
    monkeypatch.setattr("planning.sales_orders_route._load_notes_map", lambda _ids: {})
    monkeypatch.setattr("planning.sales_orders_route._load_material_in_overlay", lambda _ids: {})
    monkeypatch.setattr(
        "planning.sales_orders_route._load_queued_machines_by_canonical_ps",
        lambda: {"NPS20-0358": ["CNC 21"]},
    )
    monkeypatch.setattr("planning.sales_orders_route._apply_proposed_cnc_overlay", lambda _orders: None)
    monkeypatch.setattr("planning.sales_orders_route._load_program_finish_overlay", lambda _ids: {})

    payload = _overlay_planner_edits(cached)
    pp = payload["active"][0]["pp_vouchers"][0]
    assert pp["queued_machines"] == ["CNC 21"]
    assert pp["partials"][0]["queued_machines"] == ["CNC 21"]


def test_patch_sales_orders_pp_notes_matches_child_process_sheet(monkeypatch, tmp_path):
    monkeypatch.setattr(erp_route_cache, "_CACHE_DIR", tmp_path)
    key = _sales_orders_cache_key("active", lite=True)
    erp_route_cache.set(key, _pp_payload("PP/CHILD", process_sheet_no="NPS26-0321-1"))

    _patch_sales_orders_pp_notes("NPS26-0321-1", {"material_subcon": "2026-09-11"})

    cached = erp_route_cache.get(key, ttl_sec=999)
    assert cached["active"][0]["pp_vouchers"][0]["material_subcon"] == "2026-09-11"


def test_sales_orders_page_offers_exception_workbook_export():
    import os
    from unittest.mock import patch

    from app import app

    client = app.test_client()
    with patch.dict(os.environ, {"PLANNER_PASSCODE": "", "ADMIN_PASSCODE": ""}):
        response = client.get("/sales-orders")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'data-so-export-view="exceptions"' in html
    assert 'data-so-export-view="all"' in html
    assert "Ops / Sales / PP / SO remarks" in html
    assert "so-exception-export-remarks-20260921" in html

