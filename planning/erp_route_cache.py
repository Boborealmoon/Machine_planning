"""File-backed TTL cache shared across Flask workers on the same host."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_DIR = Path(__file__).resolve().parents[1] / "cache" / "erp_routes"
_CACHE_DIR = Path(os.getenv("ERP_ROUTE_CACHE_DIR", str(_DEFAULT_DIR)))
_DEFAULT_TTL = int(os.getenv("ERP_ROUTE_CACHE_TTL_SEC", "300"))

_refresh_lock = threading.Lock()
_refreshing: set[str] = set()
_inflight: dict[str, threading.Event] = {}


def _cache_path(key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return _CACHE_DIR / f"{digest}.json"


def _expired_path(path: Path) -> Path:
    return path.with_suffix(".expired")


def get(key: str, *, ttl_sec: int | None = None) -> Any | None:
    ttl = _DEFAULT_TTL if ttl_sec is None else ttl_sec
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        cached_at = float(payload.get("cached_at") or 0)
        if ttl > 0:
            if _expired_path(path).is_file():
                return None
            if (time.time() - cached_at) > ttl:
                return None
        return payload.get("data")
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def _write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, default=str), encoding="utf-8")
    tmp.replace(path)


def set(key: str, data: Any) -> None:
    path = _cache_path(key)
    _write_payload(path, {"cached_at": time.time(), "key": key, "data": data})
    marker = _expired_path(path)
    try:
        if marker.exists():
            marker.unlink()
    except OSError:
        pass


def update_data(key: str, mutator) -> bool:
    """Mutate cached payload in place, including stale/expired entries.

    Preserves cached_at and any expire marker so this is a data overlay, not a refresh.
    mutator(data) may return False to skip the write.
    """
    path = _cache_path(key)
    if not path.is_file():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return False
    data = payload.get("data")
    if data is None:
        return False
    if mutator(data) is False:
        return False
    payload["data"] = data
    payload["key"] = str(payload.get("key") or key)
    try:
        _write_payload(path, payload)
    except OSError:
        return False
    return True


def invalidate_prefix(prefix: str = "") -> int:
    """Expire matching entries without deleting them so stale reads still work."""
    if not _CACHE_DIR.is_dir():
        return 0
    expired = 0
    for path in _CACHE_DIR.glob("*.json"):
        if prefix:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                key = str(payload.get("key") or "")
            except (OSError, json.JSONDecodeError):
                key = ""
            if not key.startswith(prefix):
                continue
        try:
            _expired_path(path).write_text("1", encoding="utf-8")
            expired += 1
        except OSError:
            pass
    return expired


def clear_all() -> int:
    return invalidate_prefix("")


def _begin_load(cache_key: str) -> threading.Event | None:
    """Claim this key for loading, or return the event to wait on."""
    with _refresh_lock:
        if cache_key in _refreshing:
            event = _inflight.get(cache_key)
            if event is None:
                event = threading.Event()
                _inflight[cache_key] = event
            return event
        _refreshing.add(cache_key)
        _inflight[cache_key] = threading.Event()
        return None


def _finish_load(cache_key: str) -> None:
    with _refresh_lock:
        _refreshing.discard(cache_key)
        event = _inflight.pop(cache_key, None)
    if event is not None:
        event.set()


def _spawn_refresh(cache_key: str, loader) -> None:
    if _begin_load(cache_key) is not None:
        return

    def run() -> None:
        try:
            set(cache_key, loader())
        except Exception:
            logger.exception("background cache refresh failed (%s)", cache_key)
        finally:
            _finish_load(cache_key)

    threading.Thread(target=run, name=f"erp-cache-refresh:{cache_key[:40]}", daemon=True).start()


def cached_fetch(
    cache_key: str,
    loader,
    *,
    ttl_sec: int | None = None,
    refresh: bool = False,
    allow_stale: bool = True,
) -> Any:
    if not refresh:
        hit = get(cache_key, ttl_sec=ttl_sec)
        if hit is not None:
            return hit
        if allow_stale:
            stale = get(cache_key, ttl_sec=0)
            if stale is not None:
                _spawn_refresh(cache_key, loader)
                return stale
    wait_event = _begin_load(cache_key)
    if wait_event is not None:
        wait_event.wait(timeout=120)
        cached = get(cache_key, ttl_sec=0)
        if cached is not None:
            return cached
        raise RuntimeError(f"Timed out waiting for cache rebuild ({cache_key})")
    try:
        data = loader()
        set(cache_key, data)
        return data
    finally:
        _finish_load(cache_key)
