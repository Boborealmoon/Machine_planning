"""Factory floor plan - layout, capacity utilization, and monthly capacity bookings."""

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
    # CNC 41 - I-800 MPP lane: large horizontal rectangle under the right column
    {
        "machine_no": "CNC 41",
        "label": "41",
        "subtitle": "I-800",
        "x": 7.0,
        "y": 0.1,
        "w": 2.3,
        "h": 1.0,
        "color": "mpp",
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


def floor_layout_payload() -> dict[str, Any]:
    """Shop positions and colours for the OEE floor view. No capacity data."""
    machines: list[dict[str, Any]] = []
    for layout in FLOOR_LAYOUT_MACHINES:
        machines.append(
            {
                "machine_no": layout["machine_no"],
                "label": layout["label"],
                "subtitle": compact_text(layout.get("subtitle")),
                "x": layout["x"],
                "y": layout["y"],
                "w": layout["w"],
                "h": layout["h"],
                "color": layout["color"],
                "cnc_number": int(str(layout["label"])),
            }
        )

    def _numbers(predicate) -> list[int]:
        return [int(str(item["label"])) for item in FLOOR_LAYOUT_MACHINES if predicate(item)]

    groups = (
        {
            "key": "mpp",
            "label": "MPP",
            "color": "mpp",
            "cnc_numbers": _numbers(lambda item: item["color"] == "mpp" and item["machine_no"] != "CNC 41"),
        },
        {
            "key": "multiaxis",
            "label": "Multi-Axis",
            "color": "turnmill",
            "cnc_numbers": _numbers(lambda item: item["color"] == "turnmill"),
        },
        {
            "key": "turning",
            "label": "CNC TN",
            "color": "turning",
            "cnc_numbers": _numbers(lambda item: item["color"] == "turning"),
        },
        {
            "key": "milling",
            "label": "CNC ML",
            "color": "milling",
            "cnc_numbers": _numbers(lambda item: item["color"] == "milling"),
        },
        {
            "key": "cnc41",
            "label": "CNC 41",
            "subtitle": "I-800",
            "color": "mpp",
            "cnc_numbers": [41],
        },
    )
    return {
        "layout_bounds": compute_layout_bounds(FLOOR_LAYOUT_MACHINES),
        "layout_colors": dict(FLOOR_LAYOUT_COLORS),
        "legend": (
            {"key": "turnmill", "label": "Turnmill"},
            {"key": "mpp", "label": "MPP (35/36/41)"},
            {"key": "turning", "label": "Turning"},
            {"key": "milling", "label": "Milling"},
        ),
        "groups": groups,
        "machines": machines,
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
        CREATE TABLE IF NOT EXISTS public.planner_machine_capacity_booking (
            booking_id      BIGSERIAL    PRIMARY KEY,
            machine_id      BIGINT       NOT NULL
                REFERENCES public.planner_machines(machine_id) ON DELETE CASCADE,
            planning_year   INTEGER      NOT NULL CHECK (planning_year BETWEEN 2000 AND 2100),
            planning_month  INTEGER      NOT NULL CHECK (planning_month BETWEEN 1 AND 12),
            part_no         TEXT         NOT NULL CHECK (LENGTH(BTRIM(part_no)) > 0),
            reserved_hours  NUMERIC(10, 2) NOT NULL CHECK (reserved_hours > 0),
            tag_label       TEXT         NOT NULL DEFAULT '',
            notes           TEXT         NOT NULL DEFAULT '',
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (machine_id, planning_year, planning_month, part_no)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_machine_capacity_booking_month
            ON public.planner_machine_capacity_booking (planning_year, planning_month)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_machine_capacity_booking_machine
            ON public.planner_machine_capacity_booking (machine_id)
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


def reserved_pct(reserved_hours: float, capacity_hours: float) -> float:
    """Reserved hours as a percent of effective capacity (0 when capacity is 0)."""
    capacity = float(capacity_hours or 0.0)
    if capacity <= 0:
        return 0.0
    return round((float(reserved_hours or 0.0) / capacity) * 100.0, 1)


def normalize_reserved_hours(raw: Any) -> float:
    try:
        hours = float(raw)
    except (TypeError, ValueError):
        raise ValueError("Reserved hours must be a number.") from None
    if hours <= 0:
        raise ValueError("Reserved hours must be greater than 0.")
    if hours > 100_000:
        raise ValueError("Reserved hours is too large.")
    return round(hours, 2)


def normalize_planning_month(year: Any, month: Any) -> tuple[int, int]:
    try:
        planning_year = int(year)
        planning_month = int(month)
    except (TypeError, ValueError):
        raise ValueError("Planning year and month are required.") from None
    if planning_year < 2000 or planning_year > 2100:
        raise ValueError("Planning year must be between 2000 and 2100.")
    if planning_month < 1 or planning_month > 12:
        raise ValueError("Planning month must be between 1 and 12.")
    return planning_year, planning_month


def _utilization_by_machine_code(capacity_report: dict) -> dict[str, float]:
    lookup: dict[str, float] = {}
    for group in capacity_report.get("groups") or []:
        for machine in group.get("machines") or []:
            code = compact_text(machine.get("machine_code"))
            if code:
                lookup[code] = float(machine.get("effective_utilization_pct") or 0.0)
    return lookup


def capacity_hours_by_machine_code(capacity_report: dict) -> dict[str, float]:
    lookup: dict[str, float] = {}
    for group in capacity_report.get("groups") or []:
        for machine in group.get("machines") or []:
            code = compact_text(machine.get("machine_code"))
            if code:
                lookup[code] = float(machine.get("effective_capacity_hours") or 0.0)
    return lookup


def _serialize_booking(row: dict, machine_no: str | None = None) -> dict[str, Any]:
    return {
        "booking_id": int(row["booking_id"]),
        "machine_id": int(row["machine_id"]),
        "machine_no": machine_no or row.get("machine_no") or "",
        "planning_year": int(row["planning_year"]),
        "planning_month": int(row["planning_month"]),
        "part_no": row["part_no"],
        "reserved_hours": float(row["reserved_hours"] or 0.0),
        "tag_label": row.get("tag_label") or "",
        "notes": row.get("notes") or "",
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
    }


def fetch_bookings(
    con,
    year: int,
    month: int,
) -> dict[int, list[dict[str, Any]]]:
    booking_rows = rows(
        con.execute(
            """
            SELECT
                b.booking_id,
                b.machine_id,
                b.planning_year,
                b.planning_month,
                b.part_no,
                b.reserved_hours,
                b.tag_label,
                b.notes,
                b.created_at,
                b.updated_at,
                m.machine_no
            FROM public.planner_machine_capacity_booking b
            JOIN public.planner_machines m ON m.machine_id = b.machine_id
            WHERE b.planning_year = %s
              AND b.planning_month = %s
            ORDER BY m.machine_no, b.part_no
            """,
            (int(year), int(month)),
        )
    )
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in booking_rows:
        machine_id = int(row["machine_id"])
        grouped.setdefault(machine_id, []).append(_serialize_booking(row, row["machine_no"]))
    return grouped


def _sum_reserved_hours(bookings: list[dict[str, Any]]) -> float:
    return round(sum(float(b.get("reserved_hours") or 0.0) for b in bookings), 2)


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

    # Bookings are always scoped to the calendar month; reserved % uses that capacity.
    if compact_text(capacity_basis) == "calendar_month":
        month_capacity_report = capacity_report
    else:
        month_capacity_report = build_group_capacity_report(
            con,
            year,
            month,
            capacity_basis="calendar_month",
            as_of=as_of_date,
        )
    capacity_hours_lookup = capacity_hours_by_machine_code(month_capacity_report)

    db_machines = {_machine_code(m): m for m in fetch_machines(con)}
    bookings_by_machine = fetch_bookings(con, year, month)
    # Legacy tags still returned for API compatibility; UI uses bookings.
    tags_by_machine = _fetch_part_tags(con)

    machines: list[dict[str, Any]] = []
    for layout in FLOOR_LAYOUT_MACHINES:
        machine_no = layout["machine_no"]
        db_row = db_machines.get(machine_no) or {}
        machine_id = int(db_row["machine_id"]) if db_row.get("machine_id") is not None else None
        bookings = bookings_by_machine.get(machine_id or -1, []) if machine_id else []
        reserved_hours = _sum_reserved_hours(bookings)
        effective_capacity_hours = float(capacity_hours_lookup.get(machine_no, 0.0))
        tags = tags_by_machine.get(machine_id or -1, []) if machine_id else []
        machines.append(
            {
                **layout,
                "machine_id": machine_id,
                "machine_category": compact_text(db_row.get("machine_category")),
                "shift_profile": compact_text(db_row.get("shift_profile")) or "STANDARD",
                "effective_utilization_pct": utilization_lookup.get(machine_no, 0.0),
                "effective_capacity_hours": effective_capacity_hours,
                "reserved_hours": reserved_hours,
                "reserved_pct": reserved_pct(reserved_hours, effective_capacity_hours),
                "bookings": bookings,
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


def _machine_effective_capacity_hours(
    con,
    *,
    machine_id: int,
    year: int,
    month: int,
    as_of: date | None = None,
) -> float:
    report = build_group_capacity_report(
        con,
        year,
        month,
        capacity_basis="calendar_month",
        as_of=as_of or date.today(),
    )
    for group in report.get("groups") or []:
        for machine in group.get("machines") or []:
            if int(machine.get("machine_id") or 0) == int(machine_id):
                return float(machine.get("effective_capacity_hours") or 0.0)
    return 0.0


def _other_reserved_hours(
    con,
    *,
    machine_id: int,
    year: int,
    month: int,
    exclude_part_no: str,
) -> float:
    row = one(
        con.execute(
            """
            SELECT COALESCE(SUM(reserved_hours), 0) AS total_hours
            FROM public.planner_machine_capacity_booking
            WHERE machine_id = %s
              AND planning_year = %s
              AND planning_month = %s
              AND part_no <> %s
            """,
            (machine_id, year, month, exclude_part_no),
        )
    )
    return float((row or {}).get("total_hours") or 0.0)


def upsert_machine_capacity_booking(
    con,
    *,
    machine_id: int,
    planning_year: int,
    planning_month: int,
    part_no: str,
    reserved_hours: Any,
    tag_label: str = "",
    notes: str = "",
    as_of: date | None = None,
) -> dict[str, Any]:
    ensure_floor_plan_tables(con)
    machine_id = int(machine_id)
    planning_year, planning_month = normalize_planning_month(planning_year, planning_month)
    part_no = _normalize_part_no(part_no)
    reserved_hours = normalize_reserved_hours(reserved_hours)
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
            INSERT INTO public.planner_machine_capacity_booking (
                machine_id, planning_year, planning_month, part_no,
                reserved_hours, tag_label, notes
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (machine_id, planning_year, planning_month, part_no)
            DO UPDATE SET
                reserved_hours = EXCLUDED.reserved_hours,
                tag_label = EXCLUDED.tag_label,
                notes = EXCLUDED.notes,
                updated_at = NOW()
            RETURNING
                booking_id, machine_id, planning_year, planning_month,
                part_no, reserved_hours, tag_label, notes, created_at, updated_at
            """,
            (
                machine_id,
                planning_year,
                planning_month,
                part_no,
                reserved_hours,
                tag_label,
                notes,
            ),
        )
    )

    other_hours = _other_reserved_hours(
        con,
        machine_id=machine_id,
        year=planning_year,
        month=planning_month,
        exclude_part_no=part_no,
    )
    total_reserved = round(other_hours + reserved_hours, 2)
    capacity_hours = _machine_effective_capacity_hours(
        con,
        machine_id=machine_id,
        year=planning_year,
        month=planning_month,
        as_of=as_of,
    )
    over_capacity = capacity_hours > 0 and total_reserved > capacity_hours
    warning = None
    if over_capacity:
        warning = (
            f"Reserved {total_reserved:g} h exceeds effective capacity "
            f"{capacity_hours:g} h for this machine/month."
        )

    booking = _serialize_booking(row, machine["machine_no"])
    booking["total_reserved_hours"] = total_reserved
    booking["effective_capacity_hours"] = capacity_hours
    booking["reserved_pct"] = reserved_pct(total_reserved, capacity_hours)
    booking["over_capacity"] = over_capacity
    booking["warning"] = warning
    return booking


def delete_machine_capacity_booking(con, booking_id: int) -> bool:
    ensure_floor_plan_tables(con)
    cur = con.execute(
        "DELETE FROM public.planner_machine_capacity_booking WHERE booking_id = %s RETURNING booking_id",
        (int(booking_id),),
    )
    return one(cur) is not None


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


FLOOR_LOW_UTIL_PCT = 40.0


def _cnc_number_from_machine_no(machine_no: str) -> int | None:
    digits = "".join(ch for ch in compact_text(machine_no) if ch.isdigit())
    if not digits:
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def compose_floor_current_jobs(
    blocks: list[dict[str, Any]],
    *,
    material_by_ps: dict[str, dict[str, Any]] | None = None,
    tooling_by_op: dict[int, bool] | None = None,
    program_by_op: dict[int, bool] | None = None,
    parts_by_ps: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """One current job per machine. Earlier rows win, so pass queue order."""
    material_by_ps = material_by_ps or {}
    tooling_by_op = tooling_by_op or {}
    program_by_op = program_by_op or {}
    parts_by_ps = parts_by_ps or {}
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in blocks or []:
        machine_no = compact_text(block.get("machine_no"))
        if not machine_no or machine_no.upper() in seen:
            continue
        cnc_number = _cnc_number_from_machine_no(machine_no)
        if cnc_number is None:
            continue
        seen.add(machine_no.upper())
        ps_id = compact_text(block.get("planner_ps_id"))
        process_sheet = compact_text(block.get("process_sheet")) or ps_id
        part_no = compact_text((parts_by_ps.get(ps_id) or {}).get("part_no"))
        operation_name = compact_text(block.get("operation_name"))
        op_no = compact_text(block.get("source_op_no"))
        if part_no and process_sheet and part_no.upper() != process_sheet.upper():
            label = part_no
            sub = process_sheet
        elif process_sheet:
            label = process_sheet
            sub = operation_name
        else:
            label = operation_name or "Job"
            sub = ""
        try:
            op_id = int(block.get("operation_id") or 0)
        except (TypeError, ValueError):
            op_id = 0
        overlay = material_by_ps.get(ps_id) or {}
        jobs.append(
            {
                "cnc_number": cnc_number,
                "machine_no": machine_no,
                "process_sheet": process_sheet,
                "part_no": part_no,
                "operation_name": operation_name,
                "op_no": op_no,
                "label": label,
                "sub": sub,
                "material_in": bool(overlay.get("material_in")),
                "tooling_ready": bool(tooling_by_op.get(op_id, True)) if op_id else True,
                "program_ready": bool(program_by_op.get(op_id, True)) if op_id else True,
                "queue_position": int(block.get("queue_position") or 0),
            }
        )
    return jobs


def _parts_for_planner_ps(con, planner_ps_ids: list[str]) -> dict[str, dict[str, str]]:
    ids = [compact_text(pid) for pid in planner_ps_ids if compact_text(pid)]
    if not ids:
        return {}

    def _load():
        return rows(
            con.execute(
                """
                SELECT planner_ps_id, inventory_code
                FROM public.planner_process_sheet
                WHERE planner_ps_id = ANY(%s)
                """,
                (ids,),
            )
        )

    from .helpers import planner_try_savepoint

    query_rows = planner_try_savepoint(con, "floor_job_parts", _load, default=[])
    out: dict[str, dict[str, str]] = {}
    for row in query_rows or []:
        pid = compact_text(row.get("planner_ps_id"))
        if not pid:
            continue
        out[pid] = {"part_no": compact_text(row.get("inventory_code"))}
    return out


def fetch_floor_current_jobs(con) -> dict[str, Any]:
    """First active queue block on each floor machine, with readiness flags."""
    from .blocks import attach_block_ps_identity, planner_ps_id_from_block_row
    from .helpers import planner_try_savepoint
    from .process_sheets import (
        material_in_overlay_for_planner_ps_ids,
        program_map_for_operation_ids,
        tooling_map_for_operation_ids,
    )
    from .shift_management_service import display_ps_id

    machine_nos = [str(item["machine_no"]).upper() for item in FLOOR_LAYOUT_MACHINES]
    data = rows(
        con.execute(
            """
            SELECT DISTINCT ON (b.machine_id)
                b.block_id,
                b.machine_id,
                b.queue_position,
                m.machine_no,
                o.operation_id,
                o.job_no,
                o.operation_name,
                o.source_ps_id,
                o.source_op_no
            FROM public.planner_run_block b
            JOIN public.planner_machines m ON m.machine_id = b.machine_id
            JOIN public.planner_operation o ON o.operation_id = b.operation_id
            WHERE b.active IS TRUE
              AND UPPER(BTRIM(m.machine_no)) = ANY(%s)
            ORDER BY b.machine_id, b.queue_position, b.block_id
            """,
            (machine_nos,),
        )
    )
    blocks: list[dict[str, Any]] = []
    for row in data:
        blocks.append(
            {
                "block_id": int(row["block_id"]),
                "machine_id": int(row["machine_id"]),
                "machine_no": compact_text(row.get("machine_no")),
                "queue_position": int(row.get("queue_position") or 0),
                "operation_id": int(row["operation_id"]) if row.get("operation_id") else None,
                "operation_name": compact_text(row.get("operation_name")),
                "source_op_no": compact_text(row.get("source_op_no")),
                "job_no": compact_text(row.get("job_no")),
                "source_ps_id": compact_text(row.get("source_ps_id")),
            }
        )

    def _attach():
        attach_block_ps_identity(con, blocks)
        return True

    planner_try_savepoint(con, "floor_job_ps", _attach, default=False)
    for block in blocks:
        block["planner_ps_id"] = planner_ps_id_from_block_row(block)
        block["process_sheet"] = block["planner_ps_id"] or display_ps_id(
            block.get("source_ps_id"),
            block.get("job_no"),
        )

    ps_ids = list(dict.fromkeys(
        compact_text(block.get("planner_ps_id"))
        for block in blocks
        if compact_text(block.get("planner_ps_id"))
    ))
    op_ids = [int(block["operation_id"]) for block in blocks if int(block.get("operation_id") or 0) > 0]
    jobs = compose_floor_current_jobs(
        blocks,
        material_by_ps=material_in_overlay_for_planner_ps_ids(con, ps_ids),
        tooling_by_op=tooling_map_for_operation_ids(con, op_ids),
        program_by_op=program_map_for_operation_ids(con, op_ids),
        parts_by_ps=_parts_for_planner_ps(con, ps_ids),
    )
    return {
        "ok": True,
        "low_utilisation_pct": FLOOR_LOW_UTIL_PCT,
        "jobs": jobs,
        "by_cnc": {str(job["cnc_number"]): job for job in jobs},
    }


def delete_machine_part_tag(con, tag_id: int) -> bool:
    ensure_floor_plan_tables(con)
    cur = con.execute(
        "DELETE FROM public.planner_machine_part_tag WHERE tag_id = %s RETURNING tag_id",
        (int(tag_id),),
    )
    return one(cur) is not None
