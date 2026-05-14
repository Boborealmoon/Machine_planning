"""
planning/materials.py — material requirement helpers (PostgreSQL port).

Key schema differences from Vanessa's SQLite version:
  - material_requirement   → planner_material_requirement (ps_id → planner_ps_id)
  - process_sheet          → planner_process_sheet (planner_ps_id aliased as ps_id)
  - bom_material           → material_per_bom (ERP sync table; column description not material_description)
  - parts                  → removed; use pp_vouchers_cache for part_no / description
  - bom_variation          → planner_bom_variation
"""
from __future__ import annotations

from collections import defaultdict

from .helpers import one, parse_dt_text, rows
from .utils import compact_text, parse_number

ALLOWED_SUPPLY_STATUSES = {
    "PENDING_CONFIRMATION",
    "READY",
    "NOT_READY",
    "ORDERED",
    "DELAYED",
    "NOT_REQUIRED",
}


def split_ps_id(ps_id):
    raw = compact_text(ps_id)
    if not raw:
        return "", ""
    if "::" not in raw:
        return raw, ""
    base, partial = raw.split("::", 1)
    return base or raw, partial or ""


def normalize_supply_status(value):
    status = compact_text(value).upper() or "PENDING_CONFIRMATION"
    return status if status in ALLOWED_SUPPLY_STATUSES else "PENDING_CONFIRMATION"


def _requirement_inventory_code(row):
    return compact_text(row.get("material_inventory_code"))


def _requirement_description(row):
    return compact_text(row.get("material_description") or row.get("material_desc"))


def _ps_requirement_context(con, ps_id):
    """Return process sheet row with ERP columns joined (used for sync)."""
    ps_id = compact_text(ps_id)
    if not ps_id:
        return None
    return one(
        con.execute(
            """
            SELECT
                ps.planner_ps_id AS ps_id,
                ps.source_ps_id,
                ps.pp_partial_no,
                ps.inventory_code,
                ps.selected_bom_id,
                ps.planner_status,
                ps.status,
                v.part_no,
                v.part_no AS part_name,
                v.description AS part_desc,
                v.total_qty,
                v.partial_qty,
                v.due_date,
                sf.bom_code AS selected_flow_code
            FROM planner_process_sheet ps
            LEFT JOIN pp_vouchers_cache v
                   ON v.ps_id = ps.source_ps_id
                  AND v.pp_partial_no = ps.pp_partial_no
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id = %s
            """,
            (ps_id,),
        )
    )


