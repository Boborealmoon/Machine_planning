import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "tool_list.db")

# Ordered to match Google Sheet columns left-to-right (row 1 header skipped on sync)
COLUMNS = [
    "timestamp",             # col 0
    "programmer_name",       # col 1
    "program_file",          # col 2  – Google Drive URL
    "has_tool_list",         # col 3
    "tool_list_files",       # col 4  – Google Drive URL
    "process_sheet_no",      # col 5
    "program_no",            # col 6
    "material_extension_mm", # col 7
    "setup_diagram_mm",      # col 8
    "cnc_machine_no",        # col 9
    "operation_no",          # col 10
    "setup_time",            # col 11
    "cycle_time",            # col 12
    "planned_output_8h",     # col 13
    "planned_output_10h",    # col 14
    "planned_output_12h",    # col 15
    "operation_type",        # col 16
    "quoted_ct_price",       # col 17
    "quoted_ct_price_2",     # col 18
    "cnc_machine_no_2",      # col 19
    "operation_no_2",        # col 20
    "part_number",           # col 21
    "verified_by",           # col 22
    "quoted_setup_price",    # col 23
    "kit_assembly_no",       # col 24
    "kit_assembly_number",   # col 25
    "ps_no",                 # col 26
    "date",                  # col 27
    "original_setup_time",   # col 28
]


def init_db():
    col_defs = ", ".join(f"{c} TEXT" for c in COLUMNS)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS tool_list (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                {col_defs},
                synced_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.commit()


def replace_all(rows):
    col_list    = ", ".join(COLUMNS)
    placeholders = ", ".join("?" * len(COLUMNS))
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM tool_list")
        conn.executemany(
            f"INSERT INTO tool_list ({col_list}) VALUES ({placeholders})",
            rows,
        )
        conn.commit()


def fetch_all(search=""):
    col_list = ", ".join(COLUMNS)
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        if search:
            q = f"%{search}%"
            rows = conn.execute(
                f"""
                SELECT id, {col_list}, synced_at FROM tool_list
                WHERE part_number    LIKE ?
                   OR program_no     LIKE ?
                   OR programmer_name LIKE ?
                   OR process_sheet_no LIKE ?
                   OR cnc_machine_no  LIKE ?
                ORDER BY id
                """,
                (q, q, q, q, q),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT id, {col_list}, synced_at FROM tool_list ORDER BY id"
            ).fetchall()
        return [dict(r) for r in rows]


def last_synced():
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT MAX(synced_at) FROM tool_list").fetchone()
        return row[0] if row else None
