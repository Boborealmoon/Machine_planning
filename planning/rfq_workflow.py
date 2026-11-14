"""Organise onboarded OPS sheets into one shared RFQ record per file.

Ops, Supply Chain and Planning each write their own columns. Status is
derived in rfq_status and is never stored. The Excel folder is only the
onboard path; the rows live in Supabase.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

from .helpers import one, planner_db, rows
from .ops_sheet_scan import CYCLE_KEYS, compute_tat, infer_operations
from .rfq_status import line_status, rfq_status

TEAMS = {
    "ops": "Operations",
    "supply_chain": "Supply Chain",
    "planning": "Planning",
    "sales": "Sales",
}
QUOTE_STATES = ("not_sent", "rfq_sent", "quoted")
QUOTE_STATE_LABELS = {
    "not_sent": "Not sent",
    "rfq_sent": "RFQ sent",
    "quoted": "Quoted",
}
MACHINE_FIELDS = (
    ("mill_3axis", "3 Axis"),
    ("mill_4axis", "4 Axis"),
    ("mill_5axis", "5 Axis"),
    ("mill_5axis_i800", "5 Axis (i-800)"),
    ("turn_quick", "Quick Turn"),
    ("turn_j200", "J-200"),
    ("turn_i250", "i-250"),
    ("edm_wirecut", "Wirecut"),
    ("edm", "EDM"),
    ("edm_superdrill", "Superdrill"),
    ("backend_deburr", "Deburring"),
    ("backend_cleaning", "Cleaning"),
)
_MACHINE_BY_LABEL = {label.casefold(): key for key, label in MACHINE_FIELDS}
OPS_COMPARE = (
    "part_number",
    "description",
    "rfq_qty_text",
    "material_type",
    "material_spec",
    "raw_thk",
    "raw_width",
    "raw_length",
    "setup_mins",
    *CYCLE_KEYS,
    "fixture_required",
    "engineering_remarks",
    "nre_text",
)
_REFER_SN = re.compile(r"refer\s+to\s+s\s*/?\s*n\s*\.?\s*(\d+)", re.IGNORECASE)
_SEED_PATH = Path(__file__).resolve().parent / "data" / "seed_RFQ00006.json"
_SEED_SOURCE = "rfq-seed://RFQ00006"


class RfqWorkflowError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def derive_rfq_identity(folder: str, file_name: str, sheet_id: int) -> tuple[str, str, str]:
    """Turn an onboarded file path into an RFQ number, customer and title."""
    folder = (folder or "").strip()
    file_name = (file_name or "").strip()
    numbered = re.search(r"RFQ[_\s-]*(\d{4,})", f"{folder} {file_name}", re.IGNORECASE)
    if numbered:
        rfq_no = "RFQ" + numbered.group(1)
    else:
        slug = re.sub(r"[^A-Za-z0-9]+", "-", folder or f"sheet-{sheet_id}").strip("-")
        slug = re.sub(r"(?i)(?:^|-)RFQ(?=-|$)", "-", slug)
        slug = re.sub(r"-{2,}", "-", slug).strip("-") or slug
        rfq_no = "RFQ-" + slug if slug else f"RFQ-{sheet_id}"
    dated = re.match(r"^(\d{8})_(.+)$", folder)
    customer = dated.group(2).strip() if dated else folder
    if customer.casefold() in {"", "rfq current"}:
        customer = re.sub(r"(?i)^ops sheet(?:\s+rev\s*\d+)?", "", file_name)
        customer = re.sub(r"(?i)\.xlsx$", "", customer).strip(" -_()")
    customer = customer or file_name or f"RFQ {sheet_id}"
    return rfq_no[:80], customer[:200], customer[:200]


def tat_unlocked(quote) -> bool:
    """Planning can enter TAT only after a quoted supplier lead time exists."""
    if not quote or quote.get("state") != "quoted":
        return False
    return quote.get("lead_time_weeks") is not None


def require_team(team: str, allowed: tuple[str, ...]) -> str:
    if team not in TEAMS:
        raise RfqWorkflowError("Choose a team.")
    if team not in allowed:
        raise RfqWorkflowError(f"{TEAMS[team]} cannot edit those columns.", 403)
    return team


def ensure_rfq_workflow(con) -> None:
    con.execute(
        """
        ALTER TABLE public.planner_ops_sheet
            ADD COLUMN IF NOT EXISTS rfq_no TEXT,
            ADD COLUMN IF NOT EXISTS customer TEXT,
            ADD COLUMN IF NOT EXISTS title TEXT,
            ADD COLUMN IF NOT EXISTS ops_rev INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ops_sheet_line
            ADD COLUMN IF NOT EXISTS rev INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS quote_ref_line_id BIGINT
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_ops_sheet_rfq_no
            ON public.planner_ops_sheet (rfq_no)
         WHERE rfq_no IS NOT NULL AND rfq_no <> ''
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_rfq_quote (
            line_id            BIGINT PRIMARY KEY
                REFERENCES public.planner_ops_sheet_line(line_id) ON DELETE CASCADE,
            state              TEXT NOT NULL DEFAULT 'not_sent',
            supplier           TEXT,
            qty_needed_mtr     DOUBLE PRECISION,
            kg_per_mtr         DOUBLE PRECISION,
            material_cost_sgd  DOUBLE PRECISION,
            lead_time_weeks    DOUBLE PRECISION,
            supplier_note      TEXT,
            spec_code          TEXT,
            confirmed_rev      INTEGER NOT NULL DEFAULT 1,
            updated_by         TEXT,
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT planner_rfq_quote_state
                CHECK (state IN ('not_sent', 'rfq_sent', 'quoted'))
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_rfq_tat (
            line_id        BIGINT PRIMARY KEY
                REFERENCES public.planner_ops_sheet_line(line_id) ON DELETE CASCADE,
            tat_days       DOUBLE PRECISION,
            confirmed_rev  INTEGER NOT NULL DEFAULT 1,
            updated_by     TEXT,
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_rfq_audit (
            audit_id   BIGSERIAL PRIMARY KEY,
            sheet_id   BIGINT,
            line_id    BIGINT,
            actor      TEXT,
            team       TEXT,
            field      TEXT,
            old_value  TEXT,
            new_value  TEXT,
            at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def finish_library(con) -> None:
    """Backfill RFQ names and repeat-part links. Safe to run on every load."""
    ensure_rfq_workflow(con)
    import_seed_rfq(con)
    fill_identity(con)
    sheet_ids = rows(con.execute("SELECT sheet_id FROM public.planner_ops_sheet"))
    for sheet in sheet_ids:
        link_repeats(con, int(sheet["sheet_id"]))


def library_payload(team: str) -> dict:
    if team not in TEAMS:
        team = "ops"
    with planner_db() as con:
        from .ops_sheet_service import ensure_ops_sheet_tables

        ensure_ops_sheet_tables(con)
        finish_library(con)
        return {
            "ok": True,
            "database": "supabase",
            "team": team,
            "teams": [{"id": key, "label": label} for key, label in TEAMS.items()],
            "machine_columns": [{"key": key, "label": label} for key, label in MACHINE_FIELDS],
            "rfqs": _load_rfqs(con),
        }


def update_header(sheet_id: int, team: str, fields: dict) -> dict:
    require_team(team, ("ops",))
    if not isinstance(fields, dict) or not fields:
        raise RfqWorkflowError("Choose a field to save.")
    allowed = {"rfq_no", "customer", "title", "file_name"}
    if any(key not in allowed for key in fields):
        raise RfqWorkflowError("That RFQ field cannot be edited.")
    with planner_db() as con:
        _ensure(con)
        current = one(con.execute(
            "SELECT * FROM public.planner_ops_sheet WHERE sheet_id = %s",
            (sheet_id,),
        ))
        if not current:
            raise RfqWorkflowError("That RFQ was not found.", 404)
        updates = {}
        for key in ("customer", "title", "file_name"):
            if key not in fields:
                continue
            text = " ".join(str(fields.get(key) or "").split())
            if key == "file_name" and not text:
                raise RfqWorkflowError("RFQ file name is required.")
            if len(text) > (240 if key == "file_name" else 200):
                raise RfqWorkflowError("That value is too long.")
            updates[key] = text
        if "rfq_no" in fields:
            rfq_no = re.sub(r"\s+", "", str(fields.get("rfq_no") or "")).upper()
            if not rfq_no:
                raise RfqWorkflowError("RFQ number is required.")
            if len(rfq_no) > 80:
                raise RfqWorkflowError("RFQ number is too long.")
            taken = one(con.execute(
                """
                SELECT sheet_id FROM public.planner_ops_sheet
                 WHERE rfq_no = %s AND sheet_id <> %s
                """,
                (rfq_no, sheet_id),
            ))
            if taken:
                raise RfqWorkflowError("That RFQ number is already used.")
            updates["rfq_no"] = rfq_no
        if not updates:
            raise RfqWorkflowError("Choose a field to save.")
        assignments = []
        params = []
        for key, value in updates.items():
            if _same(current.get(key), value):
                continue
            _audit(con, sheet_id, None, team, key, current.get(key), value)
            assignments.append(f"{key} = %s")
            params.append(value)
        if assignments:
            assignments.append("updated_at = NOW()")
            params.append(sheet_id)
            con.execute(
                f"UPDATE public.planner_ops_sheet SET {', '.join(assignments)} WHERE sheet_id = %s",
                tuple(params),
            )
        return {"ok": True, "rfq": _load_one(con, sheet_id)}


def update_ops_line(line_id: int, team: str, fields: dict) -> dict:
    require_team(team, ("ops",))
    from .ops_sheet_service import prepare_line_update

    prepared = prepare_line_update(fields)
    with planner_db() as con:
        _ensure(con)
        current = one(con.execute(
            "SELECT * FROM public.planner_ops_sheet_line WHERE line_id = %s",
            (line_id,),
        ))
        if not current:
            raise RfqWorkflowError("That part line was not found.", 404)
        changed = []
        for key, value in prepared.items():
            previous = current.get(key)
            if key == "qty_breaks":
                previous = _load_breaks(previous)
            if _same(previous, value):
                continue
            changed.append((key, previous, value))
        if not changed:
            return {"ok": True, "rfq": _load_one(con, int(current["sheet_id"]))}
        merged = dict(current)
        for key, _previous, value in changed:
            merged[key] = value
        ops_auto, ops_basis = infer_operations(
            merged.get("engineering_remarks"),
            [merged.get(key) for key in CYCLE_KEYS],
        )
        new_rev = int(current.get("rev") or 1) + 1
        assignments = []
        params = []
        for key, _previous, value in changed:
            assignments.append(f"{key} = %s")
            params.append(json.dumps(value) if key == "qty_breaks" else value)
            _audit(con, current["sheet_id"], line_id, team, key, _previous, value)
        assignments.extend(["ops_auto = %s", "ops_basis = %s", "rev = %s"])
        params.extend([ops_auto, ops_basis, new_rev, line_id])
        con.execute(
            f"""
            UPDATE public.planner_ops_sheet_line
               SET {", ".join(assignments)}
             WHERE line_id = %s
            """,
            tuple(params),
        )
        _touch_sheet(con, int(current["sheet_id"]), new_rev)
        _audit(con, current["sheet_id"], line_id, team, "rev", current.get("rev") or 1, new_rev)
        return {"ok": True, "rfq": _load_one(con, int(current["sheet_id"]))}


def update_quote(line_id: int, team: str, fields: dict) -> dict:
    require_team(team, ("supply_chain",))
    if not isinstance(fields, dict) or not fields:
        raise RfqWorkflowError("Choose a quote field to save.")
    prepared = _prepare_quote(fields)
    with planner_db() as con:
        _ensure(con)
        line = _line_for_quote(con, line_id)
        current = one(con.execute(
            "SELECT * FROM public.planner_rfq_quote WHERE line_id = %s",
            (line["line_id"],),
        )) or {}
        _write_quote(con, line, team, prepared, current)
        return {"ok": True, "rfq": _load_one(con, int(line["sheet_id"]))}


def update_tat(line_id: int, team: str, tat_days) -> dict:
    require_team(team, ("planning",))
    days = _optional_number(tat_days, "TAT days")
    if days is not None and days < 0:
        raise RfqWorkflowError("TAT days cannot be negative.")
    with planner_db() as con:
        _ensure(con)
        line = one(con.execute(
            "SELECT * FROM public.planner_ops_sheet_line WHERE line_id = %s",
            (line_id,),
        ))
        if not line:
            raise RfqWorkflowError("That part line was not found.", 404)
        owner = _quote_owner(con, line)
        quote = one(con.execute(
            "SELECT * FROM public.planner_rfq_quote WHERE line_id = %s",
            (owner["line_id"],),
        ))
        if not tat_unlocked(quote):
            raise RfqWorkflowError(
                "TAT waits until Supply Chain has a quoted supplier lead time.",
                409,
            )
        current = one(con.execute(
            "SELECT * FROM public.planner_rfq_tat WHERE line_id = %s",
            (line_id,),
        ))
        previous = None if not current else current.get("tat_days")
        if _same(previous, days):
            return {"ok": True, "rfq": _load_one(con, int(line["sheet_id"]))}
        confirmed = int(line.get("rev") or 1) if days is not None else int((current or {}).get("confirmed_rev") or 1)
        con.execute(
            """
            INSERT INTO public.planner_rfq_tat (line_id, tat_days, confirmed_rev, updated_by, updated_at)
            VALUES (%s, %s, %s, %s, NOW())
            ON CONFLICT (line_id) DO UPDATE SET
                tat_days = EXCLUDED.tat_days,
                confirmed_rev = EXCLUDED.confirmed_rev,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
            """,
            (line_id, days, confirmed, TEAMS[team]),
        )
        _audit(con, line["sheet_id"], line_id, team, "tat_days", previous, days)
        _touch_sheet(con, int(line["sheet_id"]), int(line.get("rev") or 1))
        return {"ok": True, "rfq": _load_one(con, int(line["sheet_id"]))}


def reconfirm_line(line_id: int, team: str) -> dict:
    require_team(team, ("supply_chain", "planning"))
    with planner_db() as con:
        _ensure(con)
        loaded = _load_one(con, _sheet_id_for_line(con, line_id))
        target = next((item for item in loaded["lines"] if item["line_id"] == line_id), None)
        if not target:
            raise RfqWorkflowError("That part line was not found.", 404)
        if not target["workflow"]["stale"]:
            raise RfqWorkflowError("This line does not need a reconfirm.")
        waiting = target["workflow"]["waiting_on"]
        if waiting == "Supply Chain" and team != "supply_chain":
            raise RfqWorkflowError("Supply Chain reconfirms the supplier quote.", 403)
        if waiting == "Planning" and team != "planning":
            raise RfqWorkflowError("Planning reconfirms the turnaround.", 403)
        rev = int(target["rev"] or 1)
        if team == "supply_chain":
            owner_id = target["quote_owner_line_id"]
            con.execute(
                """
                UPDATE public.planner_rfq_quote
                   SET confirmed_rev = %s, updated_by = %s, updated_at = NOW()
                 WHERE line_id = %s
                """,
                (rev, TEAMS[team], owner_id),
            )
            _audit(con, loaded["sheet_id"], line_id, team, "quote_confirmed_rev", target["quote"]["confirmed_rev"] if target.get("quote") else None, rev)
        else:
            con.execute(
                """
                INSERT INTO public.planner_rfq_tat (line_id, tat_days, confirmed_rev, updated_by, updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (line_id) DO UPDATE SET
                    confirmed_rev = EXCLUDED.confirmed_rev,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = NOW()
                """,
                (line_id, target["tat_days"], rev, TEAMS[team]),
            )
            _audit(con, loaded["sheet_id"], line_id, team, "tat_confirmed_rev", (target.get("tat") or {}).get("confirmed_rev"), rev)
        return {"ok": True, "rfq": _load_one(con, int(loaded["sheet_id"]))}


def price_to_sales_workbook(sheet_id: int):
    from openpyxl import Workbook

    with planner_db() as con:
        _ensure(con)
        rfq = _load_one(con, sheet_id)
    book = Workbook()
    sheet = book.active
    sheet.title = "Price to Sales"
    headers = [
        "RFQ", "Customer", "S/N", "Part number", "Description", "RFQ qty",
        "Material", "Spec", "Thk / Ø", "Width", "Length", "Setup mins", "Cycle mins",
        "Calculated hours", "Need (mtr)", "kg/mtr", "Supplier", "Quote SGD",
        "Lead (weeks)", "Quote state", "TAT days", "Status",
    ]
    sheet.append(headers)
    for line in rfq["lines"]:
        quote = line.get("quote") or {}
        sheet.append([
            rfq["rfq_no"],
            rfq["customer"],
            line["sn"],
            line["part_number"],
            line["description"],
            line["rfq_qty_text"] or line["rfq_qty"],
            line["material_type"],
            line["material_spec"],
            line["raw_thk"],
            line["raw_width"],
            line["raw_length"],
            line["setup_mins"],
            line["cycle_sum"],
            line["calc_hours"],
            quote.get("qty_needed_mtr"),
            quote.get("kg_per_mtr"),
            quote.get("supplier"),
            quote.get("material_cost_sgd"),
            quote.get("lead_time_weeks"),
            QUOTE_STATE_LABELS.get(quote.get("state") or "", ""),
            line.get("tat_days"),
            line["workflow"]["label"],
        ])
    return book, rfq


def capture_workflow(con, sheet_id: int) -> list[dict]:
    ensure_rfq_workflow(con)
    lines = rows(con.execute(
        """
        SELECT *
          FROM public.planner_ops_sheet_line
         WHERE sheet_id = %s
         ORDER BY row_index, line_id
        """,
        (sheet_id,),
    ))
    if not lines:
        return []
    ids = [line["line_id"] for line in lines]
    quotes = {
        item["line_id"]: item
        for item in rows(con.execute(
            "SELECT * FROM public.planner_rfq_quote WHERE line_id = ANY(%s)",
            (ids,),
        ))
    }
    tats = {
        item["line_id"]: item
        for item in rows(con.execute(
            "SELECT * FROM public.planner_rfq_tat WHERE line_id = ANY(%s)",
            (ids,),
        ))
    }
    by_id = {line["line_id"]: line for line in lines}
    captured = []
    for line in lines:
        parent = by_id.get(line.get("quote_ref_line_id"))
        captured.append({
            "row_index": line["row_index"],
            "part_number": line.get("part_number"),
            "rev": int(line.get("rev") or 1),
            "parent_row_index": None if not parent else parent["row_index"],
            "quote": quotes.get(line["line_id"]),
            "tat": tats.get(line["line_id"]),
            "snapshot": {key: line.get(key) for key in OPS_COMPARE},
        })
    return captured


def restore_workflow(con, sheet_id: int, captured: list[dict]) -> None:
    if not captured:
        return
    fresh = rows(con.execute(
        """
        SELECT *
          FROM public.planner_ops_sheet_line
         WHERE sheet_id = %s
        """,
        (sheet_id,),
    ))
    by_row = {line["row_index"]: line for line in fresh}
    id_by_row = {}
    for item in captured:
        current = by_row.get(item["row_index"])
        if not current or not _same(current.get("part_number"), item.get("part_number")):
            continue
        rev = int(item["rev"] or 1)
        if _ops_changed(item["snapshot"], current):
            rev += 1
            _audit(con, sheet_id, current["line_id"], "ops", "import", item["rev"], rev)
        con.execute(
            "UPDATE public.planner_ops_sheet_line SET rev = %s WHERE line_id = %s",
            (rev, current["line_id"]),
        )
        id_by_row[item["row_index"]] = current["line_id"]
        _restore_quote(con, current["line_id"], item.get("quote"))
        _restore_tat(con, current["line_id"], item.get("tat"))
    for item in captured:
        child_id = id_by_row.get(item["row_index"])
        parent_id = id_by_row.get(item.get("parent_row_index"))
        if child_id and parent_id and child_id != parent_id:
            con.execute(
                "UPDATE public.planner_ops_sheet_line SET quote_ref_line_id = %s WHERE line_id = %s",
                (parent_id, child_id),
            )


def import_seed_rfq(con) -> None:
    if not _SEED_PATH.is_file():
        return
    existing = one(con.execute(
        "SELECT sheet_id FROM public.planner_ops_sheet WHERE rfq_no = %s OR source_path = %s",
        ("RFQ00006", _SEED_SOURCE),
    ))
    if existing:
        return
    payload = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
    inserted = one(con.execute(
        """
        INSERT INTO public.planner_ops_sheet (
            source_path, file_name, rfq_folder, status, date_in, date_out,
            file_missing, scanned_at, rfq_no, customer, title, ops_rev, updated_at
        ) VALUES (
            %s, %s, %s, 'current', %s, %s,
            FALSE, NOW(), 'RFQ00006', %s, %s, %s, NOW()
        )
        RETURNING sheet_id
        """,
        (
            _SEED_SOURCE,
            "OPS Sheet RFQ00006.xlsx",
            payload.get("customer") or "Langley / HH",
            payload.get("dateIn"),
            payload.get("dateOut"),
            payload.get("customer") or "Langley / HH",
            "Rolled alloy · impact",
            int(payload.get("opsRev") or 1),
        ),
    ))
    sheet_id = int(inserted["sheet_id"])
    sn_to_id = {}
    for line in payload.get("lines") or []:
        machines = line.get("machineMins") or {}
        values = {key: None for key, _label in MACHINE_FIELDS}
        for label, minutes in machines.items():
            key = _MACHINE_BY_LABEL.get(str(label).casefold())
            if key:
                values[key] = minutes
        material = line.get("material") or {}
        raw = line.get("rawMaterialMm") or {}
        remarks = line.get("engineeringRemarks") or ""
        cycles = [values[key] for key, _label in MACHINE_FIELDS]
        ops_auto, ops_basis = infer_operations(remarks, cycles)
        qty = line.get("rfqQty")
        saved = one(con.execute(
            """
            INSERT INTO public.planner_ops_sheet_line (
                sheet_id, row_index, part_number, description, rfq_qty_text, rfq_qty, qty_breaks,
                material_type, material_spec, raw_thk, raw_width, raw_length, setup_mins,
                mill_3axis, mill_4axis, mill_5axis, mill_5axis_i800,
                turn_quick, turn_j200, turn_i250,
                edm_wirecut, edm, edm_superdrill,
                backend_deburr, backend_cleaning,
                fixture_required, engineering_remarks, nre_text, ops_auto, ops_basis, rev
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s, %s, %s, %s, 1
            )
            RETURNING line_id
            """,
            (
                sheet_id,
                int(line["sn"]),
                line.get("partNumber"),
                line.get("description"),
                "" if qty is None else str(qty),
                qty,
                json.dumps([] if qty is None else [qty]),
                material.get("type"),
                material.get("spec"),
                raw.get("thkOrDia"),
                raw.get("width"),
                raw.get("length"),
                line.get("setupMins"),
                values["mill_3axis"], values["mill_4axis"], values["mill_5axis"], values["mill_5axis_i800"],
                values["turn_quick"], values["turn_j200"], values["turn_i250"],
                values["edm_wirecut"], values["edm"], values["edm_superdrill"],
                values["backend_deburr"], values["backend_cleaning"],
                None if line.get("fixtureRequired") is None else str(line.get("fixtureRequired")),
                remarks,
                None if line.get("nreSgd") is None else str(line.get("nreSgd")),
                ops_auto,
                ops_basis,
            ),
        ))
        sn_to_id[int(line["sn"])] = int(saved["line_id"])
    for line in payload.get("lines") or []:
        ref = line.get("quoteRefSn")
        if not ref:
            continue
        child = sn_to_id.get(int(line["sn"]))
        parent = sn_to_id.get(int(ref))
        if child and parent:
            con.execute(
                "UPDATE public.planner_ops_sheet_line SET quote_ref_line_id = %s WHERE line_id = %s",
                (parent, child),
            )
    for line in payload.get("lines") or []:
        supply = line.get("supplyChain")
        if not supply or line.get("quoteRefSn"):
            continue
        lead = _lead_weeks(supply.get("leadTime"))
        state = "quoted" if lead is not None else "rfq_sent"
        con.execute(
            """
            INSERT INTO public.planner_rfq_quote (
                line_id, state, qty_needed_mtr, kg_per_mtr, material_cost_sgd,
                lead_time_weeks, supplier_note, spec_code, confirmed_rev, updated_by
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1, 'Supply Chain')
            """,
            (
                sn_to_id[int(line["sn"])],
                state,
                supply.get("qtyNeededMtr"),
                supply.get("kgPerMtr"),
                supply.get("materialCostSgd"),
                lead,
                supply.get("supplierNote"),
                (line.get("material") or {}).get("specCodeSupplyChain"),
            ),
        )


def fill_identity(con) -> None:
    edited = {
        row["sheet_id"]
        for row in rows(con.execute(
            """
            SELECT DISTINCT sheet_id
              FROM public.planner_rfq_audit
             WHERE field IN ('rfq_no', 'customer', 'title')
               AND sheet_id IS NOT NULL
            """
        ))
    }
    sheets = rows(con.execute(
        """
        SELECT sheet_id, file_name, rfq_folder, rfq_no, customer, title, source_path
          FROM public.planner_ops_sheet
         ORDER BY sheet_id
        """
    ))
    refresh_ids = [
        sheet["sheet_id"]
        for sheet in sheets
        if sheet["sheet_id"] not in edited and not str(sheet.get("source_path") or "").startswith("rfq-seed://")
    ]
    if refresh_ids:
        con.execute(
            "UPDATE public.planner_ops_sheet SET rfq_no = NULL WHERE sheet_id = ANY(%s)",
            (refresh_ids,),
        )
    used = {
        sheet["rfq_no"]
        for sheet in sheets
        if sheet.get("rfq_no") and sheet["sheet_id"] not in refresh_ids
    }
    for sheet in sheets:
        if sheet["sheet_id"] not in refresh_ids:
            continue
        rfq_no, customer, title = derive_rfq_identity(
            sheet.get("rfq_folder") or "",
            sheet.get("file_name") or "",
            int(sheet["sheet_id"]),
        )
        rfq_no = _unique_rfq_no(rfq_no, used, int(sheet["sheet_id"]))
        used.add(rfq_no)
        con.execute(
            """
            UPDATE public.planner_ops_sheet
               SET rfq_no = %s, customer = %s, title = %s
             WHERE sheet_id = %s
            """,
            (rfq_no, customer, title, sheet["sheet_id"]),
        )


def link_repeats(con, sheet_id: int) -> None:
    lines = rows(con.execute(
        """
        SELECT line_id, row_index, part_number, material_type, engineering_remarks, quote_ref_line_id
          FROM public.planner_ops_sheet_line
         WHERE sheet_id = %s
         ORDER BY row_index, line_id
        """,
        (sheet_id,),
    ))
    ordered = []
    by_sn = {}
    by_id = {}
    for index, line in enumerate(lines, start=1):
        item = dict(line)
        item["sn"] = index
        ordered.append(item)
        by_sn[index] = item
        by_id[item["line_id"]] = item
    first = {}
    for line in ordered:
        part = _part_key(line)
        if line.get("quote_ref_line_id"):
            if part and part not in first:
                first[part] = _owner_line(line, by_id)
            continue
        parent = None
        match = _REFER_SN.search(line.get("engineering_remarks") or "")
        if match:
            parent = by_sn.get(int(match.group(1)))
        if parent is None and part:
            parent = first.get(part)
        if part and part not in first and parent is None:
            first[part] = line
        if not parent or parent["line_id"] == line["line_id"]:
            continue
        parent = _owner_line(parent, by_id)
        if not parent or parent["line_id"] == line["line_id"]:
            continue
        con.execute(
            "UPDATE public.planner_ops_sheet_line SET quote_ref_line_id = %s WHERE line_id = %s",
            (parent["line_id"], line["line_id"]),
        )
        line["quote_ref_line_id"] = parent["line_id"]


def _load_rfqs(con, sheet_id: int | None = None) -> list[dict]:
    where = ""
    params: tuple = ()
    if sheet_id is not None:
        where = "WHERE s.sheet_id = %s"
        params = (sheet_id,)
    sheets = rows(con.execute(
        f"""
        SELECT s.*
          FROM public.planner_ops_sheet s
          {where}
         ORDER BY s.date_in DESC NULLS LAST, s.rfq_no, s.sheet_id
        """,
        params,
    ))
    if not sheets:
        if sheet_id is not None:
            raise RfqWorkflowError("That RFQ was not found.", 404)
        return []
    ids = [sheet["sheet_id"] for sheet in sheets]
    line_rows = rows(con.execute(
        """
        SELECT *
          FROM public.planner_ops_sheet_line
         WHERE sheet_id = ANY(%s)
         ORDER BY sheet_id, row_index, line_id
        """,
        (ids,),
    ))
    line_ids = [line["line_id"] for line in line_rows]
    quotes = {}
    tats = {}
    extras = {}
    if line_ids:
        for item in rows(con.execute(
            "SELECT * FROM public.planner_rfq_quote WHERE line_id = ANY(%s)",
            (line_ids,),
        )):
            quotes[item["line_id"]] = item
        for item in rows(con.execute(
            "SELECT * FROM public.planner_rfq_tat WHERE line_id = ANY(%s)",
            (line_ids,),
        )):
            tats[item["line_id"]] = item
        for item in rows(con.execute(
            "SELECT line_id, column_id, minutes FROM public.planner_ops_extra_value WHERE line_id = ANY(%s)",
            (line_ids,),
        )):
            extras.setdefault(item["line_id"], {})[int(item["column_id"])] = item["minutes"]
    extra_columns = rows(con.execute(
        """
        SELECT column_id, name, apply_mode, sort_order
          FROM public.planner_ops_extra_column
         ORDER BY sort_order, column_id
        """
    ))
    activity = rows(con.execute(
        """
        SELECT sheet_id, line_id, actor, team, field, old_value, new_value, at
          FROM (
            SELECT a.*,
                   ROW_NUMBER() OVER (PARTITION BY sheet_id ORDER BY at DESC, audit_id DESC) AS rn
              FROM public.planner_rfq_audit a
             WHERE sheet_id = ANY(%s)
          ) recent
         WHERE rn <= 12
         ORDER BY at DESC
        """,
        (ids,),
    ))
    grouped: dict[int, list] = {sheet["sheet_id"]: [] for sheet in sheets}
    for line in line_rows:
        grouped.setdefault(line["sheet_id"], []).append(line)
    activity_grouped: dict[int, list] = {sheet["sheet_id"]: [] for sheet in sheets}
    for item in activity:
        activity_grouped.setdefault(item["sheet_id"], []).append(item)
    built = []
    for sheet in sheets:
        if sheet.get("file_missing") or sheet.get("status") == "template":
            if sheet_id is None:
                continue
        built.append(_present_sheet(
            sheet,
            grouped.get(sheet["sheet_id"], []),
            quotes,
            tats,
            extras,
            extra_columns,
            activity_grouped.get(sheet["sheet_id"], []),
        ))
    if sheet_id is not None and not built:
        raise RfqWorkflowError("That RFQ was not found.", 404)
    return built


def _load_one(con, sheet_id: int) -> dict:
    found = _load_rfqs(con, sheet_id)
    return found[0]


def _present_sheet(sheet, line_rows, quotes, tats, extras, extra_columns, activity) -> dict:
    ordered = []
    sn_by_id = {}
    for index, line in enumerate(line_rows, start=1):
        sn_by_id[line["line_id"]] = index
        ordered.append(line)
    status_lines = []
    for line in ordered:
        quote_row = quotes.get(line["line_id"])
        tat_row = tats.get(line["line_id"])
        status_lines.append({
            "sn": sn_by_id[line["line_id"]],
            "qty": line.get("rfq_qty"),
            "material": line.get("material_type") or "",
            "rev": int(line.get("rev") or 1),
            "quote_ref_sn": sn_by_id.get(line.get("quote_ref_line_id")),
            "quote": None if not quote_row else {
                "state": quote_row.get("state") or "not_sent",
                "confirmed_rev": int(quote_row.get("confirmed_rev") or 1),
                "lead_time_weeks": quote_row.get("lead_time_weeks"),
            },
            "tat": {
                "days": None if not tat_row else tat_row.get("tat_days"),
                "confirmed_rev": 1 if not tat_row else int(tat_row.get("confirmed_rev") or 1),
            },
        })
    workflows = [line_status(status_lines, item) for item in status_lines]
    summary = rfq_status(status_lines)
    public_lines = []
    supplier_total = 0.0
    for line, status_line, workflow in zip(ordered, status_lines, workflows):
        ref_sn = status_line["quote_ref_sn"]
        owner = line
        if ref_sn:
            owner = ordered[ref_sn - 1]
        quote_row = quotes.get(owner["line_id"])
        tat_row = tats.get(line["line_id"])
        if quote_row and not ref_sn and quote_row.get("state") == "quoted" and quote_row.get("material_cost_sgd"):
            supplier_total += float(quote_row["material_cost_sgd"])
        stored = dict(line)
        stored["qty_breaks"] = _load_breaks(line.get("qty_breaks"))
        measure = compute_tat(
            stored,
            extra_columns,
            extras.get(line["line_id"], {}),
        )
        hours = [item["hours"] for item in measure["breaks"]]
        public_lines.append({
            "line_id": int(line["line_id"]),
            "sn": status_line["sn"],
            "quote_ref_sn": ref_sn,
            "quote_owner_line_id": int(owner["line_id"]),
            "part_number": line.get("part_number") or "",
            "description": line.get("description") or "",
            "rfq_qty": line.get("rfq_qty"),
            "rfq_qty_text": line.get("rfq_qty_text") or "",
            "material_type": line.get("material_type") or "",
            "material_spec": line.get("material_spec") or "",
            "raw_thk": line.get("raw_thk"),
            "raw_width": line.get("raw_width"),
            "raw_length": line.get("raw_length"),
            "setup_mins": line.get("setup_mins"),
            "cycle_sum": measure["cycle_sum"],
            "calc_hours": hours[0] if hours else None,
            "calc_hour_breaks": hours,
            "machines": [
                {"key": key, "label": label, "minutes": line.get(key)}
                for key, label in MACHINE_FIELDS
                if line.get(key) not in (None, 0)
            ],
            "machine_minutes": {key: line.get(key) for key, _label in MACHINE_FIELDS},
            "fixture_required": line.get("fixture_required") or "",
            "engineering_remarks": line.get("engineering_remarks") or "",
            "nre_text": line.get("nre_text") or "",
            "rev": int(line.get("rev") or 1),
            "quote": _public_quote(quote_row),
            "tat_days": None if not tat_row else tat_row.get("tat_days"),
            "tat": None if not tat_row else {
                "days": tat_row.get("tat_days"),
                "confirmed_rev": int(tat_row.get("confirmed_rev") or 1),
            },
            "tat_open": tat_unlocked(quote_row),
            "workflow": workflow,
        })
    counts: dict[str, int] = {}
    for item in workflows:
        counts[item["label"]] = counts.get(item["label"], 0) + 1
    return {
        "sheet_id": int(sheet["sheet_id"]),
        "rfq_no": sheet.get("rfq_no") or "",
        "customer": sheet.get("customer") or "",
        "title": sheet.get("title") or "",
        "file_name": sheet.get("file_name") or "",
        "folder": sheet.get("rfq_folder") or "",
        "folder_status": sheet.get("status") or "",
        "date_in": _iso_date(sheet.get("date_in")),
        "date_out": _iso_date(sheet.get("date_out")),
        "ops_rev": int(sheet.get("ops_rev") or 1),
        "updated_at": _iso(sheet.get("updated_at")),
        "workflow": summary,
        "counts": counts,
        "supplier_total": round(supplier_total, 2),
        "lines": public_lines,
        "activity": [
            {
                "at": _iso(item.get("at")),
                "actor": item.get("actor") or "",
                "team": item.get("team") or "",
                "field": item.get("field") or "",
                "old": item.get("old_value") or "",
                "new": item.get("new_value") or "",
                "line_id": None if item.get("line_id") is None else int(item["line_id"]),
            }
            for item in activity
        ],
    }


def _public_quote(row):
    if not row:
        return None
    return {
        "state": row.get("state") or "not_sent",
        "state_label": QUOTE_STATE_LABELS.get(row.get("state") or "", "Not sent"),
        "supplier": row.get("supplier") or "",
        "qty_needed_mtr": row.get("qty_needed_mtr"),
        "kg_per_mtr": row.get("kg_per_mtr"),
        "material_cost_sgd": row.get("material_cost_sgd"),
        "lead_time_weeks": row.get("lead_time_weeks"),
        "supplier_note": row.get("supplier_note") or "",
        "spec_code": row.get("spec_code") or "",
        "confirmed_rev": int(row.get("confirmed_rev") or 1),
    }


def _prepare_quote(fields: dict) -> dict:
    allowed = {
        "state", "supplier", "qty_needed_mtr", "kg_per_mtr",
        "material_cost_sgd", "lead_time_weeks", "supplier_note", "spec_code",
    }
    if any(key not in allowed for key in fields):
        raise RfqWorkflowError("That quote column cannot be edited.")
    prepared = {}
    if "state" in fields:
        state = str(fields.get("state") or "").strip()
        if state not in QUOTE_STATES:
            raise RfqWorkflowError("Choose Not sent, RFQ sent, or Quoted.")
        prepared["state"] = state
    for key, limit in (("supplier", 200), ("supplier_note", 2000), ("spec_code", 500)):
        if key not in fields:
            continue
        text = str(fields.get(key) or "").replace("\r\n", "\n").strip()
        if len(text) > limit:
            raise RfqWorkflowError("That value is too long.")
        prepared[key] = text
    for key in ("qty_needed_mtr", "kg_per_mtr", "material_cost_sgd", "lead_time_weeks"):
        if key not in fields:
            continue
        number = _optional_number(fields.get(key), key.replace("_", " "))
        if number is not None and number < 0:
            raise RfqWorkflowError("Quote numbers cannot be negative.")
        prepared[key] = number
    if not prepared:
        raise RfqWorkflowError("Choose a quote field to save.")
    return prepared


def _write_quote(con, line, team: str, prepared: dict, current: dict) -> None:
    merged = {
        "state": current.get("state") or "not_sent",
        "supplier": current.get("supplier"),
        "qty_needed_mtr": current.get("qty_needed_mtr"),
        "kg_per_mtr": current.get("kg_per_mtr"),
        "material_cost_sgd": current.get("material_cost_sgd"),
        "lead_time_weeks": current.get("lead_time_weeks"),
        "supplier_note": current.get("supplier_note"),
        "spec_code": current.get("spec_code"),
        "confirmed_rev": int(current.get("confirmed_rev") or 1),
    }
    changed = False
    for key, value in prepared.items():
        if _same(merged.get(key), value):
            continue
        _audit(con, line["sheet_id"], line["line_id"], team, key, merged.get(key), value)
        merged[key] = value
        changed = True
    if not changed:
        return
    con.execute(
        """
        INSERT INTO public.planner_rfq_quote (
            line_id, state, supplier, qty_needed_mtr, kg_per_mtr, material_cost_sgd,
            lead_time_weeks, supplier_note, spec_code, confirmed_rev, updated_by, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (line_id) DO UPDATE SET
            state = EXCLUDED.state,
            supplier = EXCLUDED.supplier,
            qty_needed_mtr = EXCLUDED.qty_needed_mtr,
            kg_per_mtr = EXCLUDED.kg_per_mtr,
            material_cost_sgd = EXCLUDED.material_cost_sgd,
            lead_time_weeks = EXCLUDED.lead_time_weeks,
            supplier_note = EXCLUDED.supplier_note,
            spec_code = EXCLUDED.spec_code,
            confirmed_rev = EXCLUDED.confirmed_rev,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        """,
        (
            line["line_id"],
            merged["state"],
            merged["supplier"],
            merged["qty_needed_mtr"],
            merged["kg_per_mtr"],
            merged["material_cost_sgd"],
            merged["lead_time_weeks"],
            merged["supplier_note"],
            merged["spec_code"],
            merged["confirmed_rev"],
            TEAMS[team],
        ),
    )
    _touch_sheet(con, int(line["sheet_id"]), int(line.get("rev") or 1))


def _line_for_quote(con, line_id: int) -> dict:
    line = one(con.execute(
        "SELECT * FROM public.planner_ops_sheet_line WHERE line_id = %s",
        (line_id,),
    ))
    if not line:
        raise RfqWorkflowError("That part line was not found.", 404)
    if line.get("quote_ref_line_id"):
        raise RfqWorkflowError("This line shares the supplier quote of an earlier line.")
    return line


def _quote_owner(con, line) -> dict:
    owner_id = line.get("quote_ref_line_id") or line["line_id"]
    if owner_id == line["line_id"]:
        return line
    owner = one(con.execute(
        "SELECT * FROM public.planner_ops_sheet_line WHERE line_id = %s",
        (owner_id,),
    ))
    return owner or line


def _sheet_id_for_line(con, line_id: int) -> int:
    found = one(con.execute(
        "SELECT sheet_id FROM public.planner_ops_sheet_line WHERE line_id = %s",
        (line_id,),
    ))
    if not found:
        raise RfqWorkflowError("That part line was not found.", 404)
    return int(found["sheet_id"])


def _restore_quote(con, line_id: int, quote) -> None:
    if not quote:
        return
    con.execute(
        """
        INSERT INTO public.planner_rfq_quote (
            line_id, state, supplier, qty_needed_mtr, kg_per_mtr, material_cost_sgd,
            lead_time_weeks, supplier_note, spec_code, confirmed_rev, updated_by, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (line_id) DO NOTHING
        """,
        (
            line_id,
            quote.get("state") or "not_sent",
            quote.get("supplier"),
            quote.get("qty_needed_mtr"),
            quote.get("kg_per_mtr"),
            quote.get("material_cost_sgd"),
            quote.get("lead_time_weeks"),
            quote.get("supplier_note"),
            quote.get("spec_code"),
            int(quote.get("confirmed_rev") or 1),
            quote.get("updated_by"),
        ),
    )


def _restore_tat(con, line_id: int, tat) -> None:
    if not tat:
        return
    con.execute(
        """
        INSERT INTO public.planner_rfq_tat (line_id, tat_days, confirmed_rev, updated_by, updated_at)
        VALUES (%s, %s, %s, %s, NOW())
        ON CONFLICT (line_id) DO NOTHING
        """,
        (
            line_id,
            tat.get("tat_days"),
            int(tat.get("confirmed_rev") or 1),
            tat.get("updated_by"),
        ),
    )


def _touch_sheet(con, sheet_id: int, rev: int) -> None:
    con.execute(
        """
        UPDATE public.planner_ops_sheet
           SET updated_at = NOW(),
               ops_rev = GREATEST(ops_rev, %s)
         WHERE sheet_id = %s
        """,
        (rev, sheet_id),
    )


def _audit(con, sheet_id, line_id, team: str, field: str, old, new) -> None:
    con.execute(
        """
        INSERT INTO public.planner_rfq_audit
            (sheet_id, line_id, actor, team, field, old_value, new_value)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            sheet_id,
            line_id,
            TEAMS.get(team, team),
            team,
            field,
            _clip(old),
            _clip(new),
        ),
    )


def _ensure(con) -> None:
    from .ops_sheet_service import ensure_ops_sheet_tables

    ensure_ops_sheet_tables(con)


def _ops_changed(snapshot: dict, current: dict) -> bool:
    for key, previous in snapshot.items():
        value = current.get(key)
        if key == "qty_breaks":
            value = _load_breaks(value)
        if not _same(previous, value):
            return True
    return False


def _owner_line(line, by_id):
    seen = set()
    current = line
    while current and current.get("quote_ref_line_id") and current["line_id"] not in seen:
        seen.add(current["line_id"])
        parent = by_id.get(current["quote_ref_line_id"])
        if not parent:
            break
        current = parent
    return current


def _part_key(line) -> tuple[str, str] | None:
    part = str(line.get("part_number") or "").strip().casefold()
    if not part:
        return None
    material = str(line.get("material_type") or "").strip().casefold()
    return part, material


def _unique_rfq_no(rfq_no: str, used: set, sheet_id: int) -> str:
    if rfq_no not in used:
        return rfq_no
    suffix = 2
    while f"{rfq_no}-{suffix}" in used:
        suffix += 1
    candidate = f"{rfq_no}-{suffix}"
    if len(candidate) <= 80:
        return candidate
    return f"RFQ-{sheet_id}"


def _lead_weeks(value):
    if value is None or value == "":
        return None
    match = re.search(r"\d+(?:\.\d+)?", str(value))
    if not match:
        return None
    return float(match.group(0))


def _optional_number(value, label: str):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RfqWorkflowError(f"{label} must be a number.") from None
    if number != number or number in {float("inf"), float("-inf")} or abs(number) > 1_000_000:
        raise RfqWorkflowError(f"{label} must be a number.")
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


def _same(left, right) -> bool:
    if left is None and right in ("", None):
        return True
    if right is None and left in ("", None):
        return True
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        try:
            return abs(float(left) - float(right)) < 1e-9
        except (TypeError, ValueError):
            return False
    return str(left or "").strip() == str(right or "").strip()


def _clip(value) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text[:2000]


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
