"""Invalidate and optionally warm in-process ERP read caches after staging sync."""
from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)


def invalidate_erp_route_caches() -> None:
    """Clear module-level TTL caches for ERP-backed list pages."""
    from planning.bom_variation_route import invalidate_bom_variation_cache
    from planning.finishing_queue_route import invalidate_finishing_queue_cache
    from planning.inventory_enquiry_route import invalidate_inventory_enquiry_cache
    from planning.material_inspection_route import invalidate_material_inspection_cache
    from planning.new_orders_route import invalidate_new_orders_cache
    from planning.sales_orders_route import invalidate_sales_orders_cache

    invalidate_sales_orders_cache()
    invalidate_new_orders_cache()
    invalidate_material_inspection_cache()
    invalidate_inventory_enquiry_cache()
    invalidate_finishing_queue_cache()
    invalidate_bom_variation_cache()


def invalidate_pp_vouchers_memory_cache() -> None:
    from app import _invalidate_pp_vouchers_with_ops_cache

    _invalidate_pp_vouchers_with_ops_cache()


def invalidate_all_erp_read_caches() -> None:
    invalidate_pp_vouchers_memory_cache()
    invalidate_erp_route_caches()


def warm_erp_read_caches() -> dict:
    """Rebuild hot caches so counts are correct immediately after sync."""
    warmed: dict[str, object] = {}

    try:
        from planning.sales_orders_route import _fetch_sales_orders

        data = _fetch_sales_orders(refresh=True)
        warmed["sales_orders"] = {
            "active": len(data.get("active") or []),
            "complete": len(data.get("complete") or []),
        }
    except Exception as exc:
        logger.warning("sales orders cache warm failed: %s", exc, exc_info=True)
        warmed["sales_orders"] = {"error": str(exc)}

    try:
        from app import (
            _build_pp_vouchers_with_ops_data,
            _load_pp_vouchers_board_erp_data,
            _pp_vouchers_cache_scope,
            _store_pp_vouchers_with_ops_cache,
        )
        from planning.helpers import planner_db

        for include_completed in (False, True):
            scope = _pp_vouchers_cache_scope(include_completed)
            with planner_db() as con:
                data = _build_pp_vouchers_with_ops_data(include_completed, con)
            _store_pp_vouchers_with_ops_cache(scope, data)
            _load_pp_vouchers_board_erp_data(include_completed, refresh=True, scope=scope)
            warmed[f"pp_vouchers_{scope}"] = len(data)
    except Exception as exc:
        logger.warning("pp vouchers cache warm failed: %s", exc, exc_info=True)
        warmed["pp_vouchers"] = {"error": str(exc)}

    return warmed


def refresh_after_erp_sync(*, warm: bool = True, background: bool = True) -> dict:
    """Invalidate stale caches, reconcile machine queue OUT qty, optionally warm caches."""
    invalidate_all_erp_read_caches()

    queue_reconcile: dict[str, object] = {}
    snapshot_count = 0
    try:
        from planning.erp_actuals import (
            reconcile_queue_states_after_erp_sync,
            record_erp_wo_qty_snapshots_from_staging,
        )
        from planning.helpers import planner_db

        with planner_db() as con:
            try:
                snapshot_count = record_erp_wo_qty_snapshots_from_staging(con)
            except Exception as exc:
                logger.warning("erp wo qty snapshot (post-sync) failed: %s", exc, exc_info=True)
            queue_reconcile = reconcile_queue_states_after_erp_sync(con)
    except Exception as exc:
        logger.warning("queue state ERP reconcile after sync failed: %s", exc, exc_info=True)
        queue_reconcile = {"error": str(exc)}

    if not warm:
        return {
            "invalidated": True,
            "warmed": False,
            "queue_reconcile": queue_reconcile,
            "erp_snapshot_count": snapshot_count,
        }

    if background:
        threading.Thread(
            target=warm_erp_read_caches,
            name="erp-cache-warm",
            daemon=True,
        ).start()
        return {
            "invalidated": True,
            "warmed": True,
            "background": True,
            "queue_reconcile": queue_reconcile,
            "erp_snapshot_count": snapshot_count,
        }

    return {
        "invalidated": True,
        "warmed": True,
        "details": warm_erp_read_caches(),
        "queue_reconcile": queue_reconcile,
        "erp_snapshot_count": snapshot_count,
    }
