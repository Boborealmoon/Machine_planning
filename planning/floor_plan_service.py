"""Factory floor plan - layout, capacity utilization, and part-number tags."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .capacity_group_service import build_group_capacity_report, default_planning_month
from .helpers import one, rows
from .machines import fetch_machines
from .utils import compact_text

FLOOR_LAYOUT_WIDTH = 10.0
FLOOR_LAYOUT_HEIGHT = 10.0
FLOOR_LAYOUT_PADDING = 0.55

FLOOR_LAYOUT_COLORS = {
    "turnmill": "#00B4D8",
    "mpp": "#FFB703",
    "turning": "#8AB17D",
    "milling": "#FF4D4D",
}

# Matplotlib-style coords: y increases upward. All machines sit inside y >= 0.
FLOOR_LAYOUT_MACHINES: tuple[dict[str, Any], ...] = (
    # Turnmill (top)
    {"machine_no": "CNC 38", "label": "38", "x": 1, "y": 8, "w": 2, "h": 1.5, "color": "turnmill"},
    {"machine_no": "CNC 39", "label": "39", "x": 4, "y": 8, "w": 2, "h": 1.5, "color": "turnmill"},
    {"machine_no": "CNC 40", "label": "40", "x": 8, "y": 7.5, "w": 1, "h": 2, "color": "turnmill", "rotation": 90},
    # MPP (left column - 24hr cells)
    {"machine_no": "CNC 35", "label": "35", "x": 0.5, "y": 4, "w": 1, "h": 2.5, "color": "mpp", "rotation": 90},
    {"machine_no": "CNC 36", "label": "36", "x": 0.5, "y": 1, "w": 1, "h": 2.5, "color": "mpp", "rotation": 90},
    # Turning (center)
    {"machine_no": "CNC 30", "label": "30", "x": 2.5, "y": 6, "w": 1, "h": 0.8, "color": "turning"},
    {"machine_no": "CNC 31", "label": "31", "x": 4, "y": 6, "w": 1, "h": 0.8, "color": "turning"},
    {"machine_no": "CNC 32", "label": "32", "x": 5.5, "y": 6, "w": 1, "h": 0.8, "color": "turning"},
    {"machine_no": "CNC 22", "label": "22", "x": 3, "y": 4.5, "w": 1, "h": 0.8, "color": "turning"},
    {"machine_no": "CNC 10", "label": "10", "x": 4.5, "y": 4.5, "w": 1, "h": 0.8, "color": "turning"},
    {"machine_no": "CNC 15", "label": "15", "x": 6.5, "y": 4, "w": 0.6, "h": 1, "color": "turning", "rotation": 90},
    {"machine_no": "CNC 21", "label": "21", "x": 6.5, "y": 2.5, "w": 0.6, "h": 1, "color": "turning", "rotation": 90},
    {"machine_no": "CNC 24", "label": "24", "x": 6, "y": 1, "w": 1, "h": 0.8, "color": "turning"},
    # Milling + turning (right column, bottom to top: 41, 27, 25, 26, 20, 29)
    {"machine_no": "CNC 29", "label": "29", "x": 8.5, "y": 5.7, "w": 0.8, "h": 1, "color": "milling", "rotation": 90},
    {"machine_no": "CNC 20", "label": "20", "x": 8.5, "y": 4.55, "w": 0.8, "h": 1, "color": "milling", "rotation": 90},
    {"machine_no": "CNC 26", "label": "26", "x": 8.5, "y": 3.4, "w": 0.8, "h": 1, "color": "milling", "rotation": 90},
    {"machine_no": "CNC 25", "label": "25", "x": 8.5, "y": 2.25, "w": 0.8, "h": 1, "color": "milling", "rotation": 90},
    {"machine_no": "CNC 27", "label": "27", "x": 8.5, "y": 1.2, "w": 0.8, "h": 0.9, "color": "turning", "rotation": 90},
    # CNC 41 - I-800 MPP lane, aligned below right column inside the floor bounds
    {
        "machine_no": "CNC 41",
        "label": "41",
        "subtitle": "I-800",
        "x": 8.5,
        "y": 0.15,
        "w": 0.8,
        "h": 0.9,
        "color": "mpp",
        "rotation": 90,
    },
)

_MAX_TAG_LABEL_LENGTH = 80
_MAX_TAG_NOTES_LENGTH = 500


def compute_layout_bounds(
    machines: tuple[dict[str, Any], ...] | list[dict[str, Any]],
    *,
    pad: float | None = None,
) -> dict[str, float]:
    padding = FLOOR_LAYOUT_PADDING if pad is None else float(pad)
    min_x = min(float(m["x"]) for m in machines)
    min_y = min(float(m["y"]) for m in machines)
    max_x = max(float(m["x"]) + float(m["w"]) for m in machines)
    max_y = max(float(m["y"]) + float(m["h"]) for m in machines)
    return {
        "min_x": min_x - padding,
        "min_y": min_y - padding,
        "max_x": max_x + padding,
        "max_y": max_y + padding,
        "width": (max_x - min_x) + (2 * padding),
        "height": (max_y - min_y) + (2 * padding),
        "padding": padding,
    }


def ensure_floor_plan_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_machine_part_tag (
            tag_id       BIGSERIAL    PRIMARY KEY,
            machine_id   BIGINT       NOT NULL
                REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
            part_no      TEXT         NOT NULL CHECK (LENGTH(BTRIM(part_no)) > 0),
            tag_label    TEXT         NOT NULL DEFAULT '',
            notes        TEXT         NOT NULL DEFAULT '',
            created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (machine_id, part_no)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_machine_part_tag_machine
            ON public.planner_machine_part_tag (machine_id)
        """
    )
    con.execute(
        """
        INSERT INTO public.planner_machines (machine_no, machine_category, shift_profile, active)
        VALUES ('CNC 41', 'MPP', 'STANDARD', TRUE)
        ON CONFLICT (machine_no) DO NOTHING
        """
    )