def sync_material_requirements_for_ps(con, ps_id):
    """
    Sync material_requirement rows for one PS from material_per_bom (ERP sync table).
    Uses inventory_code + selected BOM flow code to find matching BOM materials.
    """
    ps_id = compact_text(ps_id)
    if not ps_id:
        return {"inserted": 0, "updated": 0, "skipped": 0, "requirement_ids": []}

    ps = _ps_requirement_context(con, ps_id)
    if not ps:
        return {"inserted": 0, "updated": 0, "skipped": 0, "requirement_ids": []}

    source_inventory_code = compact_text(ps.get("inventory_code") or ps.get("part_no") or "")
    if not source_inventory_code:
        return {"inserted": 0, "updated": 0, "skipped": 0, "requirement_ids": []}

    bom_code = compact_text(ps.get("selected_flow_code") or "")
    total_qty = max(0.0, parse_number(ps.get("total_qty"), 0))
    material_uom = "EA" if total_qty > 0 else ""

    bom_rows = rows(
        con.execute(
            """
            SELECT source_inventory_code, bom_code, material_inventory_code,
                   description AS material_description
            FROM material_per_bom
            WHERE source_inventory_code = %s AND bom_code = %s
            ORDER BY material_inventory_code
            """,
            (source_inventory_code, bom_code),
        )
    )

    counts = {"inserted": 0, "updated": 0, "skipped": 0, "requirement_ids": []}
    if not bom_rows:
        return counts

    current_codes = []
    seen_codes = set()
    for bom_row in bom_rows:
        code = compact_text(bom_row["material_inventory_code"])
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        current_codes.append(code)

    existing_rows = rows(
        con.execute(
            "SELECT * FROM planner_material_requirement WHERE planner_ps_id = %s ORDER BY requirement_id",
            (ps_id,),
        )
    )
    existing_by_code = {}
    stale_ids = []
    duplicate_ids = []
    for existing in existing_rows:
        code = compact_text(existing.get("material_inventory_code"))
        if not code or code not in current_codes:
            stale_ids.append(int(existing["requirement_id"]))
            continue
        if code in existing_by_code:
            duplicate_ids.append(int(existing["requirement_id"]))
            continue
        existing_by_code[code] = existing

    for bom_row in bom_rows:
        mat_code = compact_text(bom_row["material_inventory_code"])
        if not mat_code or mat_code not in current_codes:
            counts["skipped"] += 1
            continue
        mat_desc = compact_text(bom_row.get("material_description") or "")
        existing = existing_by_code.get(mat_code)

        if existing:
            cur_desc = _requirement_description(existing)
            next_desc = mat_desc or cur_desc
            unchanged = (
                compact_text(existing.get("source_inventory_code")) == source_inventory_code
                and compact_text(existing.get("bom_code")) == bom_code
                and compact_text(existing.get("material_inventory_code")) == mat_code
                and cur_desc == next_desc
                and float(parse_number(existing.get("material_qty_needed"), 0)) == float(total_qty)
                and compact_text(existing.get("material_uom")) == material_uom
            )
            if unchanged:
                counts["skipped"] += 1
                counts["requirement_ids"].append(int(existing["requirement_id"]))
                continue
            con.execute(
                """
                UPDATE planner_material_requirement
                SET source_inventory_code = %s,
                    bom_code = %s,
                    material_inventory_code = %s,
                    material_description = %s,
                    material_qty_needed = %s,
                    material_uom = %s,
                    updated_at = NOW()
                WHERE requirement_id = %s
                """,
                (source_inventory_code, bom_code, mat_code, next_desc, total_qty, material_uom,
                 int(existing["requirement_id"])),
            )
            counts["updated"] += 1
            counts["requirement_ids"].append(int(existing["requirement_id"]))
        else:
            cur = con.execute(
                """
                INSERT INTO planner_material_requirement (
                    planner_ps_id, source_inventory_code, bom_code, material_inventory_code,
                    material_description, material_qty_needed, material_uom,
                    supply_status, supplier_ref, remarks
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, 'PENDING_CONFIRMATION', '', '')
                RETURNING requirement_id
                """,
                (ps_id, source_inventory_code, bom_code, mat_code, mat_desc, total_qty, material_uom),
            )
            new_row = one(cur)
            counts["inserted"] += 1
            if new_row:
                counts["requirement_ids"].append(int(new_row["requirement_id"]))

    if stale_ids or duplicate_ids:
        delete_ids = list({*stale_ids, *duplicate_ids})
        con.execute(
            "DELETE FROM planner_material_requirement WHERE requirement_id = ANY(%s)",
            (delete_ids,),
        )
    return counts


def sync_material_requirements_for_ps_ids(con, ps_ids):
    aggregated = {"inserted": 0, "updated": 0, "skipped": 0, "requirement_ids": []}
    for ps_id in sorted({compact_text(x) for x in ps_ids if compact_text(x)}):
        result = sync_material_requirements_for_ps(con, ps_id)
        aggregated["inserted"] += int(result.get("inserted") or 0)
        aggregated["updated"] += int(result.get("updated") or 0)
        aggregated["skipped"] += int(result.get("skipped") or 0)
        aggregated["requirement_ids"].extend(result.get("requirement_ids") or [])
    return aggregated


