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


def material_lookup_source_inventory(item):
    return compact_text(item.get("inventory_code") or item.get("part_no") or "")


def material_lookup_bom_code(item):
    return compact_text(
        item.get("selected_flow_code")
        or item.get("selected_bom_code")
        or item.get("erp_bom_code")
        or item.get("bom_code")
        or ""
    )


def material_inventory_codes_map(con, keys):
    """Batch lookup material_per_bom rows keyed by (source_inventory_code, bom_code)."""
    pairs = []
    seen = set()
    for item in keys or []:
        if isinstance(item, tuple):
            src, bom = compact_text(item[0]), compact_text(item[1])
        else:
            src = material_lookup_source_inventory(item)
            bom = material_lookup_bom_code(item)
        if not src or not bom:
            continue
        key = (src, bom)
        if key in seen:
            continue
        seen.add(key)
        pairs.append(key)
    if not pairs:
        return {}

    sources = [pair[0] for pair in pairs]
    boms = [pair[1] for pair in pairs]
    out = defaultdict(list)
    seen_codes = defaultdict(set)
    try:
        query_rows = rows(
            con.execute(
                """
                SELECT mpb.source_inventory_code, mpb.bom_code,
                       mpb.material_inventory_code, mpb.description,
                       mpb.qty_parent, mpb.qty_fg, mpb.uom_code
                FROM material_per_bom mpb
                INNER JOIN UNNEST(%s::text[], %s::text[]) AS k(source_inventory_code, bom_code)
                    ON mpb.source_inventory_code = k.source_inventory_code
                   AND mpb.bom_code = k.bom_code
                ORDER BY mpb.source_inventory_code, mpb.bom_code, mpb.material_inventory_code
                """,
                (sources, boms),
            )
        )
    except Exception:
        return {}
    for row in query_rows:
        key = (
            compact_text(row.get("source_inventory_code")),
            compact_text(row.get("bom_code")),
        )
        code = compact_text(row.get("material_inventory_code"))
        if not code or code in seen_codes[key]:
            continue
        seen_codes[key].add(code)
        out[key].append(
            {
                "material_inventory_code": code,
                "description": compact_text(row.get("description") or ""),
                "qty_parent": parse_number(row.get("qty_parent"), 0),
                "qty_fg": parse_number(row.get("qty_fg"), 1),
                "uom_code": compact_text(row.get("uom_code") or ""),
            }
        )
    return dict(out)


def enrich_items_material_inventory_codes(con, items):
    """Attach material_inventory_code(s) from material_per_bom to each process sheet item."""
    if not items:
        return items
    code_map = material_inventory_codes_map(con, items)
    for item in items:
        key = (material_lookup_source_inventory(item), material_lookup_bom_code(item))
        entries = code_map.get(key, [])
        codes = [
            compact_text(entry.get("material_inventory_code"))
            for entry in entries
            if compact_text(entry.get("material_inventory_code"))
        ]
        item["material_inventory_codes"] = codes
        item["material_inventory_code"] = codes[0] if codes else ""
    return items


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


