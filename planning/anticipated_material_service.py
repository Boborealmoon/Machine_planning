"""Anticipated material arrivals from S/O Management Material in / Sub-Con dates."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from .helpers import planner_try_savepoint, rows
from .so_outstanding_balance_service import _parse_date, ps_type
from .utils import PLANNER_TZ, bom_code_match_key, compact_text, shipped_quantity_completed

logger = logging.getLogger(__name__)

_WEEKDAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)
_MONTH_ABBR = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)


def planner_today() -> date:
    return datetime.now(PLANNER_TZ).date()


def material_subcon_is_arrived(raw: Any) -> bool:
    """True for Arrived, including Arrived plus a kept in-date (``ARRIVED|YYYY-MM-DD``)."""
    text = compact_text(raw).upper()
    return text == "ARRIVED" or text.startswith("ARRIVED|")


def material_subcon_date_text(raw: Any) -> str:
    """Date portion of Material in / Sub-Con. Empty for plain Arrived and blank."""
    text = compact_text(raw)
    if not text:
        return ""
    upper = text.upper()
    if upper == "ARRIVED":
        return ""
    if upper.startswith("ARRIVED|"):
        return compact_text(text.split("|", 1)[1])
    return text


def parse_material_subcon_date(raw: Any) -> date | None:
    """ISO or DMY date from Material in / Sub-Con. Ignores plain Arrived and free text."""
    text = material_subcon_date_text(raw)
    if not text:
        return None
    return _parse_date(text)


def week_range_label(monday: date, sunday: date) -> str:
    start_month = _MONTH_ABBR[monday.month - 1]
    end_month = _MONTH_ABBR[sunday.month - 1]
    if monday.year == sunday.year and monday.month == sunday.month:
        return f"{monday.day}-{sunday.day} {start_month} {monday.year}"
    if monday.year == sunday.year:
        return f"{monday.day} {start_month}-{sunday.day} {end_month} {monday.year}"
    return f"{monday.day} {start_month} {monday.year}-{sunday.day} {end_month} {sunday.year}"


def iso_week_fields(arrival: date, today: date | None = None) -> dict[str, Any]:
    today = today or planner_today()
    iso = arrival.isocalendar()
    monday = date.fromisocalendar(iso.year, iso.week, 1)
    sunday = monday + timedelta(days=6)
    today_iso = today.isocalendar()
    return {
        "iso_year": iso.year,
        "iso_week": iso.week,
        "week_key": f"{iso.year}-W{iso.week:02d}",
        "week_label": f"Week {iso.week}",
        "week_day_label": f"Week {iso.week} - {_WEEKDAY_NAMES[arrival.weekday()]}",
        "week_range_start": monday.isoformat(),
        "week_range_end": sunday.isoformat(),
        "week_range_label": week_range_label(monday, sunday),
        "overdue": arrival < today,
        "this_week": (iso.year, iso.week) == (today_iso.year, today_iso.week),
    }


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _optional_rows(con, name: str, sql: str, params: tuple) -> list[dict[str, Any]]:
    return planner_try_savepoint(con, name, lambda: rows(con.execute(sql, params)), default=[]) or []


def _load_pp_meta(con, pp_voucher_nos: list[str]) -> dict[str, dict[str, Any]]:
    ids = [compact_text(v) for v in pp_voucher_nos if compact_text(v)]
    if not ids:
        return {}

    psi_rows = _optional_rows(
        con,
        "am_process_sheet_info",
        """
        SELECT DISTINCT ON (pp_voucher_no)
            pp_voucher_no,
            process_sheet_no,
            inventory_code,
            total_qty
        FROM mfg_process_sheet_info
        WHERE pp_voucher_no = ANY(%s)
        ORDER BY pp_voucher_no, process_sheet_no
        """,
        (ids,),
    )
    psi_by_pp = {compact_text(row.get("pp_voucher_no")): row for row in psi_rows if compact_text(row.get("pp_voucher_no"))}

    hdr_rows = _optional_rows(
        con,
        "am_pp_voucher_hdr",
        """
        SELECT
            pp_voucher_no,
            inventory_code,
            bom_desc,
            pp_qty,
            source_voucher_no,
            source_rsd,
            customer_code
        FROM pp_voucher_hdr
        WHERE pp_voucher_no = ANY(%s)
        """,
        (ids,),
    )
    hdr_by_pp = {compact_text(row.get("pp_voucher_no")): row for row in hdr_rows if compact_text(row.get("pp_voucher_no"))}

    ps_ids = [
        compact_text(row.get("process_sheet_no")) or pp_no
        for pp_no, row in psi_by_pp.items()
    ]
    ps_ids.extend(ids)
    ps_ids = [v for v in dict.fromkeys(ps_ids) if v]

    cache_rows = _optional_rows(
        con,
        "am_pp_vouchers_cache",
        """
        SELECT DISTINCT ON (ps_id)
            ps_id,
            part_no,
            description,
            bom_code,
            due_date,
            source_voucher_no,
            customer_po_no,
            COALESCE(NULLIF(partial_qty, 0), total_qty) AS qty,
            qty_shipped,
            so_det_qty,
            current_stage_desc
        FROM pp_vouchers_cache
        WHERE ps_id = ANY(%s)
        ORDER BY ps_id, pp_partial_no NULLS LAST
        """,
        (ps_ids,),
    )
    cache_by_ps = {compact_text(row.get("ps_id")): row for row in cache_rows if compact_text(row.get("ps_id"))}

    so_nos = []
    for row in list(hdr_by_pp.values()) + list(cache_by_ps.values()):
        so_no = compact_text(row.get("source_voucher_no"))
        if so_no:
            so_nos.append(so_no)
    so_nos = list(dict.fromkeys(so_nos))
    so_rows = _optional_rows(
        con,
        "am_so_order_header",
        """
        SELECT sales_order_no, customer_name, customer_short_name, customer_po_no
        FROM so_order_header
        WHERE sales_order_no = ANY(%s)
        """,
        (so_nos,),
    ) if so_nos else []
    so_by_no = {compact_text(row.get("sales_order_no")): row for row in so_rows if compact_text(row.get("sales_order_no"))}

    inv_codes = []
    for row in list(psi_by_pp.values()) + list(hdr_by_pp.values()) + list(cache_by_ps.values()):
        for key in ("inventory_code", "part_no"):
            code = compact_text(row.get(key))
            if code:
                inv_codes.append(code)
    inv_codes = list(dict.fromkeys(inv_codes))
    desc_rows = _optional_rows(
        con,
        "am_part_desc",
        """
        SELECT inventory_code, main_desc
        FROM part_desc
        WHERE inventory_code = ANY(%s)
        """,
        (inv_codes,),
    ) if inv_codes else []
    desc_by_inv = {
        compact_text(row.get("inventory_code")): compact_text(row.get("main_desc"))
        for row in desc_rows
        if compact_text(row.get("inventory_code")) and compact_text(row.get("main_desc"))
    }

    out: dict[str, dict[str, Any]] = {}
    for pp_no in ids:
        psi = psi_by_pp.get(pp_no) or {}
        hdr = hdr_by_pp.get(pp_no) or {}
        ps_id = compact_text(psi.get("process_sheet_no")) or pp_no
        cache = cache_by_ps.get(ps_id) or cache_by_ps.get(pp_no) or {}
        so_no = compact_text(cache.get("source_voucher_no")) or compact_text(hdr.get("source_voucher_no"))
        so = so_by_no.get(so_no) or {}
        part_no = (
            compact_text(cache.get("part_no"))
            or compact_text(psi.get("inventory_code"))
            or compact_text(hdr.get("inventory_code"))
        )
        description = (
            compact_text(cache.get("description"))
            or compact_text(hdr.get("bom_desc"))
            or desc_by_inv.get(part_no)
            or ""
        )
        qty = cache.get("qty")
        if qty is None:
            qty = psi.get("total_qty")
        if qty is None:
            qty = hdr.get("pp_qty")
        due = cache.get("due_date") or hdr.get("source_rsd")
        out[pp_no] = {
            "process_sheet_no": ps_id,
            "part_no": part_no,
            "description": description,
            "bom_code": compact_text(cache.get("bom_code")),
            "qty": qty,
            "due_date": due,
            "sales_order_no": so_no,
            "customer_name": compact_text(so.get("customer_short_name")) or compact_text(so.get("customer_name")),
            "customer_po_no": compact_text(cache.get("customer_po_no")) or compact_text(so.get("customer_po_no")),
            "qty_shipped": cache.get("qty_shipped"),
            "so_det_qty": cache.get("so_det_qty"),
            "current_stage_desc": compact_text(cache.get("current_stage_desc")),
        }
    return out


def build_item(
    *,
    source: str,
    arrival: date,
    today: date,
    row_id: str,
    process_sheet_no: str = "",
    sales_order_no: str = "",
    part_no: str = "",
    description: str = "",
    bom_code: str = "",
    qty: Any = None,
    due_date: Any = None,
    customer_name: str = "",
    customer_po_no: str = "",
    notes: str = "",
    material_delay: bool = False,
    current_stage_desc: str = "",
) -> dict[str, Any]:
    fields = iso_week_fields(arrival, today)
    ps_id = compact_text(process_sheet_no)
    return {
        "id": compact_text(row_id),
        "source": source,
        "ps_id": ps_id,
        "process_sheet_no": ps_id,
        "ps_type": ps_type(ps_id) if ps_id else "",
        "sales_order_no": compact_text(sales_order_no),
        "part_no": compact_text(part_no),
        "description": compact_text(description),
        "bom_code": compact_text(bom_code),
        "material": "",
        "material_description": compact_text(description),
        "material_codes": [],
        "qty": _serialize_value(qty),
        "due_date": (str(_serialize_value(due_date))[:10] if due_date else None),
        "customer_name": compact_text(customer_name),
        "customer_po_no": compact_text(customer_po_no),
        "notes": compact_text(notes),
        "material_delay": bool(material_delay),
        "current_stage_desc": compact_text(current_stage_desc),
        "arrival_date": arrival.isoformat(),
        **fields,
    }


def _material_entry(code: str, description: str, bom_code: str = "") -> dict[str, str]:
    return {
        "material_inventory_code": compact_text(code),
        "description": compact_text(description),
        "bom_code": compact_text(bom_code),
    }


def _unique_material_entries(entries: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen_codes: set[str] = set()
    for entry in entries or []:
        code = compact_text(entry.get("material_inventory_code"))
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        out.append(
            _material_entry(code, entry.get("description") or "", entry.get("bom_code") or "")
        )
    return out


def resolve_anticipated_material_entries(
    item: dict[str, Any],
    *,
    code_map: dict[tuple[str, str], list[dict[str, Any]]] | None = None,
    by_part: dict[str, list[dict[str, Any]]] | None = None,
    by_ps: dict[str, list[dict[str, Any]]] | None = None,
) -> list[dict[str, str]]:
    """Pick leaf material rows for one anticipated-material job."""
    ps_id = compact_text(item.get("process_sheet_no") or item.get("ps_id"))
    part = compact_text(item.get("part_no"))
    bom = compact_text(item.get("bom_code"))
    ps_entries = _unique_material_entries((by_ps or {}).get(ps_id) or [])
    if ps_entries:
        return ps_entries
    exact = _unique_material_entries((code_map or {}).get((part, bom)) or [])
    if exact:
        return exact
    part_entries = list((by_part or {}).get(part) or [])
    if bom:
        wanted = bom_code_match_key(bom)
        matched = [
            entry for entry in part_entries
            if bom_code_match_key(entry.get("bom_code")) == wanted
        ]
        matched_unique = _unique_material_entries(matched)
        if matched_unique:
            return matched_unique
    return _unique_material_entries(part_entries)


def _usable_incoming_material_note(raw: Any) -> str:
    """mtl_part_order is often the incoming stock label; skip status blobs."""
    text = compact_text(raw)
    if not text or "\n" in text or "\r" in text:
        return ""
    lowered = text.lower()
    if "assembly part" in lowered or "tooling status" in lowered or "programme status" in lowered:
        return ""
    if len(text) > 80:
        return ""
    return text


def apply_anticipated_material_fields(
    items: list[dict[str, Any]],
    code_map: dict[tuple[str, str], list[dict[str, Any]]] | None = None,
    *,
    by_part: dict[str, list[dict[str, Any]]] | None = None,
    by_ps: dict[str, list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Fill material code + simple description from BOM leaf materials."""
    for item in items:
        entries = resolve_anticipated_material_entries(
            item, code_map=code_map, by_part=by_part, by_ps=by_ps
        )
        codes = [compact_text(entry.get("material_inventory_code")) for entry in entries]
        descs: list[str] = []
        seen_descs: set[str] = set()
        for entry in entries:
            desc = compact_text(entry.get("description"))
            if desc and desc not in seen_descs:
                seen_descs.add(desc)
                descs.append(desc)
        notes = _usable_incoming_material_note(item.get("notes"))
        if notes:
            item["material"] = notes
            item["material_description"] = " · ".join(descs) or compact_text(item.get("description"))
        elif codes:
            item["material"] = ", ".join(codes)
            item["material_description"] = " · ".join(descs) or compact_text(item.get("description"))
        elif compact_text(item.get("source")) == "request" and compact_text(item.get("part_no")):
            item["material"] = compact_text(item.get("part_no"))
            item["material_description"] = compact_text(item.get("description"))
        else:
            item["material"] = compact_text(item.get("material"))
            item["material_description"] = compact_text(item.get("material_description") or item.get("description"))
        item["material_codes"] = codes
    return items


