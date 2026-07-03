"""File-backed TTL cache shared across Flask workers on the same host."""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

_DEFAULT_DIR = Path(__file__).resolve().parents[1] / "cache" / "erp_routes"
_CACHE_DIR = Path(os.getenv("ERP_ROUTE_CACHE_DIR", str(_DEFAULT_DIR)))
_DEFAULT_TTL = int(os.getenv("ERP_ROUTE_CACHE_TTL_SEC", "300"))


def _cache_path(key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return _CACHE_DIR / f"{digest}.json"


def get(key: str, *, ttl_sec: int | None = None) -> Any | None:
    ttl = _DEFAULT_TTL if ttl_sec is None else ttl_sec
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        cached_at = float(payload.get("cached_at") or 0)
        if ttl > 0 and (time.time() - cached_at) > ttl:
            return None
        return payload.get("data")
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def set(key: str, data: Any) -> None:
    path = _cache_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    body = json.dumps({"cached_at": time.time(), "data": data}, default=str)
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)


def invalidate_prefix(prefix: str = "") -> int:
    if not _CACHE_DIR.is_dir():
        return 0
    removed = 0
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
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def clear_all() -> int:
    return invalidate_prefix("")


def cached_fetch(
    cache_key: str,
    loader,
    *,
    ttl_sec: int | None = None,
    refresh: bool = False,
) -> Any:
    if not refresh:
        hit = get(cache_key, ttl_sec=ttl_sec)
        if hit is not None:
            return hit
    data = loader()
    set(cache_key, data)
    return data
