"""Read OPS Sheet workbooks and turn their cycle times into turnaround time.

TAT minutes = (cycle minutes + per-piece extras) × RFQ qty
            + (setup minutes + per-operation extras) × operations
            + flat extras
TAT hours = TAT minutes / 60

Operations come from remark tags such as "2 TN" and "2 ML" when those are
present. Otherwise they are the count of cycle cells that have a time.
"""
from __future__ import annotations

import os
import re
import warnings
from datetime import date, datetime

DEFAULT_OPS_SHEET_ROOT = (
    r"Z:\Public\OperationsDoc\0. Manufacturing Progress Report"
    r"\Shared SOE Attachment Dump\0.RFQ\RFQ Current"
)

CYCLE_KEYS = (
    "mill_3axis",
    "mill_4axis",
    "mill_5axis",
    "mill_5axis_i800",
    "turn_quick",
    "turn_j200",
    "turn_i250",
    "edm_wirecut",
    "edm",
    "edm_superdrill",
    "backend_deburr",
    "backend_cleaning",
)

DISPLAY_COLUMNS = (
    {"key": "part_number", "label": "Part number", "group": "", "kind": "text", "section": "before"},
    {"key": "description", "label": "Description", "group": "", "kind": "text", "section": "before"},
    {"key": "rfq_qty_text", "label": "RFQ qty", "group": "", "kind": "text", "section": "before"},
    {"key": "material_type", "label": "Type", "group": "Material", "kind": "text", "section": "before"},
    {"key": "material_spec", "label": "Specification", "group": "Material", "kind": "text", "section": "before"},
    {"key": "raw_thk", "label": "Thk / Ø", "group": "Raw material (mm)", "kind": "number", "section": "before"},
    {"key": "raw_width", "label": "Width", "group": "Raw material (mm)", "kind": "number", "section": "before"},
    {"key": "raw_length", "label": "Length", "group": "Raw material (mm)", "kind": "number", "section": "before"},
    {"key": "setup_mins", "label": "Setup", "group": "Setup (mins)", "kind": "minutes", "section": "before", "role": "setup"},
    {"key": "mill_3axis", "label": "3 Axis", "group": "Milling (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "mill_4axis", "label": "4 Axis", "group": "Milling (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "mill_5axis", "label": "5 Axis", "group": "Milling (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "mill_5axis_i800", "label": "5 Axis (i-800)", "group": "Milling (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "turn_quick", "label": "Quick Turn", "group": "Turning (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "turn_j200", "label": "J-200", "group": "Turning (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "turn_i250", "label": "i-250", "group": "Turning (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "edm_wirecut", "label": "Wirecut", "group": "EDM (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "edm", "label": "EDM", "group": "EDM (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "edm_superdrill", "label": "Superdrill", "group": "EDM (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "backend_deburr", "label": "Deburring", "group": "Backend (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "backend_cleaning", "label": "Cleaning", "group": "Backend (mins)", "kind": "minutes", "section": "before", "role": "cycle"},
    {"key": "fixture_required", "label": "Fixture required", "group": "", "kind": "text", "section": "after"},
    {"key": "engineering_remarks", "label": "Engineering remarks", "group": "", "kind": "text", "section": "after"},
    {"key": "nre_text", "label": "NRE (SGD)", "group": "", "kind": "text", "section": "after"},
)

_OP_TOKEN = re.compile(r"(\d+)\s*(TN|TM|ML|EDM|WC|SD)\b", re.IGNORECASE)
_SIMPLE_PRODUCT = re.compile(r"^=(-?\d+(?:\.\d+)?)\*(-?\d+(?:\.\d+)?)$")
_THOUSANDS = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")
_HEADER_SKIP = {
    "material",
    "raw material (mm)",
    "raw material",
    "milling (mins)",
    "milling",
    "turning (mins)",
    "turning",
    "backend (mins)",
    "backend",
    "ct",
    "tat",
    "machine",
}


def ops_sheet_root() -> str:
    raw = (os.getenv("OPS_SHEET_ROOT") or DEFAULT_OPS_SHEET_ROOT).strip()
    return os.path.normpath(raw)


def header_field(text) -> str | None:
    """Map one OPS Sheet header cell onto a stored field."""
    key = _header_key(text)
    if not key or key in _HEADER_SKIP:
        return None
    if key.startswith("edm") and "min" in key:
        return None
    if key.startswith("part num") or key in {"part no", "part no."}:
        return "part_number"
    if key.startswith("desc"):
        return "description"
    if key.startswith("rfq") or key in {"qty", "quantity"}:
        return "rfq_qty"
    if key in {"type", "material type"}:
        return "material_type"
    if key.startswith("spec"):
        return "material_spec"
    if key.startswith("thk") or key in {"od", "dia", "diameter", "thickness"}:
        return "raw_thk"
    if key == "width" or key.startswith("width"):
        return "raw_width"
    if key == "length" or key.startswith("length"):
        return "raw_length"
    if "setup" in key:
        return "setup_mins"
    if "3 axis" in key or "3-axis" in key:
        return "mill_3axis"
    if "4 axis" in key or "4-axis" in key:
        return "mill_4axis"
    if "5 axis" in key or "5-axis" in key:
        if any(token in key for token in ("800", "i-800", "i800")):
            return "mill_5axis_i800"
        return "mill_5axis"
    if "quick" in key and "turn" in key:
        return "turn_quick"
    if "j-200" in key or "j200" in key:
        return "turn_j200"
    if any(token in key for token in ("j-210", "j210", "i-250", "i250")):
        return "turn_i250"
    if "wire" in key:
        return "edm_wirecut"
    if "super" in key:
        return "edm_superdrill"
    if key == "edm":
        return "edm"
    if "deburr" in key:
        return "backend_deburr"
    if "clean" in key:
        return "backend_cleaning"
    if "fixture" in key:
        return "fixture_required"
    if "remark" in key:
        return "engineering_remarks"
    if key.startswith("nre"):
        return "nre_text"
    return None


def infer_operations(remarks, cycle_values) -> tuple[int, str]:
    """Return (count, basis) where basis is 'remarks' or 'cycles'."""
    tokens = _OP_TOKEN.findall(str(remarks or ""))
    if tokens:
        total = sum(int(count) for count, _tag in tokens)
        if total > 0:
            return total, "remarks"
    filled = sum(1 for value in cycle_values if value is not None and float(value) > 0)
    return filled, "cycles"


def compute_tat(line: dict, extra_columns, extra_values) -> dict:
    """Build the TAT breaks for one part line."""
    cycle_sum = sum(float(line.get(key) or 0) for key in CYCLE_KEYS)
    setup = float(line.get("setup_mins") or 0)
    override = line.get("ops_override")
    if override is None:
        ops = int(line.get("ops_auto") or 0)
        ops_source = line.get("ops_basis") or "cycles"
    else:
        ops = int(override)
        ops_source = "override"
    per_piece = 0.0
    per_operation = 0.0
    flat = 0.0
    for column in extra_columns or []:
        minutes = _optional_float((extra_values or {}).get(column.get("column_id")))
        if not minutes:
            continue
        mode = column.get("apply_mode") or "per_piece"
        if mode == "per_operation":
            per_operation += minutes
        elif mode == "flat":
            flat += minutes
        else:
            per_piece += minutes
    piece = cycle_sum + per_piece
    operation_part = setup + per_operation
    quantities = list(line.get("qty_breaks") or [])
    if not quantities:
        quantities = [line.get("rfq_qty")]
    breaks = []
    for qty in quantities:
        qty_value = float(qty or 0)
        minutes = piece * qty_value + operation_part * ops + flat
        breaks.append({
            "qty": _clean_number(qty) if qty is not None else None,
            "minutes": _clean_number(minutes),
            "hours": _clean_number(round(minutes / 60.0, 2)),
            "detail": _tat_detail(piece, qty_value, operation_part, ops, flat),
        })
    return {
        "cycle_sum": _clean_number(cycle_sum),
        "ops_effective": ops,
        "ops_source": ops_source,
        "breaks": breaks,
    }


def parse_ops_workbook(path: str, root: str | None = None) -> dict:
    """Parse the Time sheet of one OPS Sheet workbook."""
    from openpyxl import load_workbook

    warnings.filterwarnings("ignore", message="Data Validation extension is not supported", module="openpyxl")
    root = os.path.normpath(root or os.path.dirname(path))
    path = os.path.normpath(path)
    wb_values = load_workbook(path, data_only=True)
    wb_formulas = load_workbook(path, data_only=False)
    try:
        values_ws = _pick_sheet(wb_values)
        formula_ws = wb_formulas[values_ws.title]
        field_cols = _field_columns(formula_ws)
        if "part_number" not in field_cols:
            raise ValueError(f"{os.path.basename(path)} has no Part Number column")
        lines = _read_lines(values_ws, formula_ws, field_cols)
        date_in = _as_date(_labeled_value(values_ws, formula_ws, 1, "date in"))
        date_out = _as_date(_labeled_value(values_ws, formula_ws, 1, "date out"))
    finally:
        wb_values.close()
        wb_formulas.close()
    folder, status = classify_ops_sheet(path, root, bool(lines))
    stat = os.stat(path)
    return {
        "source_path": path,
        "file_name": os.path.basename(path),
        "rfq_folder": folder,
        "status": status,
        "date_in": date_in,
        "date_out": date_out,
        "file_mtime": datetime.fromtimestamp(stat.st_mtime).astimezone(),
        "file_size": stat.st_size,
        "lines": lines,
    }


def classify_ops_sheet(path: str, root: str, has_lines: bool) -> tuple[str, str]:
    rel = os.path.relpath(os.path.normpath(path), os.path.normpath(root))
    parts = rel.split(os.sep)
    folders = [part.lower() for part in parts[:-1]]
    if any(part == "archive" for part in folders):
        status = "archive"
    elif any(part.startswith("0. completed") for part in folders):
        status = "completed"
    elif not has_lines:
        status = "template"
    else:
        status = "current"
    if len(parts) == 1:
        folder = "RFQ Current"
    elif folders and folders[0].startswith("0. completed") and len(parts) >= 3:
        folder = parts[1]
    elif folders and folders[0] == "archive" and len(parts) >= 3:
        folder = parts[1]
    else:
        folder = parts[0]
    return folder, status


def iter_ops_sheet_files(root: str):
    root = os.path.normpath(root)
    if not os.path.isdir(root):
        return
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.startswith("~$"):
                continue
            stem, ext = os.path.splitext(name)
            if ext.lower() not in {".xlsx", ".xlsm"}:
                continue
            if not stem.lower().startswith("ops sheet"):
                continue
            yield os.path.normpath(os.path.join(dirpath, name))


def _pick_sheet(workbook):
    for name in workbook.sheetnames:
        if name.strip().lower() == "time":
            return workbook[name]
    for name in workbook.sheetnames:
        if name.strip().lower() == "tat":
            continue
        sheet = workbook[name]
        if _sheet_has_part_header(sheet):
            return sheet
    for name in workbook.sheetnames:
        sheet = workbook[name]
        if _sheet_has_part_header(sheet):
            return sheet
    return workbook[workbook.sheetnames[0]]


def _sheet_has_part_header(sheet) -> bool:
    for row in (2, 3):
        for col in range(1, (sheet.max_column or 1) + 1):
            if header_field(sheet.cell(row, col).value) == "part_number":
                return True
    return False


def _field_columns(sheet) -> dict[str, int]:
    found = {}
    max_col = sheet.max_column or 1
    for col in range(1, max_col + 1):
        text = sheet.cell(3, col).value
        if text is None or str(text).strip() == "":
            text = sheet.cell(2, col).value
        field = header_field(text)
        if field and field not in found:
            found[field] = col
    return found


def _read_lines(values_ws, formula_ws, field_cols) -> list[dict]:
    lines = []
    empty_run = 0
    max_row = max(values_ws.max_row or 0, formula_ws.max_row or 0)
    for row_index in range(4, max_row + 1):
        part = _text(_cell(values_ws, formula_ws, row_index, field_cols["part_number"]))
        description = ""
        if "description" in field_cols:
            description = _text(_cell(values_ws, formula_ws, row_index, field_cols["description"]))
        if not part and not description:
            empty_run += 1
            if empty_run >= 5:
                break
            continue
        empty_run = 0
        if part.lower() == "part number":
            continue
        line = {
            "row_index": row_index,
            "part_number": part,
            "description": description,
        }
        qty_value = _cell(values_ws, formula_ws, row_index, field_cols["rfq_qty"]) if "rfq_qty" in field_cols else None
        primary, breaks, qty_text = parse_qty(qty_value)
        line["rfq_qty"] = primary
        line["qty_breaks"] = breaks
        line["rfq_qty_text"] = qty_text
        for key in (
            "material_type",
            "material_spec",
            "fixture_required",
            "engineering_remarks",
            "nre_text",
        ):
            line[key] = _text(_mapped_cell(values_ws, formula_ws, row_index, field_cols, key))
        for key in (
            "raw_thk",
            "raw_width",
            "raw_length",
            "setup_mins",
            *CYCLE_KEYS,
        ):
            line[key] = _optional_float(_mapped_cell(values_ws, formula_ws, row_index, field_cols, key))
        ops_auto, ops_basis = infer_operations(
            line["engineering_remarks"],
            [line[key] for key in CYCLE_KEYS],
        )
        line["ops_auto"] = ops_auto
        line["ops_basis"] = ops_basis
        lines.append(line)
    return lines


def parse_qty(value):
    """Return (primary qty, every break, original text)."""
    if isinstance(value, bool):
        return None, [], ""
    if isinstance(value, (int, float)):
        number = float(value)
        return number, [number], _number_text(number)
    text = _text(value)
    if not text:
        return None, [], ""
    if _THOUSANDS.fullmatch(text):
        number = float(text.replace(",", ""))
        return number, [number], text
    numbers = [float(match) for match in re.findall(r"\d+(?:\.\d+)?", text)]
    primary = numbers[0] if numbers else None
    return primary, numbers, text


def _mapped_cell(values_ws, formula_ws, row, field_cols, key):
    col = field_cols.get(key)
    if not col:
        return None
    return _cell(values_ws, formula_ws, row, col)


def _cell(values_ws, formula_ws, row, col):
    value = values_ws.cell(row, col).value
    if value is not None:
        return value
    raw = formula_ws.cell(row, col).value
    if isinstance(raw, str) and raw.startswith("="):
        match = _SIMPLE_PRODUCT.match(raw.replace(" ", ""))
        if match:
            return round(float(match.group(1)) * float(match.group(2)), 6)
        return None
    return raw


def _labeled_value(values_ws, formula_ws, row, label):
    max_col = max(values_ws.max_column or 1, formula_ws.max_column or 1)
    for col in range(1, max_col + 1):
        text = _header_key(formula_ws.cell(row, col).value or values_ws.cell(row, col).value)
        if not text.startswith(label):
            continue
        for next_col in range(col + 1, min(col + 4, max_col + 1)):
            value = _cell(values_ws, formula_ws, row, next_col)
            if value not in (None, ""):
                return value
    return None


def _header_key(value) -> str:
    text = _text(value).lower().replace("ø", "o").replace("φ", "o")
    text = text.replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text)


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, float):
        return str(value)
    return str(value).strip()


def _number_text(number: float) -> str:
    if float(number).is_integer():
        return str(int(number))
    return str(number)


def _optional_float(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _as_date(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def _clean_number(value):
    if value is None:
        return None
    number = float(value)
    if abs(number - round(number)) < 1e-9:
        return int(round(number))
    return round(number, 4)


def _tat_detail(piece, qty, operation_part, ops, flat) -> str:
    parts = [f"{_fmt_g(piece)} min × {_fmt_g(qty)}"]
    if operation_part or ops:
        parts.append(f"{_fmt_g(operation_part)} min × {int(ops)} ops")
    if flat:
        parts.append(f"{_fmt_g(flat)} min flat")
    return " + ".join(parts)


def _fmt_g(number) -> str:
    if abs(float(number) - round(float(number))) < 1e-9:
        return str(int(round(float(number))))
    text = f"{float(number):.2f}".rstrip("0").rstrip(".")
    return text or "0"
