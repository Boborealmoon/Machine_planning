"""Roll up Assembly Parts Tracker child arrivals onto APS/NPS/[SR] parents.

Parent process sheets such as NPS26-0321 keep their own Material in / Sub-con
column. Child COMP sheets (NPS26-0321-1, ...) store arrival dates in the same
notes table the Assembly Parts Tracker edits. For assembly parents the effective
material-in date is the latest outstanding child arrival, not the parent column
alone.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any

from .anticipated_material_service import parse_material_subcon_date
from .assembly_classify import is_component_child_ps, parent_ps_id_from_child
from .helpers import planner_db, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

_ARRIVED = "ARRIVED"


def _iso(value: date | None) -> str | None:
    return value.isoformat() if value else None


def child_is_arrived(child: dict[str, Any] | None) -> bool:
    raw = compact_text((child or {}).get("material_subcon"))
    if raw.upper() == _ARRIVED:
        return True
    return bool((child or {}).get("material_in"))


def child_expected_date(child: dict[str, Any] | None) -> date | None:
    if child_is_arrived(child):
        return None
    row = child or {}
    return parse_material_subcon_date(row.get("material_subcon")) or parse_material_subcon_date(
        row.get("material_in_date")
    )


def rollup_assembly_material(
    *,
    parent_subcon: Any = "",
    parent_material_in: bool = False,
    parent_material_in_date: Any = None,
    children: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Effective material-in for an assembly parent given APT children.

    Returns None when there are no child rows, so callers keep the parent column.
    """
    kids = [child for child in (children or []) if isinstance(child, dict)]
    if not kids:
        return None

    parent_raw = compact_text(parent_subcon)
    parent_arrived = parent_raw.upper() == _ARRIVED or bool(parent_material_in)
    parent_date = None if parent_arrived else (
        parse_material_subcon_date(parent_raw)
        or parse_material_subcon_date(parent_material_in_date)
    )

    outstanding_dates: list[date] = []
    pending_without_date = 0
    for child in kids:
        if child_is_arrived(child):
            continue
        expected = child_expected_date(child)
        if expected:
            outstanding_dates.append(expected)
        else:
            pending_without_date += 1

    if outstanding_dates or pending_without_date:
        dates = list(outstanding_dates)
        if parent_date:
            dates.append(parent_date)
        latest = max(dates) if dates else None
        return {
            "material_status": "Expected" if latest else "Pending",
            "material_in_date": _iso(latest),
            "material_subcon": _iso(latest) or "",
            "source": "assembly_parts",
            "pending_child_count": len(outstanding_dates) + pending_without_date,
        }

    if parent_arrived:
        in_date = _iso(parse_material_subcon_date(parent_material_in_date))
        return {
            "material_status": "Arrived",
            "material_in_date": in_date,
            "material_subcon": _ARRIVED,
            "source": "assembly_parts",
            "pending_child_count": 0,
        }
    if parent_date:
        return {
            "material_status": "Expected",
            "material_in_date": parent_date.isoformat(),
            "material_subcon": parent_date.isoformat(),
            "source": "parent",
            "pending_child_count": 0,
        }
    return {
        "material_status": "Arrived",
        "material_in_date": _iso(parse_material_subcon_date(parent_material_in_date)),
        "material_subcon": _ARRIVED,
        "source": "assembly_parts",
        "pending_child_count": 0,
    }


def _parent_ps_key(raw: Any) -> str:
    base = compact_text(raw).split("::")[0].upper()
    if not base or is_component_child_ps(base):
        return ""
    return base


def _child_ps_key(raw: Any) -> str:
    base = compact_text(raw).split("::")[0].upper()
    if not is_component_child_ps(base):
        return ""
    return base


def _serialize_note_date(value: Any) -> str:
    parsed = parse_material_subcon_date(value)
    if parsed:
        return parsed.isoformat()
    text = compact_text(value)
    return text[:10] if text else ""


