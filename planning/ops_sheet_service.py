"""Persist scanned OPS Sheet lines and the extra columns that feed TAT."""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime

from psycopg2.errors import UniqueViolation

from .helpers import one, planner_db, rows
from .ops_sheet_scan import (
    CYCLE_KEYS,
    DISPLAY_COLUMNS,
    compute_tat,
    infer_operations,
    iter_ops_sheet_files,
    ops_sheet_root,
    parse_ops_workbook,
    parse_qty,
)

logger = logging.getLogger(__name__)

APPLY_MODES = ("per_piece", "per_operation", "flat")
LINE_TEXT_LIMITS = {
    "part_number": 200,
    "description": 500,
    "rfq_qty_text": 120,
    "material_type": 240,
    "material_spec": 500,
    "fixture_required": 40,
    "engineering_remarks": 4000,
    "nre_text": 80,
}
LINE_NUMBER_FIELDS = (
    "raw_thk",
    "raw_width",
    "raw_length",
    "setup_mins",
    *CYCLE_KEYS,
)
_MINUTE_FIELDS = frozenset(("setup_mins", *CYCLE_KEYS))


class OpsSheetError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def ensure_ops_sheet_tables(con) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ops_sheet (
            sheet_id     BIGSERIAL PRIMARY KEY,
            source_path  TEXT NOT NULL UNIQUE,
            file_name    TEXT NOT NULL,
            rfq_folder   TEXT NOT NULL,
            status       TEXT NOT NULL,
            date_in      DATE,
            date_out     DATE,
            file_mtime   TIMESTAMPTZ,
            file_size    BIGINT,
            file_missing BOOLEAN NOT NULL DEFAULT FALSE,
            scanned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ops_sheet_line (
            line_id              BIGSERIAL PRIMARY KEY,
            sheet_id             BIGINT NOT NULL
                REFERENCES public.planner_ops_sheet(sheet_id) ON DELETE CASCADE,
            row_index            INTEGER NOT NULL,
            part_number          TEXT,
            description          TEXT,
            rfq_qty_text         TEXT,
            rfq_qty              DOUBLE PRECISION,
            qty_breaks           TEXT NOT NULL DEFAULT '[]',
            material_type        TEXT,
            material_spec        TEXT,
            raw_thk              DOUBLE PRECISION,
            raw_width            DOUBLE PRECISION,
            raw_length           DOUBLE PRECISION,
            setup_mins           DOUBLE PRECISION,
            mill_3axis           DOUBLE PRECISION,
            mill_4axis           DOUBLE PRECISION,
            mill_5axis           DOUBLE PRECISION,
            mill_5axis_i800      DOUBLE PRECISION,
            turn_quick           DOUBLE PRECISION,
            turn_j200            DOUBLE PRECISION,
            turn_i250            DOUBLE PRECISION,
            edm_wirecut          DOUBLE PRECISION,
            edm                  DOUBLE PRECISION,
            edm_superdrill       DOUBLE PRECISION,
            backend_deburr       DOUBLE PRECISION,
            backend_cleaning     DOUBLE PRECISION,
            fixture_required     TEXT,
            engineering_remarks  TEXT,
            nre_text             TEXT,
            ops_auto             INTEGER NOT NULL DEFAULT 0,
            ops_basis            TEXT NOT NULL DEFAULT 'cycles',
            ops_override         INTEGER,
            UNIQUE (sheet_id, row_index)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ops_extra_column (
            column_id   BIGSERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            apply_mode  TEXT NOT NULL DEFAULT 'per_piece',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT planner_ops_extra_column_mode
                CHECK (apply_mode IN ('per_piece', 'per_operation', 'flat'))
        )
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_ops_extra_column_name
            ON public.planner_ops_extra_column (LOWER(name))
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ops_extra_value (
            line_id   BIGINT NOT NULL
                REFERENCES public.planner_ops_sheet_line(line_id) ON DELETE CASCADE,
            column_id BIGINT NOT NULL
                REFERENCES public.planner_ops_extra_column(column_id) ON DELETE CASCADE,
            minutes   DOUBLE PRECISION,
            PRIMARY KEY (line_id, column_id)
        )
        """
    )


def list_ops_sheets() -> dict:
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        return _payload(con)


def scan_ops_sheets() -> dict:
    root = ops_sheet_root()
    if not os.path.isdir(root):
        raise OpsSheetError(f"RFQ folder was not found: {root}", 404)
    parsed = []
    errors = []
    files = list(iter_ops_sheet_files(root))
    for path in files:
        try:
            parsed.append(parse_ops_workbook(path, root))
        except Exception as exc:
            logger.exception("OPS sheet parse failed for %s", path)
            errors.append({"file": os.path.basename(path), "path": path, "error": str(exc)})
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        seen = set()
        for item in parsed:
            _upsert_sheet(con, item)
            seen.add(os.path.normcase(item["source_path"]))
        failed = {os.path.normcase(item["path"]) for item in errors}
        _mark_missing(con, root, seen, failed)
        payload = _payload(con)
    payload["summary"] = {
        "files": len(files),
        "saved": len(parsed),
        "lines": sum(len(item["lines"]) for item in parsed),
        "empty": sum(1 for item in parsed if not item["lines"]),
        "errors": [{"file": item["file"], "error": item["error"]} for item in errors],
    }
    return payload


def prepare_line_update(fields) -> dict:
    """Validate an edit before it is written. Raises OpsSheetError for a bad field."""
    if not isinstance(fields, dict) or not fields:
        raise OpsSheetError("Choose a field to save.")
    allowed = set(LINE_TEXT_LIMITS) | set(LINE_NUMBER_FIELDS)
    if any(key not in allowed for key in fields):
        raise OpsSheetError("That column cannot be edited.")
    prepared = {}
    for key, limit in LINE_TEXT_LIMITS.items():
        if key not in fields:
            continue
        raw = fields.get(key)
        if key == "engineering_remarks":
            text = str(raw or "").replace("\r\n", "\n").strip()
        else:
            text = " ".join(str(raw or "").split())
        if len(text) > limit:
            raise OpsSheetError("That value is too long.")
        prepared[key] = text
    for key in LINE_NUMBER_FIELDS:
        if key not in fields:
            continue
        prepared[key] = _edit_number(key, fields.get(key))
    if "rfq_qty_text" in prepared:
        primary, breaks, text = parse_qty(prepared["rfq_qty_text"])
        prepared["rfq_qty_text"] = text
        prepared["rfq_qty"] = primary
        prepared["qty_breaks"] = breaks
    return prepared


def update_line_fields(line_id: int, fields) -> dict:
    prepared = prepare_line_update(fields)
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        current = one(con.execute(
            "SELECT * FROM public.planner_ops_sheet_line WHERE line_id = %s",
            (line_id,),
        ))
        if not current:
            raise OpsSheetError("That part line was not found.", 404)
        ops_auto, ops_basis = infer_operations(
            prepared.get("engineering_remarks", current.get("engineering_remarks")),
            [
                prepared[key] if key in prepared else current.get(key)
                for key in CYCLE_KEYS
            ],
        )
        assignments = []
        params = []
        for key, value in prepared.items():
            assignments.append(f"{key} = %s")
            params.append(json.dumps(value) if key == "qty_breaks" else value)
        assignments.append("ops_auto = %s")
        assignments.append("ops_basis = %s")
        params.extend([ops_auto, ops_basis, line_id])
        con.execute(
            f"""
            UPDATE public.planner_ops_sheet_line
               SET {", ".join(assignments)}
             WHERE line_id = %s
            """,
            tuple(params),
        )
        return {"ok": True, "line": _one_line(con, line_id)}


def rename_ops_file(sheet_id: int, file_name: str) -> dict:
    cleaned = " ".join(str(file_name or "").split())
    if not cleaned:
        raise OpsSheetError("RFQ file name is required.")
    if len(cleaned) > 240:
        raise OpsSheetError("RFQ file name is too long.")
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        updated = one(con.execute(
            """
            UPDATE public.planner_ops_sheet
               SET file_name = %s
             WHERE sheet_id = %s
            RETURNING sheet_id
            """,
            (cleaned, sheet_id),
        ))
        if not updated:
            raise OpsSheetError("That RFQ file was not found.", 404)
    return {"ok": True, "sheet_id": int(sheet_id), "file_name": cleaned}


def set_operation_count(line_id: int, operation_count):
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        existing = one(con.execute(
            "SELECT line_id FROM public.planner_ops_sheet_line WHERE line_id = %s",
            (line_id,),
        ))
        if not existing:
            raise OpsSheetError("That part line was not found.", 404)
        con.execute(
            """
            UPDATE public.planner_ops_sheet_line
               SET ops_override = %s
             WHERE line_id = %s
            """,
            (operation_count, line_id),
        )
        return {"ok": True, "line": _one_line(con, line_id)}


def set_extra_minutes(line_id: int, column_id: int, minutes):
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        line = one(con.execute(
            "SELECT line_id FROM public.planner_ops_sheet_line WHERE line_id = %s",
            (line_id,),
        ))
        column = one(con.execute(
            "SELECT column_id FROM public.planner_ops_extra_column WHERE column_id = %s",
            (column_id,),
        ))
        if not line or not column:
            raise OpsSheetError("That column or part line was not found.", 404)
        if minutes is None:
            con.execute(
                """
                DELETE FROM public.planner_ops_extra_value
                 WHERE line_id = %s AND column_id = %s
                """,
                (line_id, column_id),
            )
        else:
            con.execute(
                """
                INSERT INTO public.planner_ops_extra_value (line_id, column_id, minutes)
                VALUES (%s, %s, %s)
                ON CONFLICT (line_id, column_id) DO UPDATE SET minutes = EXCLUDED.minutes
                """,
                (line_id, column_id, minutes),
            )
        return {"ok": True, "line": _one_line(con, line_id)}


def add_extra_column(name: str, apply_mode: str) -> dict:
    cleaned = " ".join((name or "").split())
    if not cleaned:
        raise OpsSheetError("Column name is required.")
    if len(cleaned) > 48:
        raise OpsSheetError("Column name cannot exceed 48 characters.")
    if apply_mode not in APPLY_MODES:
        raise OpsSheetError("Choose how the column is added into TAT.")
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        current = one(con.execute(
            "SELECT COALESCE(MAX(sort_order), 0) AS sort_order FROM public.planner_ops_extra_column"
        ))
        sort_order = int(current["sort_order"] or 0) + 1
        try:
            one(con.execute(
                """
                INSERT INTO public.planner_ops_extra_column (name, apply_mode, sort_order)
                VALUES (%s, %s, %s)
                RETURNING column_id
                """,
                (cleaned, apply_mode, sort_order),
            ))
        except UniqueViolation:
            raise OpsSheetError("A column with that name already exists.") from None
        return _payload(con)


def update_extra_column(column_id: int, name: str | None, apply_mode: str | None) -> dict:
    if apply_mode is not None and apply_mode not in APPLY_MODES:
        raise OpsSheetError("Choose how the column is added into TAT.")
    cleaned = None
    if name is not None:
        cleaned = " ".join(name.split())
        if not cleaned:
            raise OpsSheetError("Column name is required.")
        if len(cleaned) > 48:
            raise OpsSheetError("Column name cannot exceed 48 characters.")
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        existing = one(con.execute(
            "SELECT column_id FROM public.planner_ops_extra_column WHERE column_id = %s",
            (column_id,),
        ))
        if not existing:
            raise OpsSheetError("That column was not found.", 404)
        try:
            if cleaned is not None and apply_mode is not None:
                con.execute(
                    """
                    UPDATE public.planner_ops_extra_column
                       SET name = %s, apply_mode = %s
                     WHERE column_id = %s
                    """,
                    (cleaned, apply_mode, column_id),
                )
            elif cleaned is not None:
                con.execute(
                    "UPDATE public.planner_ops_extra_column SET name = %s WHERE column_id = %s",
                    (cleaned, column_id),
                )
            elif apply_mode is not None:
                con.execute(
                    "UPDATE public.planner_ops_extra_column SET apply_mode = %s WHERE column_id = %s",
                    (apply_mode, column_id),
                )
        except UniqueViolation:
            raise OpsSheetError("A column with that name already exists.") from None
        return _payload(con)


def delete_extra_column(column_id: int) -> dict:
    with planner_db() as con:
        ensure_ops_sheet_tables(con)
        deleted = one(con.execute(
            """
            DELETE FROM public.planner_ops_extra_column
             WHERE column_id = %s
            RETURNING column_id
            """,
            (column_id,),
        ))
        if not deleted:
            raise OpsSheetError("That column was not found.", 404)
        return _payload(con)


def _upsert_sheet(con, item: dict) -> None:
    sheet = one(con.execute(
        """
        INSERT INTO public.planner_ops_sheet (
            source_path, file_name, rfq_folder, status, date_in, date_out,
            file_mtime, file_size, file_missing, scanned_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, FALSE, NOW())
        ON CONFLICT (source_path) DO UPDATE SET
            file_name = EXCLUDED.file_name,
            rfq_folder = EXCLUDED.rfq_folder,
            status = EXCLUDED.status,
            date_in = EXCLUDED.date_in,
            date_out = EXCLUDED.date_out,
            file_mtime = EXCLUDED.file_mtime,
            file_size = EXCLUDED.file_size,
            file_missing = FALSE,
            scanned_at = NOW()
        RETURNING sheet_id
        """,
        (
            item["source_path"],
            item["file_name"],
            item["rfq_folder"],
            item["status"],
            item["date_in"],
            item["date_out"],
            item["file_mtime"],
            item["file_size"],
        ),
    ))
    sheet_id = sheet["sheet_id"]
    old_lines = rows(con.execute(
        """
        SELECT line_id, row_index, part_number, ops_override
          FROM public.planner_ops_sheet_line
         WHERE sheet_id = %s
        """,
        (sheet_id,),
    ))
    old_ids = [line["line_id"] for line in old_lines]
    old_extras = []
    if old_ids:
        old_extras = rows(con.execute(
            """
            SELECT line_id, column_id, minutes
              FROM public.planner_ops_extra_value
             WHERE line_id = ANY(%s)
            """,
            (old_ids,),
        ))
    extras_by_row = {}
    row_by_id = {line["line_id"]: line for line in old_lines}
    for extra in old_extras:
        source = row_by_id.get(extra["line_id"])
        if not source:
            continue
        extras_by_row.setdefault(source["row_index"], []).append(extra)
    old_by_row = {line["row_index"]: line for line in old_lines}
    con.execute(
        "DELETE FROM public.planner_ops_sheet_line WHERE sheet_id = %s",
        (sheet_id,),
    )
    for line in item["lines"]:
        inserted = one(con.execute(
            """
            INSERT INTO public.planner_ops_sheet_line (
                sheet_id, row_index, part_number, description, rfq_qty_text, rfq_qty, qty_breaks,
                material_type, material_spec, raw_thk, raw_width, raw_length, setup_mins,
                mill_3axis, mill_4axis, mill_5axis, mill_5axis_i800,
                turn_quick, turn_j200, turn_i250,
                edm_wirecut, edm, edm_superdrill,
                backend_deburr, backend_cleaning,
                fixture_required, engineering_remarks, nre_text, ops_auto, ops_basis
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s, %s, %s, %s
            )
            RETURNING line_id
            """,
            (
                sheet_id,
                line["row_index"],
                line["part_number"],
                line["description"],
                line["rfq_qty_text"],
                line["rfq_qty"],
                json.dumps(line["qty_breaks"]),
                line["material_type"],
                line["material_spec"],
                line["raw_thk"],
                line["raw_width"],
                line["raw_length"],
                line["setup_mins"],
                line["mill_3axis"],
                line["mill_4axis"],
                line["mill_5axis"],
                line["mill_5axis_i800"],
                line["turn_quick"],
                line["turn_j200"],
                line["turn_i250"],
                line["edm_wirecut"],
                line["edm"],
                line["edm_superdrill"],
                line["backend_deburr"],
                line["backend_cleaning"],
                line["fixture_required"],
                line["engineering_remarks"],
                line["nre_text"],
                line["ops_auto"],
                line["ops_basis"],
            ),
        ))
        previous = old_by_row.get(line["row_index"])
        same_part = previous and _same_text(previous.get("part_number"), line["part_number"])
        if same_part and previous.get("ops_override") is not None:
            con.execute(
                """
                UPDATE public.planner_ops_sheet_line
                   SET ops_override = %s
                 WHERE line_id = %s
                """,
                (previous["ops_override"], inserted["line_id"]),
            )
        if same_part:
            for extra in extras_by_row.get(line["row_index"], []):
                con.execute(
                    """
                    INSERT INTO public.planner_ops_extra_value (line_id, column_id, minutes)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (line_id, column_id) DO UPDATE SET minutes = EXCLUDED.minutes
                    """,
                    (inserted["line_id"], extra["column_id"], extra["minutes"]),
                )


def _mark_missing(con, root: str, seen: set[str], failed: set[str]) -> None:
    known = rows(con.execute(
        "SELECT sheet_id, source_path FROM public.planner_ops_sheet"
    ))
    missing_ids = []
    root_key = os.path.normcase(os.path.normpath(root))
    for sheet in known:
        path = os.path.normpath(sheet["source_path"])
        if not _under_root(path, root_key):
            continue
        key = os.path.normcase(path)
        if key in seen or key in failed:
            continue
        missing_ids.append(sheet["sheet_id"])
    if missing_ids:
        con.execute(
            """
            UPDATE public.planner_ops_sheet
               SET file_missing = TRUE
             WHERE sheet_id = ANY(%s)
            """,
            (missing_ids,),
        )


def _payload(con) -> dict:
    extra_columns = [
        {
            "column_id": int(column["column_id"]),
            "name": column["name"],
            "apply_mode": column["apply_mode"],
            "sort_order": int(column["sort_order"] or 0),
        }
        for column in rows(con.execute(
            """
            SELECT column_id, name, apply_mode, sort_order
              FROM public.planner_ops_extra_column
             ORDER BY sort_order, column_id
            """
        ))
    ]
    line_rows = rows(con.execute(
        """
        SELECT l.*,
               s.rfq_folder, s.file_name, s.status, s.date_in, s.date_out,
               s.source_path, s.file_missing, s.scanned_at
          FROM public.planner_ops_sheet_line l
          JOIN public.planner_ops_sheet s ON s.sheet_id = l.sheet_id
         ORDER BY s.rfq_folder, s.file_name, l.row_index
        """
    ))
    extras = rows(con.execute(
        "SELECT line_id, column_id, minutes FROM public.planner_ops_extra_value"
    ))
    extras_by_line = {}
    for extra in extras:
        extras_by_line.setdefault(int(extra["line_id"]), {})[int(extra["column_id"])] = extra["minutes"]
    scanned_at = one(con.execute(
        "SELECT MAX(scanned_at) AS scanned_at FROM public.planner_ops_sheet"
    ))
    sheet_counts = one(con.execute(
        """
        SELECT COUNT(*) AS sheets,
               COUNT(*) FILTER (WHERE file_missing) AS missing
          FROM public.planner_ops_sheet
        """
    ))
    return {
        "ok": True,
        "database": "supabase",
        "root": ops_sheet_root(),
        "columns": [dict(column) for column in DISPLAY_COLUMNS],
        "extra_columns": extra_columns,
        "lines": [
            _public_line(line, extra_columns, extras_by_line.get(int(line["line_id"]), {}))
            for line in line_rows
        ],
        "sheet_count": int(sheet_counts["sheets"] or 0) if sheet_counts else 0,
        "missing_count": int(sheet_counts["missing"] or 0) if sheet_counts else 0,
        "scanned_at": _iso(scanned_at["scanned_at"]) if scanned_at else None,
    }


def _one_line(con, line_id: int) -> dict:
    line = one(con.execute(
        """
        SELECT l.*,
               s.rfq_folder, s.file_name, s.status, s.date_in, s.date_out,
               s.source_path, s.file_missing, s.scanned_at
          FROM public.planner_ops_sheet_line l
          JOIN public.planner_ops_sheet s ON s.sheet_id = l.sheet_id
         WHERE l.line_id = %s
        """,
        (line_id,),
    ))
    columns = rows(con.execute(
        """
        SELECT column_id, name, apply_mode, sort_order
          FROM public.planner_ops_extra_column
         ORDER BY sort_order, column_id
        """
    ))
    values = rows(con.execute(
        """
        SELECT column_id, minutes
          FROM public.planner_ops_extra_value
         WHERE line_id = %s
        """,
        (line_id,),
    ))
    extra_values = {int(item["column_id"]): item["minutes"] for item in values}
    public_columns = [
        {
            "column_id": int(column["column_id"]),
            "name": column["name"],
            "apply_mode": column["apply_mode"],
        }
        for column in columns
    ]
    return _public_line(line, public_columns, extra_values)


def _public_line(line: dict, extra_columns, extra_values) -> dict:
    stored = dict(line)
    stored["qty_breaks"] = _load_breaks(line.get("qty_breaks"))
    stored["ops_override"] = line.get("ops_override")
    tat = compute_tat(stored, extra_columns, extra_values)
    payload = {
        "line_id": int(line["line_id"]),
        "sheet_id": int(line["sheet_id"]),
        "row_index": int(line["row_index"]),
        "rfq_folder": line.get("rfq_folder") or "",
        "file_name": line.get("file_name") or "",
        "status": line.get("status") or "",
        "date_in": _iso_date(line.get("date_in")),
        "date_out": _iso_date(line.get("date_out")),
        "source_path": line.get("source_path") or "",
        "file_missing": bool(line.get("file_missing")),
        "part_number": line.get("part_number") or "",
        "description": line.get("description") or "",
        "rfq_qty_text": line.get("rfq_qty_text") or "",
        "rfq_qty": line.get("rfq_qty"),
        "qty_breaks": stored["qty_breaks"],
        "material_type": line.get("material_type") or "",
        "material_spec": line.get("material_spec") or "",
        "raw_thk": line.get("raw_thk"),
        "raw_width": line.get("raw_width"),
        "raw_length": line.get("raw_length"),
        "setup_mins": line.get("setup_mins"),
        "mill_3axis": line.get("mill_3axis"),
        "mill_4axis": line.get("mill_4axis"),
        "mill_5axis": line.get("mill_5axis"),
        "mill_5axis_i800": line.get("mill_5axis_i800"),
        "turn_quick": line.get("turn_quick"),
        "turn_j200": line.get("turn_j200"),
        "turn_i250": line.get("turn_i250"),
        "edm_wirecut": line.get("edm_wirecut"),
        "edm": line.get("edm"),
        "edm_superdrill": line.get("edm_superdrill"),
        "backend_deburr": line.get("backend_deburr"),
        "backend_cleaning": line.get("backend_cleaning"),
        "fixture_required": line.get("fixture_required") or "",
        "engineering_remarks": line.get("engineering_remarks") or "",
        "nre_text": line.get("nre_text") or "",
        "ops_auto": int(line.get("ops_auto") or 0),
        "ops_basis": line.get("ops_basis") or "cycles",
        "ops_override": line.get("ops_override"),
        "ops_effective": tat["ops_effective"],
        "ops_source": tat["ops_source"],
        "cycle_sum": tat["cycle_sum"],
        "tat": tat["breaks"],
        "extras": {
            str(column_id): minutes
            for column_id, minutes in extra_values.items()
            if minutes is not None
        },
    }
    return payload


def _edit_number(key, value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise OpsSheetError("Enter a number.") from None
    if number != number or number in {float("inf"), float("-inf")}:
        raise OpsSheetError("Enter a number.")
    if key in _MINUTE_FIELDS and number < 0:
        raise OpsSheetError("Minutes cannot be negative.")
    if abs(number) > 1_000_000:
        raise OpsSheetError("That number is too large.")
    return number


def _load_breaks(value):
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _under_root(path: str, root_key: str) -> bool:
    try:
        common = os.path.commonpath([os.path.normpath(path), root_key])
    except ValueError:
        return False
    return os.path.normcase(common) == root_key


def _same_text(left, right) -> bool:
    return str(left or "").strip().casefold() == str(right or "").strip().casefold()


def _iso_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    return text[:10] if text else None


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)
