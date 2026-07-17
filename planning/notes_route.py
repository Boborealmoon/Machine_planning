"""Standalone planner notes linked to one or more process sheets."""
from __future__ import annotations

import os

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for

from .helpers import one, planner_db, rows
from .process_sheets import (
    ensure_planner_process_sheet,
    format_planner_ps_id,
    normalize_standard_ps_id,
    parse_planner_ps_id,
    search_process_sheet_sources,
)
from .utils import compact_text


notes_bp = Blueprint("planner_notes", __name__)
_MAX_NOTE_LENGTH = 10_000
_MAX_TAGS = 20


def _ensure_notes_tables(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_note (
            note_id      BIGSERIAL    PRIMARY KEY,
            body         TEXT         NOT NULL CHECK (LENGTH(BTRIM(body)) > 0),
            created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_note_process_sheet (
            note_id        BIGINT  NOT NULL
                REFERENCES public.planner_note(note_id) ON DELETE CASCADE,
            planner_ps_id  TEXT    NOT NULL
                REFERENCES public.planner_process_sheet(planner_ps_id) ON DELETE CASCADE,
            PRIMARY KEY (note_id, planner_ps_id)
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_note_created_at
            ON public.planner_note (created_at DESC)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_note_process_sheet_ps
            ON public.planner_note_process_sheet (planner_ps_id)
        """
    )


@notes_bp.before_request
def _protect_notes_api():
    """The app's general gate exempts /api/*, so protect note data here."""
    if (
        request.path.startswith("/api/notes")
        and (os.getenv("PLANNER_PASSCODE") or "").strip()
        and session.get("planner_access_ok") is not True
    ):
        return jsonify({"error": "Planner access locked."}), 401
    return None


def _canonical_tag_id(raw):
    if isinstance(raw, str):
        planner_ps_id = compact_text(raw)
    elif isinstance(raw, dict):
        planner_ps_id = compact_text(
            raw.get("planner_ps_id") or raw.get("ps_id") or raw.get("source_ps_id")
        )
        if planner_ps_id and "::" not in planner_ps_id:
            planner_ps_id = format_planner_ps_id(
                planner_ps_id, raw.get("pp_partial_no") or raw.get("partial_no") or 1
            )
    else:
        return ""
    source_ps_id, partial_no = parse_planner_ps_id(planner_ps_id)
    return format_planner_ps_id(normalize_standard_ps_id(source_ps_id), partial_no)


def _notes_payload(con, note_id=None, limit=100):
    params = ()
    where = ""
    if note_id is not None:
        where = "WHERE n.note_id = %s"
        params = (note_id,)
    else:
        limit = max(1, min(int(limit or 100), 250))
        params = (limit,)

    note_rows = rows(
        con.execute(
            f"""
            SELECT n.note_id, n.body, n.created_at, n.updated_at
            FROM planner_note n
            {where}
            ORDER BY n.created_at DESC, n.note_id DESC
            {"LIMIT %s" if note_id is None else ""}
            """,
            params,
        )
    )
    if not note_rows:
        return []

    note_ids = [row["note_id"] for row in note_rows]
    tag_rows = rows(
        con.execute(
            """
            SELECT t.note_id, t.planner_ps_id, ps.source_ps_id, ps.pp_partial_no,
                   ps.inventory_code,
                   COALESCE(v.part_no, ps.inventory_code, '') AS part_no,
                   COALESCE(v.description, '') AS part_desc,
                   v.due_date,
                   COALESCE(NULLIF(v.partial_qty, 0), v.total_qty, 0) AS display_qty
            FROM planner_note_process_sheet t
            JOIN planner_process_sheet ps ON ps.planner_ps_id = t.planner_ps_id
            LEFT JOIN LATERAL (
                SELECT MAX(part_no) AS part_no,
                       MAX(description) AS description,
                       MIN(due_date) AS due_date,
                       MAX(partial_qty) AS partial_qty,
                       MAX(total_qty) AS total_qty
                FROM pp_vouchers_cache
                WHERE UPPER(ps_id) = UPPER(ps.source_ps_id)
                  AND pp_partial_no = ps.pp_partial_no
            ) v ON TRUE
            WHERE t.note_id = ANY(%s)
            ORDER BY t.note_id, t.planner_ps_id
            """,
            (note_ids,),
        )
    )
    tags_by_note = {}
    for tag in tag_rows:
        tags_by_note.setdefault(tag["note_id"], []).append(tag)
    for note in note_rows:
        note["process_sheets"] = tags_by_note.get(note["note_id"], [])
    return note_rows


@notes_bp.get("/admin")
def notes_page():
    return render_template("notes.html")


@notes_bp.get("/notes")
def notes_legacy_redirect():
    return redirect(url_for("planner_notes.notes_page"), code=308)


@notes_bp.get("/api/notes")
def api_list_notes():
    try:
        limit = int(request.args.get("limit") or 100)
    except (TypeError, ValueError):
        limit = 100
    try:
        with planner_db() as con:
            _ensure_notes_tables(con)
            return jsonify({"notes": _notes_payload(con, limit=limit)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@notes_bp.post("/api/notes")
def api_create_note():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required."}), 400

    body = compact_text(data.get("body"))
    if not body:
        return jsonify({"error": "Note text is required."}), 400
    if len(body) > _MAX_NOTE_LENGTH:
        return jsonify({"error": f"Note text cannot exceed {_MAX_NOTE_LENGTH} characters."}), 400

    raw_tags = data.get("process_sheets") or []
    if not isinstance(raw_tags, list):
        return jsonify({"error": "process_sheets must be a list."}), 400
    canonical_ids = []
    for raw_tag in raw_tags:
        canonical_id = _canonical_tag_id(raw_tag)
        if canonical_id and canonical_id.casefold() not in {
            value.casefold() for value in canonical_ids
        }:
            canonical_ids.append(canonical_id)
    if len(canonical_ids) > _MAX_TAGS:
        return jsonify({"error": f"A note can tag at most {_MAX_TAGS} process sheets."}), 400

    try:
        with planner_db() as con:
            _ensure_notes_tables(con)
            materialized_ids = []
            for planner_ps_id in canonical_ids:
                ps = ensure_planner_process_sheet(con, planner_ps_id)
                if not ps:
                    raise ValueError(f"Process sheet {planner_ps_id} was not found.")
                materialized_ids.append(compact_text(ps.get("planner_ps_id")) or planner_ps_id)

            note = one(
                con.execute(
                    """
                    INSERT INTO planner_note (body)
                    VALUES (%s)
                    RETURNING note_id
                    """,
                    (body,),
                )
            )
            note_id = note["note_id"]
            if materialized_ids:
                con.executemany(
                    """
                    INSERT INTO planner_note_process_sheet (note_id, planner_ps_id)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    [(note_id, planner_ps_id) for planner_ps_id in materialized_ids],
                )
            return jsonify({"note": _notes_payload(con, note_id=note_id)[0]}), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@notes_bp.get("/api/notes/process-sheets/search")
def api_notes_process_sheet_search():
    query = compact_text(request.args.get("q") or request.args.get("search"))
    if not query:
        return jsonify({"items": []})
    try:
        limit = max(1, min(int(request.args.get("limit") or 20), 30))
    except (TypeError, ValueError):
        limit = 20
    try:
        with planner_db() as con:
            items = search_process_sheet_sources(con, query, limit=limit)
        for item in items:
            item["planner_ps_id"] = format_planner_ps_id(
                normalize_standard_ps_id(item.get("ps_id")),
                item.get("pp_partial_no") or 1,
            )
            item["part_desc"] = compact_text(item.get("description"))
        return jsonify({"items": items})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
