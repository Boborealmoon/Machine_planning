"""First Article Tracker - flagged process sheets, PIC roster, S/O live fields."""
from __future__ import annotations

import json
import logging
from typing import Any

from db import planner_db_connect_error
from .helpers import one, planner_db, rows
from .staged_erp import serialize_row
from .utils import compact_text

logger = logging.getLogger(__name__)

CHECK_TEXT_MODES = ("tick", "text")
CHECK_TEXT_FIELDS = ("tooling", "fixture", "gauges")
_SEARCH_LIMIT = 25
_CANDIDATE_LIMIT = 1500
_BULK_FLAG_LIMIT = 200
_PS_TYPE_ORDER = ("APS", "NPS", "MPS", "PPS", "CPS", "SR", "OTHER")
_ROW_SELECT = """
    first_article_id, process_sheet_no, pp_voucher_no, pic_ids,
    tooling_mode, tooling_tick, tooling_text,
    fixture_mode, fixture_tick, fixture_text,
    gauges_mode, gauges_tick, gauges_text,
    remarks, created_at, updated_at
"""


def _ensure_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_first_article_pic (
            pic_id     BIGSERIAL    PRIMARY KEY,
            name       TEXT         NOT NULL,
            active     BOOLEAN      NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_pic_name_active_unique
            ON public.planner_first_article_pic (LOWER(TRIM(name)))
            WHERE active = TRUE
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_first_article (
            first_article_id BIGSERIAL    PRIMARY KEY,
            process_sheet_no TEXT         NOT NULL,
            pp_voucher_no    TEXT         NOT NULL DEFAULT '',
            pic_ids          BIGINT[]     NOT NULL DEFAULT '{}',
            tooling_mode     TEXT         NOT NULL DEFAULT 'tick',
            tooling_tick     BOOLEAN      NOT NULL DEFAULT FALSE,
            tooling_text     TEXT         NOT NULL DEFAULT '',
            fixture_mode     TEXT         NOT NULL DEFAULT 'tick',
            fixture_tick     BOOLEAN      NOT NULL DEFAULT FALSE,
            fixture_text     TEXT         NOT NULL DEFAULT '',
            gauges_mode      TEXT         NOT NULL DEFAULT 'tick',
            gauges_tick      BOOLEAN      NOT NULL DEFAULT FALSE,
            gauges_text      TEXT         NOT NULL DEFAULT '',
            remarks          TEXT         NOT NULL DEFAULT '',
            created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            CONSTRAINT planner_first_article_tooling_mode_chk
                CHECK (tooling_mode IN ('tick', 'text')),
            CONSTRAINT planner_first_article_fixture_mode_chk
                CHECK (fixture_mode IN ('tick', 'text')),
            CONSTRAINT planner_first_article_gauges_mode_chk
                CHECK (gauges_mode IN ('tick', 'text'))
        )
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_process_sheet_unique
            ON public.planner_first_article (LOWER(TRIM(process_sheet_no)))
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fa_updated_at
            ON public.planner_first_article (updated_at DESC)
        """
    )


def _ps_base(value: Any) -> str:
    return compact_text(value).split("::")[0]


def _ps_key(value: Any) -> str:
    return _ps_base(value).upper()


def _job_ps_type(job: dict[str, Any] | None) -> str:
    from .so_outstanding_balance_service import ps_type

    if not job:
        return ""
    return ps_type(job.get("process_sheet_no") or job.get("pp_voucher_no"))


def _job_search_blob(job: dict[str, Any]) -> str:
    return " ".join(
        compact_text(job.get(field)).upper()
        for field in (
            "process_sheet_no",
            "pp_voucher_no",
            "part_no",
            "part_description",
            "sales_order_no",
            "customer_name",
            "ps_type",
        )
    )


def _date_text(value: Any) -> str:
    text = compact_text(value)
    return text[:10] if text else ""


def _qty_value(value: Any) -> Any:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return compact_text(value) or None
    if number != number:
        return None
    if number == int(number):
        return int(number)
    return number


def _machine_list(pp: dict[str, Any]) -> list[str]:
    machines: list[str] = []
    seen: set[str] = set()

    def _add(codes: Any) -> None:
        if not isinstance(codes, (list, tuple)):
            code = compact_text(codes)
            if code and code.upper() not in seen:
                seen.add(code.upper())
                machines.append(code)
            return
        for item in codes:
            code = compact_text(item)
            if code and code.upper() not in seen:
                seen.add(code.upper())
                machines.append(code)

    _add(pp.get("queued_machines"))
    by_partial = pp.get("queued_machines_by_partial") or {}
    if isinstance(by_partial, dict):
        for codes in by_partial.values():
            _add(codes)
    for partial in pp.get("partials") or []:
        _add(partial.get("queued_machines"))
    return machines


def _coway_edd(pp: dict[str, Any]) -> str:
    edd = _date_text(pp.get("coway_proposed_edd"))
    if edd:
        return edd
    for partial in pp.get("partials") or []:
        edd = _date_text(partial.get("coway_proposed_edd"))
        if edd:
            return edd
    return ""


def job_from_sales_order_pp(order: dict[str, Any], pp: dict[str, Any]) -> dict[str, Any] | None:
    process_sheet_no = _ps_base(pp.get("process_sheet_no") or pp.get("pp_voucher_no"))
    pp_voucher_no = compact_text(pp.get("pp_voucher_no"))
    if not process_sheet_no and not pp_voucher_no:
        return None
    machines = _machine_list(pp)
    return {
        "process_sheet_no": process_sheet_no or pp_voucher_no,
        "pp_voucher_no": pp_voucher_no,
        "part_no": compact_text(pp.get("inventory_code") or pp.get("part_no")),
        "part_description": compact_text(pp.get("description") or pp.get("part_description")),
        "total_qty": _qty_value(pp.get("pp_qty") if pp.get("pp_qty") is not None else pp.get("total_qty")),
        "po_due_date": _date_text(pp.get("due_date") or pp.get("po_due_date")),
        "queued_machines": machines,
        "machine_cnc": ", ".join(machines),
        "coway_proposed_edd": _coway_edd(pp),
        "sales_order_no": compact_text(order.get("sales_order_no") or pp.get("source_voucher_no")),
        "customer_name": compact_text(order.get("customer_name")),
    }


def flatten_sales_order_jobs(orders: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for order in orders or []:
        for pp in order.get("pp_vouchers") or []:
            job = job_from_sales_order_pp(order, pp)
            if not job:
                continue
            key = _ps_key(job.get("process_sheet_no") or job.get("pp_voucher_no"))
            if not key or key in seen:
                continue
            seen.add(key)
            jobs.append(job)
    return jobs


def index_jobs_by_ps(jobs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for job in jobs:
        for raw in (job.get("process_sheet_no"), job.get("pp_voucher_no")):
            key = _ps_key(raw)
            if key and key not in indexed:
                indexed[key] = job
    return indexed


def search_jobs(
    jobs: list[dict[str, Any]],
    query: str,
    *,
    flagged_keys: set[str] | None = None,
    limit: int = _SEARCH_LIMIT,
) -> list[dict[str, Any]]:
    needle = compact_text(query).upper()
    if not needle:
        return []
    flagged = flagged_keys or set()
    cap = max(1, min(int(limit or _SEARCH_LIMIT), 50))
    hits: list[dict[str, Any]] = []
    for job in jobs:
        if needle not in _job_search_blob(job):
            continue
        hits.append(_decorate_candidate(job, flagged))
        if len(hits) >= cap:
            break
    return hits


def _decorate_candidate(job: dict[str, Any], flagged_keys: set[str]) -> dict[str, Any]:
    out = dict(job)
    key = _ps_key(job.get("process_sheet_no") or job.get("pp_voucher_no"))
    out["already_flagged"] = key in flagged_keys
    out["ps_type"] = compact_text(out.get("ps_type")) or _job_ps_type(out)
    return out


def list_flag_candidates(
    *,
    query: str = "",
    ps_type_filter: str = "",
    limit: int = _CANDIDATE_LIMIT,
) -> dict[str, Any]:
    jobs = _sales_order_jobs(allow_rebuild=True)
    with planner_db() as con:
        _ensure_tables(con)
        flagged = _flagged_keys(con)
    decorated = [_decorate_candidate(job, flagged) for job in jobs]
    type_counts: dict[str, int] = {}
    for job in decorated:
        label = compact_text(job.get("ps_type")) or "OTHER"
        type_counts[label] = type_counts.get(label, 0) + 1

    needle = compact_text(query).upper()
    wanted = compact_text(ps_type_filter).upper()
    cap = max(1, min(int(limit or _CANDIDATE_LIMIT), 2500))
    hits: list[dict[str, Any]] = []
    truncated = False
    for job in decorated:
        kind = compact_text(job.get("ps_type")) or "OTHER"
        if wanted and wanted != kind:
            continue
        if needle and needle not in _job_search_blob(job):
            continue
        hits.append(job)
        if len(hits) >= cap:
            truncated = True
            break

    types = sorted(
        type_counts,
        key=lambda label: (
            _PS_TYPE_ORDER.index(label) if label in _PS_TYPE_ORDER else 99,
            label,
        ),
    )
    return {
        "rows": hits,
        "types": [{"ps_type": label, "count": type_counts[label]} for label in types],
        "total": len(decorated),
        "matched": len(hits),
        "truncated": truncated,
    }


def _parse_pic_ids(raw: Any) -> list[int]:
    if raw is None:
        return []
    if isinstance(raw, str):
        text = compact_text(raw)
        if not text:
            return []
        if text.startswith("["):
            try:
                raw = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError("pic_ids must be a list of ids") from exc
        else:
            raw = [part for part in text.split(",") if compact_text(part)]
    if not isinstance(raw, (list, tuple)):
        raw = [raw]
    out: list[int] = []
    seen: set[int] = set()
    for item in raw:
        try:
            pic_id = int(item)
        except (TypeError, ValueError) as exc:
            raise ValueError("pic_ids must be integers") from exc
        if pic_id <= 0 or pic_id in seen:
            continue
        seen.add(pic_id)
        out.append(pic_id)
    return out


def _parse_mode(value: Any, *, field: str) -> str:
    mode = compact_text(value).lower()
    if mode not in CHECK_TEXT_MODES:
        raise ValueError(f"{field} must be tick or text")
    return mode


def _serialize_pic(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    out = serialize_row(dict(row))
    out["pic_id"] = int(out.get("pic_id") or 0)
    out["name"] = compact_text(out.get("name"))
    out["active"] = bool(out.get("active", True))
    return out


def _pics_for_ids(pics_by_id: dict[int, dict[str, Any]], pic_ids: list[int]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for pic_id in pic_ids:
        pic = pics_by_id.get(pic_id)
        if pic:
            out.append({"pic_id": pic["pic_id"], "name": pic["name"]})
    return out


def _serialize_tracker_row(
    row: dict[str, Any] | None,
    *,
    live: dict[str, Any] | None = None,
    pics_by_id: dict[int, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    if not row:
        return None
    out = serialize_row(dict(row))
    out["first_article_id"] = int(out.get("first_article_id") or 0)
    out["process_sheet_no"] = _ps_base(out.get("process_sheet_no"))
    out["pp_voucher_no"] = compact_text(out.get("pp_voucher_no"))
    pic_ids = _parse_pic_ids(out.get("pic_ids"))
    out["pic_ids"] = pic_ids
    out["pics"] = _pics_for_ids(pics_by_id or {}, pic_ids)
    for prefix in CHECK_TEXT_FIELDS:
        out[f"{prefix}_mode"] = compact_text(out.get(f"{prefix}_mode")).lower() or "tick"
        out[f"{prefix}_tick"] = bool(out.get(f"{prefix}_tick"))
        out[f"{prefix}_text"] = compact_text(out.get(f"{prefix}_text"))
    out["remarks"] = compact_text(out.get("remarks"))

    live = live or {}
    out["part_no"] = compact_text(live.get("part_no"))
    out["part_description"] = compact_text(live.get("part_description"))
    out["total_qty"] = live.get("total_qty")
    out["po_due_date"] = _date_text(live.get("po_due_date"))
    out["queued_machines"] = list(live.get("queued_machines") or [])
    out["machine_cnc"] = compact_text(live.get("machine_cnc"))
    out["coway_proposed_edd"] = _date_text(live.get("coway_proposed_edd"))
    out["sales_order_no"] = compact_text(live.get("sales_order_no"))
    out["customer_name"] = compact_text(live.get("customer_name"))
    out["in_sales_orders"] = bool(live)
    return out


def load_pics(con) -> list[dict[str, Any]]:
    _ensure_tables(con)
    fetched = rows(
        con.execute(
            """
            SELECT pic_id, name, active, created_at
            FROM planner_first_article_pic
            WHERE active = TRUE
            ORDER BY LOWER(TRIM(name)), pic_id
            """
        )
    )
    return [pic for pic in (_serialize_pic(item) for item in fetched) if pic]


def add_pic(con, name: str) -> tuple[dict[str, Any], bool]:
    _ensure_tables(con)
    clean = compact_text(name)
    if not clean:
        raise ValueError("PIC name is required")

    existing = one(
        con.execute(
            """
            SELECT pic_id, name, active, created_at
            FROM planner_first_article_pic
            WHERE active = TRUE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            ORDER BY pic_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if existing:
        serialized = _serialize_pic(dict(existing))
        return serialized or {}, False

    inactive = one(
        con.execute(
            """
            SELECT pic_id, name, active, created_at
            FROM planner_first_article_pic
            WHERE active = FALSE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            ORDER BY pic_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if inactive:
        row = one(
            con.execute(
                """
                UPDATE planner_first_article_pic
                SET active = TRUE, name = %s
                WHERE pic_id = %s
                RETURNING pic_id, name, active, created_at
                """,
                (clean, int(inactive["pic_id"])),
            )
        )
        return _serialize_pic(dict(row) if row else {}) or {}, True

    row = one(
        con.execute(
            """
            INSERT INTO planner_first_article_pic (name)
            VALUES (%s)
            RETURNING pic_id, name, active, created_at
            """,
            (clean,),
        )
    )
    return _serialize_pic(dict(row) if row else {}) or {}, True


def delete_pic(con, pic_id: int) -> dict[str, Any] | None:
    _ensure_tables(con)
    row = one(
        con.execute(
            """
            SELECT pic_id, name
            FROM planner_first_article_pic
            WHERE pic_id = %s AND active = TRUE
            """,
            (int(pic_id),),
        )
    )
    if not row:
        return None
    name = compact_text(row.get("name"))
    ids = [
        int(item["pic_id"])
        for item in rows(
            con.execute(
                """
                SELECT pic_id
                FROM planner_first_article_pic
                WHERE active = TRUE
                  AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
                """,
                (name,),
            )
        )
    ]
    if not ids:
        return None
    con.execute(
        """
        UPDATE planner_first_article
        SET pic_ids = COALESCE(
                ARRAY(
                    SELECT x FROM UNNEST(pic_ids) AS x
                    WHERE x <> ALL(%s)
                ),
                '{}'::bigint[]
            ),
            updated_at = NOW()
        WHERE pic_ids && %s
        """,
        (ids, ids),
    )
    cur = con.execute(
        """
        UPDATE planner_first_article_pic
        SET active = FALSE
        WHERE pic_id = ANY(%s) AND active = TRUE
        """,
        (ids,),
    )
    return {"name": name, "removed_count": int(getattr(cur, "rowcount", 0) or 0)}


def _pics_by_id(con) -> dict[int, dict[str, Any]]:
    return {int(pic["pic_id"]): pic for pic in load_pics(con)}


def _validate_pic_ids(con, pic_ids: list[int]) -> list[int]:
    if not pic_ids:
        return []
    known = {int(pic["pic_id"]) for pic in load_pics(con)}
    unknown = [pic_id for pic_id in pic_ids if pic_id not in known]
    if unknown:
        raise ValueError("Unknown PIC id")
    return pic_ids


def _peek_cached_sales_orders() -> dict[str, Any]:
    """Read S/O cache only. Never trigger a live ERP rebuild."""
    try:
        from .erp_route_cache import get as cache_get
        from .sales_orders_route import _sales_orders_cache_key
    except Exception:
        logger.exception("first article sales-order cache import failed")
        return {}

    for lite in (False, True):
        try:
            payload = cache_get(_sales_orders_cache_key("active", lite=lite), ttl_sec=0)
        except Exception:
            logger.exception("first article sales-order cache read failed")
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def _sales_order_jobs(*, allow_rebuild: bool = False) -> list[dict[str, Any]]:
    payload = _peek_cached_sales_orders()
    if not payload and allow_rebuild:
        try:
            from .sales_orders_route import _fetch_sales_orders

            # Staged/lite rebuild only. Full live S/O build can stall the tracker
            # for minutes while COMAIN is busy or another worker holds the cache lock.
            payload = _fetch_sales_orders(refresh=False, active_only=True, lite=True) or {}
        except Exception:
            logger.exception("first article sales-order lookup failed")
            payload = {}
    if not payload:
        return []
    return flatten_sales_order_jobs(list(payload.get("active") or []))


def _live_job_map(*, allow_rebuild: bool = False) -> dict[str, dict[str, Any]]:
    return index_jobs_by_ps(_sales_order_jobs(allow_rebuild=allow_rebuild))


def _flagged_keys(con) -> set[str]:
    fetched = rows(
        con.execute(
            """
            SELECT process_sheet_no, pp_voucher_no
            FROM planner_first_article
            """
        )
    )
    keys: set[str] = set()
    for row in fetched:
        for raw in (row.get("process_sheet_no"), row.get("pp_voucher_no")):
            key = _ps_key(raw)
            if key:
                keys.add(key)
    return keys


def list_tracker_rows(*, live_by_ps: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    if live_by_ps is not None:
        live_map = live_by_ps
    else:
        try:
            live_map = _live_job_map()
        except Exception:
            logger.exception("first article live map failed")
            live_map = {}
    with planner_db() as con:
        _ensure_tables(con)
        pics = _pics_by_id(con)
        fetched = rows(
            con.execute(
                f"""
                SELECT {_ROW_SELECT}
                FROM planner_first_article
                ORDER BY updated_at DESC, first_article_id DESC
                """
            )
        )
    out: list[dict[str, Any]] = []
    for row in fetched:
        key = _ps_key(row.get("process_sheet_no") or row.get("pp_voucher_no"))
        serialized = _serialize_tracker_row(row, live=live_map.get(key), pics_by_id=pics)
        if serialized:
            out.append(serialized)
    return out


def lookup_sales_order_job(process_sheet_no: str, pp_voucher_no: str = "") -> dict[str, Any] | None:
    live_map = _live_job_map(allow_rebuild=True)
    for raw in (process_sheet_no, pp_voucher_no):
        job = live_map.get(_ps_key(raw))
        if job:
            return job
    return None


def search_flag_candidates(query: str, *, limit: int = _SEARCH_LIMIT) -> list[dict[str, Any]]:
    if not compact_text(query):
        return []
    jobs = _sales_order_jobs(allow_rebuild=True)
    with planner_db() as con:
        _ensure_tables(con)
        flagged = _flagged_keys(con)
    return search_jobs(jobs, query, flagged_keys=flagged, limit=limit)


def _upsert_flagged_row(con, process_sheet_no: str, pp_voucher_no: str) -> tuple[Any, bool]:
    existing = one(
        con.execute(
            f"""
            SELECT {_ROW_SELECT}
            FROM planner_first_article
            WHERE LOWER(TRIM(process_sheet_no)) = LOWER(TRIM(%s))
            LIMIT 1
            """,
            (process_sheet_no,),
        )
    )
    if existing:
        row = existing
        if pp_voucher_no and compact_text(row.get("pp_voucher_no")) != pp_voucher_no:
            row = one(
                con.execute(
                    f"""
                    UPDATE planner_first_article
                    SET pp_voucher_no = %s, updated_at = NOW()
                    WHERE first_article_id = %s
                    RETURNING {_ROW_SELECT}
                    """,
                    (pp_voucher_no, int(row["first_article_id"])),
                )
            ) or existing
        return row, False
    row = one(
        con.execute(
            f"""
            INSERT INTO planner_first_article (process_sheet_no, pp_voucher_no, updated_at)
            VALUES (%s, %s, NOW())
            RETURNING {_ROW_SELECT}
            """,
            (process_sheet_no, pp_voucher_no),
        )
    )
    return row, True


def _normalize_flag_item(raw: Any) -> tuple[str, str] | None:
    if isinstance(raw, str):
        process_sheet_no = _ps_base(raw)
        pp_voucher_no = ""
    elif isinstance(raw, dict):
        process_sheet_no = _ps_base(raw.get("process_sheet_no") or raw.get("pp_voucher_no"))
        pp_voucher_no = compact_text(raw.get("pp_voucher_no"))
    else:
        return None
    if not process_sheet_no:
        return None
    return process_sheet_no, pp_voucher_no


def flag_process_sheet(data: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    parsed = _normalize_flag_item(data if isinstance(data, dict) else {})
    if not parsed:
        raise ValueError("process_sheet_no is required")
    process_sheet_no, pp_voucher_no = parsed
    live = lookup_sales_order_job(process_sheet_no, pp_voucher_no)
    if live:
        process_sheet_no = compact_text(live.get("process_sheet_no")) or process_sheet_no
        pp_voucher_no = compact_text(live.get("pp_voucher_no")) or pp_voucher_no

    with planner_db() as con:
        _ensure_tables(con)
        row, created = _upsert_flagged_row(con, process_sheet_no, pp_voucher_no)
        pics = _pics_by_id(con)
    serialized = _serialize_tracker_row(row, live=live or {}, pics_by_id=pics)
    if not serialized:
        raise RuntimeError("Failed to flag process sheet")
    return serialized, created


def flag_process_sheets(items: list[Any] | None) -> dict[str, Any]:
    parsed: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in items or []:
        item = _normalize_flag_item(raw)
        if not item:
            continue
        key = _ps_key(item[0])
        if key in seen:
            continue
        seen.add(key)
        parsed.append(item)
    if not parsed:
        raise ValueError("Select at least one process sheet")
    if len(parsed) > _BULK_FLAG_LIMIT:
        raise ValueError(f"Select at most {_BULK_FLAG_LIMIT} process sheets")

    live_map = _live_job_map(allow_rebuild=True)
    created_rows: list[dict[str, Any]] = []
    already: list[dict[str, Any]] = []
    with planner_db() as con:
        _ensure_tables(con)
        pics = _pics_by_id(con)
        for process_sheet_no, pp_voucher_no in parsed:
            live = (
                live_map.get(_ps_key(process_sheet_no))
                or live_map.get(_ps_key(pp_voucher_no))
                or {}
            )
            if live:
                process_sheet_no = compact_text(live.get("process_sheet_no")) or process_sheet_no
                pp_voucher_no = compact_text(live.get("pp_voucher_no")) or pp_voucher_no
            row, created = _upsert_flagged_row(con, process_sheet_no, pp_voucher_no)
            serialized = _serialize_tracker_row(row, live=live or {}, pics_by_id=pics)
            if not serialized:
                continue
            if created:
                created_rows.append(serialized)
            else:
                already.append(serialized)
    return {
        "created": created_rows,
        "already_flagged": already,
        "created_count": len(created_rows),
        "already_flagged_count": len(already),
        "count": len(created_rows) + len(already),
    }


def update_tracker_row(first_article_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
    with planner_db() as con:
        _ensure_tables(con)
        existing = one(
            con.execute(
                f"""
                SELECT {_ROW_SELECT}
                FROM planner_first_article
                WHERE first_article_id = %s
                """,
                (int(first_article_id),),
            )
        )
        if not existing:
            return None
        current = dict(existing)
        if "pic_ids" in data:
            current["pic_ids"] = _validate_pic_ids(con, _parse_pic_ids(data.get("pic_ids")))
        if "remarks" in data:
            current["remarks"] = compact_text(data.get("remarks"))
        for prefix in CHECK_TEXT_FIELDS:
            mode_key = f"{prefix}_mode"
            tick_key = f"{prefix}_tick"
            text_key = f"{prefix}_text"
            if mode_key in data:
                current[mode_key] = _parse_mode(data.get(mode_key), field=mode_key)
            if tick_key in data:
                current[tick_key] = bool(data.get(tick_key))
            if text_key in data:
                current[text_key] = compact_text(data.get(text_key))
        row = one(
            con.execute(
                f"""
                UPDATE planner_first_article
                SET pic_ids = %s,
                    tooling_mode = %s,
                    tooling_tick = %s,
                    tooling_text = %s,
                    fixture_mode = %s,
                    fixture_tick = %s,
                    fixture_text = %s,
                    gauges_mode = %s,
                    gauges_tick = %s,
                    gauges_text = %s,
                    remarks = %s,
                    updated_at = NOW()
                WHERE first_article_id = %s
                RETURNING {_ROW_SELECT}
                """,
                (
                    current.get("pic_ids") or [],
                    compact_text(current.get("tooling_mode")) or "tick",
                    bool(current.get("tooling_tick")),
                    compact_text(current.get("tooling_text")),
                    compact_text(current.get("fixture_mode")) or "tick",
                    bool(current.get("fixture_tick")),
                    compact_text(current.get("fixture_text")),
                    compact_text(current.get("gauges_mode")) or "tick",
                    bool(current.get("gauges_tick")),
                    compact_text(current.get("gauges_text")),
                    compact_text(current.get("remarks")),
                    int(first_article_id),
                ),
            )
        )
        pics = _pics_by_id(con)
    live = lookup_sales_order_job(
        compact_text((row or {}).get("process_sheet_no")),
        compact_text((row or {}).get("pp_voucher_no")),
    )
    return _serialize_tracker_row(row, live=live or {}, pics_by_id=pics)


def unflag_process_sheet(first_article_id: int) -> bool:
    with planner_db() as con:
        _ensure_tables(con)
        row = one(
            con.execute(
                """
                DELETE FROM planner_first_article
                WHERE first_article_id = %s
                RETURNING first_article_id
                """,
                (int(first_article_id),),
            )
        )
    return bool(row)


def json_error(exc: Exception, *, fallback_status: int = 500):
    friendly = planner_db_connect_error(exc)
    if friendly:
        return {"error": friendly}, 503
    return {"error": str(exc)}, fallback_status