def load_child_arrivals_by_parent(parent_ps_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Load APT child arrival rows keyed by parent process sheet (NPS26-0321)."""
    parents = sorted({_parent_ps_key(raw) for raw in parent_ps_ids if _parent_ps_key(raw)})
    if not parents:
        return {}
    try:
        from .process_sheets import _ensure_planner_overlay_columns
        from .sales_orders_route import _ensure_notes_table

        with planner_db() as con:
            _ensure_notes_table(con)
            _ensure_planner_overlay_columns(con)
            notes = rows(
                con.execute(
                    """
                    SELECT pp_voucher_no, material_subcon, material_need_date
                    FROM planner_so_pp_notes
                    WHERE regexp_replace(upper(btrim(pp_voucher_no)), '-[0-9]+$', '') = ANY(%s)
                      AND upper(btrim(pp_voucher_no)) ~ '-[0-9]+$'
                    """,
                    (parents,),
                )
            )
            flags = rows(
                con.execute(
                    """
                    SELECT planner_ps_id, source_ps_id,
                           COALESCE(material_in, FALSE) AS material_in,
                           material_in_date
                    FROM planner_process_sheet
                    WHERE regexp_replace(
                              upper(split_part(planner_ps_id, '::', 1)),
                              '-[0-9]+$',
                              ''
                          ) = ANY(%s)
                    """,
                    (parents,),
                )
            )
    except Exception as exc:
        logger.warning("assembly child arrival load skipped: %s", exc)
        return {}

    by_parent: dict[str, dict[str, dict[str, Any]]] = {}

    def _bucket(child_id: str) -> dict[str, Any] | None:
        parent = parent_ps_id_from_child(child_id).upper()
        if parent not in set(parents):
            return None
        family = by_parent.setdefault(parent, {})
        return family.setdefault(
            child_id,
            {
                "process_sheet_no": child_id,
                "material_subcon": "",
                "material_need_date": "",
                "material_in": False,
                "material_in_date": None,
            },
        )

    for row in notes:
        child_id = _child_ps_key(row.get("pp_voucher_no"))
        if not child_id:
            continue
        entry = _bucket(child_id)
        if not entry:
            continue
        entry["material_subcon"] = compact_text(row.get("material_subcon"))
        entry["material_need_date"] = _serialize_note_date(row.get("material_need_date"))

    for row in flags:
        child_id = _child_ps_key(row.get("planner_ps_id")) or _child_ps_key(row.get("source_ps_id"))
        if not child_id:
            continue
        entry = _bucket(child_id)
        if not entry:
            continue
        entry["material_in"] = bool(row.get("material_in"))
        in_date = _serialize_note_date(row.get("material_in_date"))
        if in_date:
            entry["material_in_date"] = in_date

    return {parent: list(children.values()) for parent, children in by_parent.items()}


def apply_assembly_material_rollup(orders: list[dict[str, Any]]) -> None:
    """Attach assembly_material_subcon on parent PP vouchers from APT children."""
    pps = [pp for order in orders for pp in (order.get("pp_vouchers") or [])]
    for pp in pps:
        pp.pop("assembly_material_subcon", None)
        pp.pop("assembly_material_in_date", None)
        pp.pop("assembly_material_status", None)
        pp.pop("assembly_material_source", None)
        pp.pop("assembly_material_pending_child_count", None)
    parent_ids = [_parent_ps_key(pp.get("process_sheet_no") or pp.get("pp_voucher_no")) for pp in pps]
    parent_ids = [ps_id for ps_id in parent_ids if ps_id]
    if not parent_ids:
        return
    by_parent = load_child_arrivals_by_parent(parent_ids)
    if not by_parent:
        return
    for pp in pps:
        parent_id = _parent_ps_key(pp.get("process_sheet_no") or pp.get("pp_voucher_no"))
        children = by_parent.get(parent_id) or []
        rolled = rollup_assembly_material(
            parent_subcon=pp.get("material_subcon"),
            parent_material_in=bool(pp.get("material_in")),
            parent_material_in_date=pp.get("material_in_date"),
            children=children,
        )
        if not rolled:
            continue
        pp["assembly_material_subcon"] = rolled.get("material_subcon") or ""
        pp["assembly_material_in_date"] = rolled.get("material_in_date")
        pp["assembly_material_status"] = rolled.get("material_status") or ""
        pp["assembly_material_source"] = rolled.get("source") or ""
        pp["assembly_material_pending_child_count"] = int(rolled.get("pending_child_count") or 0)