def _load_selected_bom_by_ps(con, ps_ids: list[str]) -> dict[str, str]:
    ids = [compact_text(v) for v in ps_ids if compact_text(v)]
    if not ids:
        return {}
    rows_out = _optional_rows(
        con,
        "am_selected_bom",
        """
        SELECT DISTINCT ON (ps.source_ps_id)
            ps.source_ps_id,
            COALESCE(sf.bom_code, '') AS selected_flow_code
        FROM planner_process_sheet ps
        LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
        WHERE ps.source_ps_id = ANY(%s)
        ORDER BY ps.source_ps_id, ps.pp_partial_no
        """,
        (ids,),
    )
    return {
        compact_text(row.get("source_ps_id")): compact_text(row.get("selected_flow_code"))
        for row in rows_out
        if compact_text(row.get("source_ps_id")) and compact_text(row.get("selected_flow_code"))
    }


def _load_materials_by_part(con, part_nos: list[str]) -> dict[str, list[dict[str, Any]]]:
    codes = [compact_text(v) for v in part_nos if compact_text(v)]
    codes = list(dict.fromkeys(codes))
    if not codes:
        return {}
    rows_out = _optional_rows(
        con,
        "am_material_per_bom",
        """
        SELECT source_inventory_code, bom_code, material_inventory_code, description
        FROM material_per_bom
        WHERE source_inventory_code = ANY(%s)
        ORDER BY source_inventory_code, bom_code, material_inventory_code
        """,
        (codes,),
    )
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rows_out:
        part = compact_text(row.get("source_inventory_code"))
        code = compact_text(row.get("material_inventory_code"))
        if not part or not code:
            continue
        out.setdefault(part, []).append(
            _material_entry(code, row.get("description") or "", row.get("bom_code") or "")
        )
    return out


