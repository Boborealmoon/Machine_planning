"""Shared assembly hierarchy + BOM flag classification for Monitor and Parts Tracker."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Any

from .utils import bom_code_match_key, compact_text, shipped_quantity_completed

# Child COMP sheets use a trailing numeric suffix (NPS26-0321-1), unlike N26-[SR]22.
_CHILD_PS_SUFFIX_RE = re.compile(r"-\d+$")
_RELATED_ROOT_RANK = {"APS": 0, "NPS": 1, "SR": 2}

# Info flags: filterable but not "issues" / anomalies.
INFO_FLAGS = frozenset(
    {
        "nested_assembly",
        "deep_nested",
        "repeated_component",
        "leaf_component",
    }
)

# Extra tolerance for qty_mismatch (absolute and relative).
_QTY_ABS_TOL = 0.0001
_QTY_REL_TOL = 0.02


def assembly_ps_type(ps_id: Any) -> str:
    """APS / NPS / SR (tagged ``A24-[SR]04``) / other voucher prefix."""
    raw = compact_text(ps_id).split("::")[0]
    if "[sr]" in raw.lower():
        return "SR"
    upper = raw.upper()
    for prefix in ("APS", "NPS", "MPS", "PPS", "CPS", "SR"):
        if upper.startswith(prefix):
            return prefix
    return upper[:3] if len(upper) >= 3 else upper


def is_sr_process_sheet(ps_id: Any) -> bool:
    return assembly_ps_type(ps_id) == "SR"


def catalog_source_ps_id(entry: dict[str, Any] | None) -> str:
    raw = compact_text((entry or {}).get("source_ps_id") or (entry or {}).get("ps_id"))
    return raw.split("::")[0]


def is_component_child_ps(ps_id: Any) -> bool:
    """True for COMP sheets like NPS26-0321-1 / N26-[SR]22-1, not the parent root."""
    raw = compact_text(ps_id).split("::")[0]
    return raw.count("-") >= 2 and bool(_CHILD_PS_SUFFIX_RE.search(raw))


def parent_ps_id_from_child(ps_id: Any) -> str:
    raw = compact_text(ps_id).split("::")[0]
    if not is_component_child_ps(raw):
        return ""
    return _CHILD_PS_SUFFIX_RE.sub("", raw)


def _catalog_line_item_from_entry(entry: dict[str, Any], *, related_from: str = "") -> dict[str, Any]:
    return {
        "process_sheet_no": catalog_source_ps_id(entry),
        "part_no": compact_text(
            entry.get("part_no") or entry.get("part_name") or entry.get("inventory_code")
        ),
        "part_desc": compact_text(entry.get("part_desc")),
        "qty": as_float(entry.get("display_qty") or entry.get("partial_qty") or entry.get("total_qty")),
        "source_line_item_no": compact_text(entry.get("source_line_item_no")),
        "status": compact_text(entry.get("status")),
        "current_stage_desc": compact_text(entry.get("current_stage_desc")),
        "execution_status": compact_text(entry.get("execution_status")),
        "related_from": compact_text(related_from),
    }


def _line_item_sort_key(item: dict[str, Any]) -> tuple[int, str]:
    ps_id = compact_text(item.get("process_sheet_no"))
    match = _CHILD_PS_SUFFIX_RE.search(ps_id)
    suffix = int(match.group(0)[1:]) if match else 10**9
    return (suffix, ps_id)


def attach_catalog_assembly_line_items(entries: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Nest COMP line items on parent catalog cards, including SR jobs that share a part.

    APS/NPS parents get their own ``NPS26-0321-1`` children. Direct-PP SRs such as
    ``N26-[SR]22`` often have no COMP sheets of their own; those cards borrow the
    matching assembly's line items (usually the NPS/APS voucher for the same part)
    so planners can still trace into each sub-assembly.
    """
    rows = list(entries or [])
    if not rows:
        return rows

    children_by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)
    roots_by_part: dict[str, list[str]] = defaultdict(list)

    for entry in rows:
        ps_id = catalog_source_ps_id(entry)
        if not ps_id:
            continue
        if is_component_child_ps(ps_id):
            parent = parent_ps_id_from_child(ps_id)
            if parent:
                children_by_parent[parent.upper()].append(entry)
            continue
        part = compact_text(entry.get("part_no") or entry.get("inventory_code")).upper()
        if part:
            roots_by_part[part].append(ps_id)

    for entry in rows:
        ps_id = catalog_source_ps_id(entry)
        if not ps_id or is_component_child_ps(ps_id):
            entry["assembly_line_items"] = []
            entry["assembly_line_item_count"] = 0
            entry.pop("assembly_line_items_related_from", None)
            continue

        own_children = children_by_parent.get(ps_id.upper(), [])
        related_from = ""
        source_children = own_children
        if not source_children:
            part = compact_text(entry.get("part_no") or entry.get("inventory_code")).upper()
            candidates: list[tuple[int, int, str, list[dict[str, Any]]]] = []
            for other_id in roots_by_part.get(part, []):
                if other_id.upper() == ps_id.upper():
                    continue
                kids = children_by_parent.get(other_id.upper()) or []
                if not kids:
                    continue
                rank = _RELATED_ROOT_RANK.get(assembly_ps_type(other_id), 9)
                candidates.append((rank, -len(kids), other_id, kids))
            if candidates:
                candidates.sort()
                related_from = candidates[0][2]
                source_children = candidates[0][3]

        source_children = sorted(
            source_children,
            key=lambda child: (as_int(child.get("pp_partial_no")) or 1, catalog_source_ps_id(child)),
        )
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for child in source_children:
            row = _catalog_line_item_from_entry(child, related_from=related_from)
            key = compact_text(row.get("process_sheet_no")).upper()
            if not key or key in seen:
                continue
            seen.add(key)
            items.append(row)
        items.sort(key=_line_item_sort_key)
        entry["assembly_line_items"] = items
        entry["assembly_line_item_count"] = len(items)
        if related_from:
            entry["assembly_line_items_related_from"] = related_from
        else:
            entry.pop("assembly_line_items_related_from", None)
    return rows