def _machine_code(machine: dict) -> str:
    return compact_text(machine.get("machine_code") or machine.get("machine_no"))


def _utilization_by_machine_code(capacity_report: dict) -> dict[str, float]:
    lookup: dict[str, float] = {}
    for group in capacity_report.get("groups") or []:
        for machine in group.get("machines") or []:
            code = compact_text(machine.get("machine_code"))
            if code:
                lookup[code] = float(machine.get("effective_utilization_pct") or 0.0)
    return lookup


def _fetch_part_tags(con) -> dict[int, list[dict[str, Any]]]:
    tag_rows = rows(
        con.execute(
            """
            SELECT
                t.tag_id,
                t.machine_id,
                t.part_no,
                t.tag_label,
                t.notes,
                t.created_at,
                t.updated_at,
                m.machine_no
            FROM public.planner_machine_part_tag t
            JOIN public.planner_machines m ON m.machine_id = t.machine_id
            ORDER BY m.machine_no, t.part_no
            """
        )
    )
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in tag_rows:
        machine_id = int(row["machine_id"])
        grouped.setdefault(machine_id, []).append(
            {
                "tag_id": int(row["tag_id"]),
                "machine_id": machine_id,
                "machine_no": row["machine_no"],
                "part_no": row["part_no"],
                "tag_label": row["tag_label"] or "",
                "notes": row["notes"] or "",
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
            }
        )
    return grouped