def _load_materials_by_ps(con, ps_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    ids = [compact_text(v) for v in ps_ids if compact_text(v)]
    ids = list(dict.fromkeys(ids))
    if not ids:
        return {}
    rows_out = _optional_rows(
        con,
        "am_material_requirement",
        """
        SELECT ps.source_ps_id,
               mr.material_inventory_code,
               mr.material_description,
               mr.bom_code
        FROM planner_material_requirement mr
        JOIN planner_process_sheet ps ON ps.planner_ps_id = mr.planner_ps_id
        WHERE ps.source_ps_id = ANY(%s)
          AND COALESCE(mr.material_inventory_code, '') <> ''
        ORDER BY ps.source_ps_id, mr.requirement_id
        """,
        (ids,),
    )
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rows_out:
        ps_id = compact_text(row.get("source_ps_id"))
        code = compact_text(row.get("material_inventory_code"))
        if not ps_id or not code:
            continue
        out.setdefault(ps_id, []).append(
            _material_entry(code, row.get("material_description") or "", row.get("bom_code") or "")
        )
    return out


def _attach_bom_materials(con, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not items:
        return items
    ps_ids = [compact_text(item.get("process_sheet_no") or item.get("ps_id")) for item in items]
    selected_bom = _load_selected_bom_by_ps(con, ps_ids)
    for item in items:
        if compact_text(item.get("bom_code")):
            continue
        ps_id = compact_text(item.get("process_sheet_no") or item.get("ps_id"))
        if selected_bom.get(ps_id):
            item["bom_code"] = selected_bom[ps_id]
    try:
        from .materials import material_inventory_codes_map
        keys = [(item.get("part_no"), item.get("bom_code")) for item in items]
        code_map = material_inventory_codes_map(con, keys)
    except Exception:
        logger.exception("anticipated material BOM lookup failed")
        code_map = {}
    part_nos = [compact_text(item.get("part_no")) for item in items]
    by_part = _load_materials_by_part(con, part_nos)
    by_ps = _load_materials_by_ps(con, ps_ids)
    return apply_anticipated_material_fields(items, code_map, by_part=by_part, by_ps=by_ps)


def _item_sort_key(item: dict[str, Any]) -> tuple:
    return (
        compact_text(item.get("week_key")),
        compact_text(item.get("arrival_date")),
        compact_text(item.get("sales_order_no")),
        compact_text(item.get("process_sheet_no")),
        compact_text(item.get("part_no")),
        compact_text(item.get("id")),
    )


def fetch_anticipated_material(con, *, today: date | None = None) -> list[dict[str, Any]]:
    today = today or planner_today()
    items: list[dict[str, Any]] = []

    try:
        from .sales_orders_route import _ensure_notes_table

        _ensure_notes_table(con)
        note_rows = rows(
            con.execute(
                """
                SELECT pp_voucher_no, material_subcon, mtl_part_order, material_delay
                FROM planner_so_pp_notes
                WHERE BTRIM(COALESCE(material_subcon, '')) <> ''
                  AND UPPER(BTRIM(material_subcon)) <> 'ARRIVED'
                """
            )
        )
    except Exception:
        logger.exception("anticipated material notes load failed")
        note_rows = []

    dated_notes: list[tuple[dict[str, Any], date]] = []
    for row in note_rows:
        arrival = parse_material_subcon_date(row.get("material_subcon"))
        if arrival is None:
            continue
        dated_notes.append((row, arrival))

    meta = _load_pp_meta(con, [compact_text(row.get("pp_voucher_no")) for row, _arrival in dated_notes])
    for row, arrival in dated_notes:
        pp_no = compact_text(row.get("pp_voucher_no"))
        info = meta.get(pp_no) or {}
        if shipped_quantity_completed(info.get("so_det_qty"), info.get("qty_shipped")):
            continue
        items.append(
            build_item(
                source="so",
                arrival=arrival,
                today=today,
                row_id=f"so:{pp_no}",
                process_sheet_no=info.get("process_sheet_no") or pp_no,
                sales_order_no=info.get("sales_order_no") or "",
                part_no=info.get("part_no") or "",
                description=info.get("description") or "",
                bom_code=info.get("bom_code") or "",
                qty=info.get("qty"),
                due_date=info.get("due_date"),
                customer_name=info.get("customer_name") or "",
                customer_po_no=info.get("customer_po_no") or "",
                notes=row.get("mtl_part_order") or "",
                material_delay=bool(row.get("material_delay")),
                current_stage_desc=info.get("current_stage_desc") or "",
            )
        )

    try:
        from .material_tracking_requests_route import _ensure_table

        _ensure_table(con)
        request_rows = rows(
            con.execute(
                """
                SELECT request_id, part_no, inventory_code, description, qty,
                       material_subcon, remarks, material_delay
                FROM planner_material_requests
                WHERE BTRIM(COALESCE(material_subcon, '')) <> ''
                  AND UPPER(BTRIM(material_subcon)) <> 'ARRIVED'
                """
            )
        )
    except Exception:
        logger.exception("anticipated material request load failed")
        request_rows = []

    for row in request_rows:
        arrival = parse_material_subcon_date(row.get("material_subcon"))
        if arrival is None:
            continue
        request_id = int(row.get("request_id") or 0)
        part_no = compact_text(row.get("part_no")) or compact_text(row.get("inventory_code"))
        items.append(
            build_item(
                source="request",
                arrival=arrival,
                today=today,
                row_id=f"req:{request_id}",
                part_no=part_no,
                description=row.get("description") or "",
                qty=row.get("qty"),
                notes=row.get("remarks") or "",
                material_delay=bool(row.get("material_delay")),
            )
        )

    items.sort(key=_item_sort_key)
    return _attach_bom_materials(con, items)


def anticipated_material_payload(items: list[dict[str, Any]], *, fetched_at: datetime | None = None) -> dict[str, Any]:
    overdue_count = sum(1 for item in items if item.get("overdue"))
    this_week_count = sum(1 for item in items if item.get("this_week"))
    at = fetched_at or datetime.now(PLANNER_TZ).replace(tzinfo=None)
    return {
        "ok": True,
        "items": items,
        "count": len(items),
        "overdue_count": overdue_count,
        "this_week_count": this_week_count,
        "cached_at": at.strftime("%Y-%m-%d %H:%M:%S"),
    }