def as_int(value: Any) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return 0


def as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def is_open_root(row: dict[str, Any]) -> bool:
    status = compact_text(row.get("status")).lower()
    if status in {"history", "completed", "complete", "cancelled", "canceled", "void"}:
        return False
    so_qty = row.get("so_det_qty")
    return so_qty is None or not shipped_quantity_completed(so_qty, row.get("qty_shipped"))


def bom_codes(rows_: list[dict[str, Any]]) -> list[str]:
    return sorted({compact_text(row.get("bom_code")) for row in rows_ if compact_text(row.get("bom_code"))})


def selected_root_row(
    root_rows: list[dict[str, Any]],
    child_part: str,
    parent_bom: str,
) -> dict[str, Any]:
    candidates = [
        row
        for row in root_rows
        if as_int(row.get("level")) == 1
        and compact_text(row.get("material_inventory_code")).upper() == child_part.upper()
    ]
    if not candidates:
        return {}
    parent_key = bom_code_match_key(parent_bom)
    if parent_key:
        matched = [row for row in candidates if bom_code_match_key(row.get("bom_code")) == parent_key]
        if matched:
            return matched[0]
    return candidates[0]


def resolve_child_bom(
    selected_bom: str,
    available_boms: list[str],
) -> tuple[str, str]:
    """Return display route and one of ok/alias/missing/unresolved."""
    selected = compact_text(selected_bom)
    if not selected:
        return "", "missing"
    if selected in available_boms:
        return selected, "ok"
    selected_key = bom_code_match_key(selected)
    alias = next((code for code in available_boms if bom_code_match_key(code) == selected_key), "")
    if alias:
        return alias, "alias"
    return selected, "unresolved"


def _qty_mismatch(actual: float, expected: float) -> bool:
    if expected <= 0:
        return False
    diff = abs(actual - expected)
    if diff <= _QTY_ABS_TOL:
        return False
    return diff > max(_QTY_ABS_TOL, abs(expected) * _QTY_REL_TOL)


def _expected_child_qty(root_listing: dict[str, Any], fg_qty: float) -> float | None:
    qty_fg = as_float(root_listing.get("qty_fg"))
    qty_parent = as_float(root_listing.get("qty_parent"))
    if qty_fg > 0 and fg_qty > 0:
        return qty_fg * fg_qty
    if qty_parent > 0 and fg_qty > 0:
        return qty_parent * fg_qty
    if qty_fg > 0:
        return qty_fg
    if qty_parent > 0:
        return qty_parent
    return None


def _warning_flags(flag_set: set[str]) -> list[str]:
    return sorted(flag_set - INFO_FLAGS)