def _bom_qty_per_fg(bom_row):
    qty_parent = parse_number(bom_row.get("qty_parent"), 0)
    qty_fg = parse_number(bom_row.get("qty_fg"), 1) or 1
    if qty_parent <= 0:
        return 0.0
    return float(qty_parent) / float(qty_fg) if qty_fg else float(qty_parent)


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

    bom_rows = rows(
        con.execute(
            """
            SELECT source_inventory_code, bom_code, material_inventory_code,
                   description AS material_description,
                   qty_parent, qty_fg, uom_code
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
        material_qty_needed = _bom_qty_per_fg(bom_row)
        material_uom = compact_text(bom_row.get("uom_code") or "")
        existing = existing_by_code.get(mat_code)

        if existing:
            cur_desc = _requirement_description(existing)
            next_desc = mat_desc or cur_desc
            unchanged = (
                compact_text(existing.get("source_inventory_code")) == source_inventory_code
                and compact_text(existing.get("bom_code")) == bom_code
                and compact_text(existing.get("material_inventory_code")) == mat_code
                and cur_desc == next_desc
                and float(parse_number(existing.get("material_qty_needed"), 0)) == float(material_qty_needed)
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
                (source_inventory_code, bom_code, mat_code, next_desc, material_qty_needed, material_uom,
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
                (ps_id, source_inventory_code, bom_code, mat_code, mat_desc, material_qty_needed, material_uom),
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


def material_ps_summary_map(con):
    summary = {}
    for row in rows(
        con.execute(
            """
            SELECT o.source_ps_id AS ps_id,
                   b.block_id,
                   b.calculated_start_datetime,
                   b.calculated_end_datetime,
                   b.planning_status,
                   b.execution_status,
                   b.status,
                   m.machine_no AS machine_code
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            JOIN planner_machines m ON m.machine_id = b.machine_id
            WHERE COALESCE(o.source_ps_id, '') <> ''
              AND b.active = TRUE
            ORDER BY b.calculated_start_datetime, b.queue_position, b.block_id
            """
        )
    ):
        ps_id = compact_text(row["ps_id"])
        if not ps_id:
            continue
        entry = summary.setdefault(
            ps_id,
            {
                "block_count": 0,
                "not_started_count": 0,
                "in_progress_count": 0,
                "done_count": 0,
                "first_planned_start": "",
                "machine_code": "",
                "planning_status": "UNPLANNED",
                "execution_status": "NOT_STARTED",
            },
        )
        entry["block_count"] += 1
        execution_status = compact_text(row["execution_status"] or row["status"]).upper() or "NOT_STARTED"
        planning_status = compact_text(row["planning_status"]).upper() or "UNPLANNED"
        if execution_status == "NOT_STARTED":
            entry["not_started_count"] += 1
        elif execution_status == "IN_PROGRESS":
            entry["in_progress_count"] += 1
        elif execution_status == "DONE":
            entry["done_count"] += 1
        if not entry["first_planned_start"] and compact_text(row["calculated_start_datetime"]):
            entry["first_planned_start"] = compact_text(row["calculated_start_datetime"])
            entry["machine_code"] = compact_text(row["machine_code"])
        if planning_status and entry["planning_status"] == "UNPLANNED":
            entry["planning_status"] = planning_status
        if execution_status in {"IN_PROGRESS", "DONE"}:
            entry["execution_status"] = "IN_PROGRESS" if execution_status == "IN_PROGRESS" else "DONE"
        elif entry["execution_status"] == "NOT_STARTED":
            entry["execution_status"] = execution_status
    return summary


def _requirement_join_rows(con):
    return rows(
        con.execute(
            """
            SELECT mr.*,
                   mr.planner_ps_id AS ps_id,
                   ps.pp_partial_no,
                   ps.inventory_code AS part_no,
                   pvc.description AS part_desc,
                   ps.planned_qty AS ps_total_qty,
                   ps.status AS ps_status,
                   ps.planner_status,
                   ps.selected_bom_id,
                   sf.bom_code AS selected_flow_code
            FROM planner_material_requirement mr
            JOIN planner_process_sheet ps ON ps.planner_ps_id = mr.planner_ps_id
            LEFT JOIN pp_vouchers_cache pvc
                   ON pvc.ps_id = ps.source_ps_id AND pvc.pp_partial_no = ps.pp_partial_no
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            WHERE COALESCE(sf.bom_code, '') = '' OR mr.bom_code = sf.bom_code
            ORDER BY pvc.due_date, ps.planner_ps_id, mr.requirement_id
            """
        )
    )


def material_requirement_overview_rows(con, include_unplanned=False, include_active=False, include_completed=False, search=""):
    from collections import defaultdict as _dd
    search = compact_text(search).lower()
    requirement_rows = _requirement_join_rows(con)
    grouped = _dd(list)
    for row in requirement_rows:
        grouped[compact_text(row["ps_id"])].append(row)

    ps_summary = material_ps_summary_map(con)
    payloads = []
    for ps_id, rows_for_ps in grouped.items():
        ps_row = rows_for_ps[0]
        summary = ps_summary.get(ps_id, {})
        is_completed = (
            compact_text(ps_row.get("ps_status")).upper() == "COMPLETED"
            or compact_text(ps_row.get("planner_status")).upper() == "COMPLETED"
        )
        block_count = int(summary.get("block_count") or 0)
        has_active = int(summary.get("in_progress_count") or 0) > 0 or int(summary.get("done_count") or 0) > 0
        is_unplanned = block_count <= 0
        is_active = has_active and not is_completed
        is_planned_not_started = block_count > 0 and not is_active and not is_completed

        if is_completed and not include_completed:
            continue
        if is_active and not include_active:
            continue
        if is_unplanned and not include_unplanned:
            continue
        if not (is_planned_not_started or is_completed or is_active or is_unplanned):
            continue

        mat_status = material_status_from_requirement_rows(rows_for_ps, summary.get("first_planned_start", ""))
        first_planned_start = compact_text(summary.get("first_planned_start", ""))
        machine_code = compact_text(summary.get("machine_code", ""))
        if is_completed:
            planning_status = "COMPLETED"
            execution_status = "COMPLETED"
        elif is_active:
            planning_status = compact_text(summary.get("planning_status") or ps_row.get("planner_status") or "PLANNED").upper()
            execution_status = (
                "IN_PROGRESS" if int(summary.get("in_progress_count") or 0) > 0
                else ("DONE" if int(summary.get("done_count") or 0) > 0 else "NOT_STARTED")
            )
        elif is_planned_not_started:
            planning_status = "PLANNED"
            execution_status = "NOT_STARTED"
        else:
            planning_status = "UNPLANNED"
            execution_status = "NOT_STARTED"

        for row in rows_for_ps:
            base_ps, partial = split_ps_id(row["ps_id"])
            material_code = _requirement_inventory_code(row)
            material_desc = _requirement_description(row)
            payload = {
                "requirement_id": int(row["requirement_id"]),
                "ps_id": compact_text(row["ps_id"]),
                "base_ps_number": base_ps,
                "partial": partial,
                "part_no": compact_text(row.get("part_no") or row["ps_id"]),
                "part_desc": compact_text(row.get("part_desc") or ""),
                "bom_code": compact_text(row["bom_code"]),
                "material_inventory_code": material_code,
                "material_description": material_desc,
                "material_qty_needed": float(row["material_qty_needed"] or 0),
                "material_uom": compact_text(row["material_uom"]),
                "first_planned_start": first_planned_start,
                "machine_code": machine_code,
                "planning_status": planning_status,
                "execution_status": execution_status,
                "ps_status": compact_text(row.get("ps_status")),
                "planner_status": compact_text(row.get("planner_status")),
                "supply_status": normalize_supply_status(row["supply_status"]),
                "expected_ready_date": compact_text(row.get("expected_ready_date")),
                "supplier_ref": compact_text(row.get("supplier_ref")),
                "remarks": compact_text(row.get("remarks")),
                "updated_at": compact_text(row.get("updated_at")),
                "material_status": mat_status,
                "is_completed": is_completed,
                "is_active": is_active,
                "is_unplanned": is_unplanned,
                "is_planned_not_started": is_planned_not_started,
            }
            haystack = " ".join(
                compact_text(part).lower()
                for part in (
                    payload["ps_id"], payload["part_no"], payload["part_desc"],
                    payload["bom_code"], payload["material_inventory_code"],
                    payload["material_description"], payload["supplier_ref"],
                    payload["remarks"], payload["machine_code"],
                    payload["supply_status"], payload["expected_ready_date"],
                    payload["planning_status"], payload["execution_status"],
                )
            )
            if search and search not in haystack:
                continue
            payloads.append(payload)

    return payloads
