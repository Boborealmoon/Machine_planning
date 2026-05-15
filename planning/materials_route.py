"""planning/materials_route.py — Materials API (PostgreSQL port of Vanessa's routes/materials.py).

Key changes:
  db()                     → planner_db()
  material_requirement     → planner_material_requirement
  process_sheet            → planner_process_sheet
  ?                        → %s
  CURRENT_TIMESTAMP        → NOW()
  endpoint prefix          → /api/trial/materials/
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from .helpers import planner_db, one
from .helpers import rows as _rows
from .materials import (
    ALLOWED_SUPPLY_STATUSES,
    material_requirement_overview_rows,
    material_requirement_payload,
    normalize_supply_status,
    sync_material_requirements_for_ps_ids,
)
from .utils import compact_text, parse_date_text

materials_route_bp = Blueprint("planner_materials", __name__)


@materials_route_bp.get("/api/trial/materials/requirements")
def api_material_requirements():
    include_unplanned = int(request.args.get("include_unplanned") or 0) == 1
    include_active = int(request.args.get("include_active") or 0) == 1
    include_completed = int(request.args.get("include_completed") or 0) == 1
    search = compact_text(request.args.get("search"))
    with planner_db() as con:
        sync_material_requirements_for_ps_ids(
            con,
            [row["planner_ps_id"] for row in _rows(con.execute("SELECT planner_ps_id FROM planner_process_sheet"))],
        )
        requirements = material_requirement_overview_rows(
            con,
            include_unplanned=include_unplanned,
            include_active=include_active,
            include_completed=include_completed,
            search=search,
        )
        return jsonify(
            {
                "ok": True,
                "requirements": requirements,
                "filters": {
                    "include_unplanned": include_unplanned,
                    "include_active": include_active,
                    "include_completed": include_completed,
                    "search": search,
                },
            }
        )


@materials_route_bp.put("/api/trial/materials/requirements/<int:requirement_id>")
def api_update_material_requirement(requirement_id):
    data = request.get_json(force=True, silent=True) or {}
    with planner_db() as con:
        row = one(con.execute(
            "SELECT * FROM planner_material_requirement WHERE requirement_id = %s",
            (int(requirement_id),),
        ))
        if not row:
            return jsonify({"error": "Material requirement not found"}), 404

        supply_status = normalize_supply_status(row["supply_status"])
        if "supply_status" in data:
            supply_status = compact_text(data.get("supply_status")).upper() or "PENDING_CONFIRMATION"
            if supply_status not in ALLOWED_SUPPLY_STATUSES:
                return jsonify({"error": "Invalid supply status"}), 400

        expected_ready_date = compact_text(row.get("expected_ready_date"))
        if "expected_ready_date" in data:
            expected_ready_date = parse_date_text(data.get("expected_ready_date"))

        supplier_ref = compact_text(row.get("supplier_ref"))
        if "supplier_ref" in data:
            supplier_ref = compact_text(data.get("supplier_ref"))

        remarks = compact_text(row.get("remarks"))
        if "remarks" in data:
            remarks = compact_text(data.get("remarks"))

        if "expected_ready_date" in data and expected_ready_date and supply_status == "PENDING_CONFIRMATION":
            supply_status = "ORDERED"

        con.execute(
            """
            UPDATE planner_material_requirement
            SET supply_status = %s,
                expected_ready_date = %s,
                supplier_ref = %s,
                remarks = %s,
                updated_at = NOW()
            WHERE requirement_id = %s
            """,
            (
                supply_status,
                expected_ready_date or None,
                supplier_ref,
                remarks,
                int(requirement_id),
            ),
        )
        updated = one(con.execute(
            "SELECT * FROM planner_material_requirement WHERE requirement_id = %s",
            (int(requirement_id),),
        ))
        return jsonify({"ok": True, "requirement": material_requirement_payload(updated)})