def classify_assembly_family(
    root: dict[str, Any],
    hierarchy_rows: list[dict[str, Any]],
    listing_by_source: dict[str, list[dict[str, Any]]],
    *,
    require_subassembly_children: bool = True,
) -> dict[str, Any] | None:
    """Build one parent job and its component/BOM diagnostics.

    When ``require_subassembly_children`` is True (Assembly BOM Monitor), only
    COMP children that are themselves BOM parents are kept. When False (Parts
    Tracker), every COMP child is kept; leaf/purchased parts get ``leaf_component``.
    """
    ps_id = compact_text(root.get("ps_id"))
    parent_part = compact_text(root.get("part_no"))
    parent_bom = compact_text(root.get("bom_code"))
    fg_row = next(
        (
            row
            for row in hierarchy_rows
            if compact_text(row.get("type")).upper() == "FG"
            and compact_text(row.get("inventory_code")).upper() == parent_part.upper()
        ),
        {},
    )
    component_rows = [
        row
        for row in hierarchy_rows
        if compact_text(row.get("type")).upper() == "COMP"
        and (
            not compact_text(row.get("parent_inventory_code"))
            or compact_text(row.get("parent_inventory_code")).upper() == parent_part.upper()
        )
    ]
    if not component_rows:
        return None

    root_rows = listing_by_source.get(parent_part.upper(), [])
    level1_parts = {
        compact_text(row.get("material_inventory_code")).upper()
        for row in root_rows
        if as_int(row.get("level")) == 1 and compact_text(row.get("material_inventory_code"))
    }
    in_house_level1 = {
        compact_text(row.get("material_inventory_code")).upper()
        for row in root_rows
        if as_int(row.get("level")) == 1
        and compact_text(row.get("material_inventory_code"))
        and compact_text(row.get("in_house_production")).upper() == "Y"
    }
    comp_parts = {
        compact_text(row.get("inventory_code")).upper()
        for row in component_rows
        if compact_text(row.get("inventory_code"))
    }
    instance_counts = Counter(compact_text(row.get("inventory_code")).upper() for row in component_rows)
    children: list[dict[str, Any]] = []
    flag_set: set[str] = {"nested_assembly"}
    fg_qty = as_float(root.get("partial_qty") or root.get("total_qty") or fg_row.get("total_qty"))

    for component in component_rows:
        child_part = compact_text(component.get("inventory_code"))
        root_listing = selected_root_row(root_rows, child_part, parent_bom)
        in_house = compact_text(root_listing.get("in_house_production")).upper() == "Y"
        child_rows = listing_by_source.get(child_part.upper(), [])
        is_subassembly = bool(child_rows)
        child_flags: list[str] = []

        if not is_subassembly:
            if require_subassembly_children:
                continue
            flag_set.add("leaf_component")
            child_flags.append("leaf_component")
            available_boms: list[str] = []
            selected_bom = compact_text(root_listing.get("selected_bom_code"))
            resolved_bom, route_status = "", "ok"
            leaf_materials: list[str] = []
        else:
            available_boms = bom_codes(child_rows)
            selected_bom = compact_text(root_listing.get("selected_bom_code"))
            resolved_bom, route_status = resolve_child_bom(selected_bom, available_boms)
            if len(available_boms) > 1:
                flag_set.add("multiple_boms")
                child_flags.append("multiple_boms")
            if route_status == "missing":
                flag_set.add("missing_bom")
                child_flags.append("missing_bom")
            elif route_status == "unresolved":
                flag_set.add("unresolved_bom")
                child_flags.append("unresolved_bom")
            elif route_status == "alias":
                flag_set.add("bom_alias")
                child_flags.append("bom_alias")
            route_key = bom_code_match_key(resolved_bom or selected_bom)
            route_rows = [
                row
                for row in child_rows
                if not route_key or bom_code_match_key(row.get("bom_code")) == route_key
            ]
            leaf_materials = sorted(
                {
                    compact_text(row.get("material_inventory_code"))
                    for row in route_rows
                    if compact_text(row.get("material_inventory_code"))
                }
            )

        if instance_counts[child_part.upper()] > 1:
            flag_set.add("repeated_component")
            child_flags.append("repeated_component")

        if not require_subassembly_children:
            if child_part.upper() and child_part.upper() not in level1_parts and root_rows:
                flag_set.add("orphan_comp")
                child_flags.append("orphan_comp")
            expected = _expected_child_qty(root_listing, fg_qty) if root_listing else None
            actual_qty = as_float(component.get("total_qty"))
            if expected is not None and _qty_mismatch(actual_qty, expected):
                flag_set.add("qty_mismatch")
                child_flags.append("qty_mismatch")

        children.append(
            {
                "process_sheet_no": compact_text(component.get("process_sheet_no")),
                "component_seq_no": as_int(component.get("component_seq_no")),
                "component_link_no": compact_text(component.get("component_link_no")),
                "component_line_item_no": compact_text(component.get("component_line_item_no")),
                "path": compact_text(component.get("path")),
                "part_no": child_part,
                "description": compact_text(
                    root_listing.get("description") or component.get("inventory_main_desc")
                ),
                "qty": as_float(component.get("total_qty")),
                "expected_qty": _expected_child_qty(root_listing, fg_qty) if root_listing else None,
                "in_house": in_house if root_listing else None,
                "is_subassembly": is_subassembly,
                "selected_bom_code": selected_bom if is_subassembly else compact_text(root_listing.get("selected_bom_code")),
                "resolved_bom_code": resolved_bom,
                "available_bom_codes": available_boms,
                "route_status": route_status if is_subassembly else ("ok" if not root_listing else "ok"),
                "leaf_materials": leaf_materials,
                "repeated": instance_counts[child_part.upper()] > 1,
                "flags": sorted(set(child_flags)),
            }
        )

    if not children:
        return None

    if not require_subassembly_children and in_house_level1:
        missing = sorted(in_house_level1 - comp_parts)
        if missing:
            flag_set.add("missing_comp_sheet")
            for part in missing:
                listing = selected_root_row(root_rows, part, parent_bom)
                children.append(
                    {
                        "process_sheet_no": "",
                        "component_seq_no": 999999,
                        "component_link_no": "",
                        "component_line_item_no": "",
                        "path": "",
                        "part_no": part,
                        "description": compact_text(listing.get("description")),
                        "qty": as_float(listing.get("qty_fg") or listing.get("qty_parent")),
                        "expected_qty": _expected_child_qty(listing, fg_qty) if listing else None,
                        "in_house": True,
                        "is_subassembly": bool(listing_by_source.get(part.upper())),
                        "selected_bom_code": compact_text(listing.get("selected_bom_code")),
                        "resolved_bom_code": "",
                        "available_bom_codes": bom_codes(listing_by_source.get(part.upper(), [])),
                        "route_status": "missing",
                        "leaf_materials": [],
                        "repeated": False,
                        "flags": ["missing_comp_sheet"],
                        "missing_comp_sheet": True,
                    }
                )

    max_depth = max((as_int(row.get("level")) for row in root_rows), default=1)
    if max_depth >= 2:
        flag_set.add("deep_nested")
    child_part_counts = Counter(child["part_no"].upper() for child in children if child.get("part_no"))
    warning_flags = _warning_flags(flag_set)
    display_qty = as_float(root.get("partial_qty") or root.get("total_qty"))
    return {
        "ps_id": ps_id,
        "pp_partial_no": as_int(root.get("pp_partial_no")) or 1,
        "part_no": parent_part,
        "part_desc": compact_text(root.get("part_desc") or fg_row.get("inventory_main_desc")),
        "bom_code": parent_bom,
        "status": compact_text(root.get("status")),
        "due_date": compact_text(root.get("due_date")),
        "qty": display_qty,
        "qty_shipped": as_float(root.get("qty_shipped")),
        "so_det_qty": root.get("so_det_qty"),
        "sales_order_no": compact_text(root.get("sales_order_no") or fg_row.get("sales_order_no")),
        "sales_order_line": compact_text(root.get("sales_order_line") or fg_row.get("line_item_no")),
        "customer_code": compact_text(fg_row.get("customer_code")),
        "customer_po_no": compact_text(fg_row.get("customer_po_no")),
        "current_stage_desc": compact_text(root.get("current_stage_desc")),
        "current_stage_status": compact_text(root.get("current_stage_status")),
        "component_count": len(children),
        "distinct_child_count": len(child_part_counts),
        "max_depth": max_depth,
        "flags": sorted(flag_set),
        "warning_flags": warning_flags,
        "has_anomaly": bool(warning_flags),
        "is_open": is_open_root(root),
        "is_history": not is_open_root(root),
        "ps_type": assembly_ps_type(ps_id),
        "children": sorted(
            children,
            key=lambda child: (
                child.get("component_seq_no") or 999999,
                child.get("process_sheet_no") or "",
                child.get("part_no") or "",
            ),
        ),
    }