def material_requirement_rows_for_ps(con, ps_id):
    ps_id = compact_text(ps_id)
    if not ps_id:
        return []

    ps = one(
        con.execute(
            """
            SELECT ps.planner_ps_id AS ps_id, sf.bom_code AS selected_flow_code
            FROM planner_process_sheet ps
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id = %s
            """,
            (ps_id,),
        )
    )
    if not ps:
        return []

    flow_code = compact_text(ps.get("selected_flow_code"))
    if flow_code:
        matched = rows(
            con.execute(
                """
                SELECT *, planner_ps_id AS ps_id
                FROM planner_material_requirement
                WHERE planner_ps_id = %s AND bom_code = %s
                ORDER BY requirement_id
                """,
                (ps_id, flow_code),
            )
        )
        if matched:
            return matched

    return rows(
        con.execute(
            """
            SELECT *, planner_ps_id AS ps_id
            FROM planner_material_requirement
            WHERE planner_ps_id = %s
            ORDER BY requirement_id
            """,
            (ps_id,),
        )
    )


def _parse_date(value):
    dt = parse_dt_text(value)
    return dt.date() if dt else None


def material_status_from_requirement_rows(requirement_rows, planned_start_text=""):
    if not requirement_rows:
        return {"status": "PENDING_CONFIRMATION", "label": "Material pending",
                "expected_ready_date": "", "severity": "pending"}

    statuses = [normalize_supply_status(row.get("supply_status")) for row in requirement_rows]
    if all(s in {"READY", "NOT_REQUIRED"} for s in statuses):
        return {"status": "READY", "label": "", "expected_ready_date": "", "severity": "none"}

    actionable = [r for r in requirement_rows
                  if normalize_supply_status(r.get("supply_status")) not in {"READY", "NOT_REQUIRED"}]
    planned_start = _parse_date(planned_start_text)
    expected_dates = [d for d in (_parse_date(r.get("expected_ready_date")) for r in actionable) if d]
    if expected_dates:
        expected_date = max(expected_dates)
        label = f"Material ready {expected_date.isoformat()}"
        severity = "warning"
        if planned_start and expected_date > planned_start:
            label = f"Material late: {expected_date.isoformat()}"
            severity = "late"
        return {"status": normalize_supply_status(actionable[0].get("supply_status")) or "NOT_READY",
                "label": label, "expected_ready_date": expected_date.isoformat(), "severity": severity}

    primary = normalize_supply_status(actionable[0].get("supply_status")) if actionable else "PENDING_CONFIRMATION"
    labels = {
        "PENDING_CONFIRMATION": ("Material pending", "pending"),
        "ORDERED": ("Material ordered", "warning"),
        "DELAYED": ("Material delayed", "late"),
    }
    label, severity = labels.get(primary, ("Material not ready", "warning"))
    return {"status": primary, "label": label, "expected_ready_date": "", "severity": severity}


def material_status_for_ps(con, ps_id, planned_start_text=""):
    return material_status_from_requirement_rows(
        material_requirement_rows_for_ps(con, ps_id), planned_start_text
    )


def material_status_map_for_ps_ids(con, ps_ids, planned_starts=None):
    planned_starts = planned_starts or {}
    result = {}
    for ps_id in sorted({compact_text(x) for x in ps_ids if compact_text(x)}):
        result[ps_id] = material_status_for_ps(con, ps_id, planned_starts.get(ps_id, ""))
    return result


def material_requirement_payload(row):
    payload = dict(row)
    ps_id_val = compact_text(payload.get("ps_id") or payload.get("planner_ps_id") or "")
    payload["ps_id"] = ps_id_val
    payload["base_ps_number"] = split_ps_id(ps_id_val)[0]
    payload["partial"] = split_ps_id(ps_id_val)[1]
    payload["material_code"] = compact_text(payload.get("material_inventory_code"))
    payload["material_desc"] = compact_text(payload.get("material_description"))
    return payload