def fetch_floor_plan(
    con,
    *,
    year: int | None = None,
    month: int | None = None,
    capacity_basis: str = "rest_of_month",
    as_of: date | None = None,
) -> dict[str, Any]:
    ensure_floor_plan_tables(con)
    default_year, default_month = default_planning_month(as_of)
    year = int(year or default_year)
    month = int(month or default_month)
    as_of_date = as_of or date.today()

    capacity_report = build_group_capacity_report(
        con,
        year,
        month,
        capacity_basis=capacity_basis,
        as_of=as_of_date,
    )
    utilization_lookup = _utilization_by_machine_code(capacity_report)

    db_machines = { _machine_code(m): m for m in fetch_machines(con) }
    tags_by_machine = _fetch_part_tags(con)

    machines: list[dict[str, Any]] = []
    for layout in FLOOR_LAYOUT_MACHINES:
        machine_no = layout["machine_no"]
        db_row = db_machines.get(machine_no) or {}
        machine_id = int(db_row["machine_id"]) if db_row.get("machine_id") is not None else None
        tags = tags_by_machine.get(machine_id or -1, []) if machine_id else []
        machines.append(
            {
                **layout,
                "machine_id": machine_id,
                "machine_category": compact_text(db_row.get("machine_category")),
                "shift_profile": compact_text(db_row.get("shift_profile")) or "STANDARD",
                "effective_utilization_pct": utilization_lookup.get(machine_no, 0.0),
                "tags": tags,
                "subtitle": compact_text(layout.get("subtitle")),
            }
        )

    return {
        "ok": True,
        "layout_bounds": compute_layout_bounds(FLOOR_LAYOUT_MACHINES),
        "layout_width": FLOOR_LAYOUT_WIDTH,
        "layout_height": FLOOR_LAYOUT_HEIGHT,
        "layout_colors": FLOOR_LAYOUT_COLORS,
        "machines": machines,
        "capacity": {
            "planning_year": capacity_report.get("planning_year"),
            "planning_month": capacity_report.get("planning_month"),
            "planning_month_label": capacity_report.get("planning_month_label"),
            "capacity_basis": capacity_report.get("capacity_basis"),
            "capacity_basis_label": capacity_report.get("capacity_basis_label"),
            "capacity_window_label": capacity_report.get("capacity_window_label"),
            "capacity_window_start": capacity_report.get("capacity_window_start"),
            "capacity_window_end": capacity_report.get("capacity_window_end"),
            "as_of_date": capacity_report.get("as_of_date"),
            "groups": [
                {
                    "key": group.get("key"),
                    "label": group.get("label"),
                    "header_subtitle": group.get("header_subtitle"),
                    "effective_utilization_pct": group.get("effective_utilization_pct"),
                }
                for group in capacity_report.get("groups") or []
            ],
        },
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _normalize_part_no(raw: Any) -> str:
    part_no = compact_text(raw).upper()
    if not part_no:
        raise ValueError("Part number is required.")
    if len(part_no) > 80:
        raise ValueError("Part number cannot exceed 80 characters.")
    return part_no


def add_machine_part_tag(
    con,
    *,
    machine_id: int,
    part_no: str,
    tag_label: str = "",
    notes: str = "",
) -> dict[str, Any]:
    ensure_floor_plan_tables(con)
    machine_id = int(machine_id)
    part_no = _normalize_part_no(part_no)
    tag_label = compact_text(tag_label)[:_MAX_TAG_LABEL_LENGTH]
    notes = compact_text(notes)[:_MAX_TAG_NOTES_LENGTH]

    machine = one(
        con.execute(
            "SELECT machine_id, machine_no FROM public.planner_machines WHERE machine_id = %s",
            (machine_id,),
        )
    )
    if not machine:
        raise ValueError("Machine not found.")

    row = one(
        con.execute(
            """
            INSERT INTO public.planner_machine_part_tag (machine_id, part_no, tag_label, notes)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (machine_id, part_no)
            DO UPDATE SET
                tag_label = EXCLUDED.tag_label,
                notes = EXCLUDED.notes,
                updated_at = NOW()
            RETURNING tag_id, machine_id, part_no, tag_label, notes, created_at, updated_at
            """,
            (machine_id, part_no, tag_label, notes),
        )
    )
    return {
        "tag_id": int(row["tag_id"]),
        "machine_id": machine_id,
        "machine_no": machine["machine_no"],
        "part_no": row["part_no"],
        "tag_label": row["tag_label"] or "",
        "notes": row["notes"] or "",
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


def delete_machine_part_tag(con, tag_id: int) -> bool:
    ensure_floor_plan_tables(con)
    cur = con.execute(
        "DELETE FROM public.planner_machine_part_tag WHERE tag_id = %s RETURNING tag_id",
        (int(tag_id),),
    )
    return one(cur) is not None