def hierarchy_from_bom_listing(
    root: dict[str, Any],
    listing_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Synthesize FG + COMP process-sheet rows from a parent BOM listing.

    Service/repair vouchers (``A24-[SR]04``, ``N26-[SR]22``) are often missing
    from ``mfg_process_sheet_info_v1_view``. When the parent BOM still has
    child parts that are themselves BOM sources, those children are enough
    for the Monitor to treat the job as a nested assembly.
    """
    ps_id = compact_text(root.get("ps_id"))
    parent_part = compact_text(root.get("part_no"))
    parent_bom = compact_text(root.get("bom_code"))
    fg_qty = as_float(root.get("partial_qty") or root.get("total_qty"))
    hierarchy: list[dict[str, Any]] = [
        {
            "pp_voucher_no": ps_id,
            "process_sheet_no": ps_id,
            "type": "FG",
            "inventory_code": parent_part,
            "total_qty": fg_qty,
            "sales_order_no": compact_text(root.get("sales_order_no")),
            "line_item_no": compact_text(root.get("sales_order_line")),
            "inventory_main_desc": compact_text(root.get("part_desc")),
        }
    ]
    level1 = [
        row
        for row in listing_rows
        if as_int(row.get("level")) == 1 and compact_text(row.get("material_inventory_code"))
    ]
    parent_key = bom_code_match_key(parent_bom)
    if parent_key:
        matched = [row for row in level1 if bom_code_match_key(row.get("bom_code")) == parent_key]
        if matched:
            level1 = matched
    seen: set[str] = set()
    seq = 1
    for row in level1:
        child_part = compact_text(row.get("material_inventory_code"))
        key = child_part.upper()
        if key in seen:
            continue
        seen.add(key)
        qty = as_float(row.get("qty_fg") or row.get("qty_parent"))
        if qty <= 0:
            qty = 1.0
        hierarchy.append(
            {
                "pp_voucher_no": ps_id,
                "process_sheet_no": "",
                "type": "COMP",
                "parent_inventory_code": parent_part,
                "inventory_code": child_part,
                "component_seq_no": seq,
                "total_qty": qty * fg_qty if fg_qty > 0 else qty,
                "inventory_main_desc": compact_text(row.get("description")),
            }
        )
        seq += 1
    return hierarchy


def build_assembly_jobs(
    roots: list[dict[str, Any]],
    hierarchy_rows: list[dict[str, Any]],
    bom_rows: list[dict[str, Any]],
    *,
    require_subassembly_children: bool = True,
) -> list[dict[str, Any]]:
    hierarchy_by_ps: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in hierarchy_rows:
        hierarchy_by_ps[compact_text(row.get("pp_voucher_no")).upper()].append(row)
    listing_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in bom_rows:
        listing_by_source[compact_text(row.get("source_inventory_code")).upper()].append(row)

    jobs = [
        job
        for root in roots
        if (
            job := classify_assembly_family(
                root,
                hierarchy_by_ps.get(compact_text(root.get("ps_id")).upper(), []),
                listing_by_source,
                require_subassembly_children=require_subassembly_children,
            )
        )
    ]
    jobs.sort(key=lambda job: (job.get("due_date") or "9999-12-31", job.get("ps_id") or ""))
    return jobs


def apply_stalled_child_flags(job: dict[str, Any]) -> None:
    """Mark open children that are not queued and are overdue (or in-house without material when overdue)."""
    from datetime import date

    flag_set = set(job.get("flags") or [])
    due = compact_text(job.get("due_date"))[:10]
    today = date.today().isoformat()

    for child in job.get("children") or []:
        child["stalled"] = False
        if child.get("missing_comp_sheet"):
            continue
        if child.get("in_house") is False:
            continue
        if child.get("queued_machines"):
            continue
        status = compact_text(child.get("status")).lower()
        if status in {"history", "completed", "complete", "cancelled", "canceled", "void"}:
            continue
        child_due = compact_text(child.get("due_date"))[:10] or due
        child_overdue = bool(child_due and child_due < today)
        if not child_overdue:
            continue
        # Overdue + not queued: stalled. Extra signal when in-house and material not in.
        flag_set.add("stalled_child")
        child_flags = set(child.get("flags") or [])
        child_flags.add("stalled_child")
        child["flags"] = sorted(child_flags)
        child["stalled"] = True

    warning_flags = _warning_flags(flag_set)
    job["flags"] = sorted(flag_set)
    job["warning_flags"] = warning_flags
    job["has_anomaly"] = bool(warning_flags)
