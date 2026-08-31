"""Tooling / program flags fan out across BOM steps of the same process sheet."""

from __future__ import annotations

from datetime import date

from planning.process_sheets import (
    _apply_ready_exceptions_to_ps_op_keys,
    _readiness_source_ps_base,
    _ready_exception_bases_from_operation_rows,
    _update_program,
    _update_tooling,
    collapse_block_ready_flags_by_source_ps,
)


def test_readiness_source_ps_base_strips_partial_suffix():
    assert _readiness_source_ps_base("NPS26-0353") == "NPS26-0353"
    assert _readiness_source_ps_base("NPS26-0353::2") == "NPS26-0353"
    assert _readiness_source_ps_base("[Temp] NPS26-0353") == "[Temp] NPS26-0353"


def test_collapse_block_ready_flags_shares_exception_across_bom_steps():
    blocks = [
        {
            "operation_id": 11,
            "source_ps_id": "NPS26-0353",
            "source_op_seq_id": 20,
            "tooling_ready": False,
            "program_ready": True,
        },
        {
            "operation_id": 12,
            "source_ps_id": "NPS26-0353::2",
            "source_op_seq_id": 30,
            "tooling_ready": True,
            "program_ready": False,
        },
        {
            "operation_id": 99,
            "source_ps_id": "NPS26-0999",
            "source_op_seq_id": 20,
            "tooling_ready": True,
            "program_ready": True,
        },
    ]
    collapse_block_ready_flags_by_source_ps(blocks)
    assert blocks[0]["tooling_ready"] is False
    assert blocks[1]["tooling_ready"] is False
    assert blocks[0]["program_ready"] is False
    assert blocks[1]["program_ready"] is False
    assert blocks[2]["tooling_ready"] is True
    assert blocks[2]["program_ready"] is True


def test_catalog_keys_inherit_source_ps_tooling_exception():
    tokens = [("NPS26-0353", 20), ("NPS26-0353", 30), ("NPS26-0999", 20)]
    bases = _ready_exception_bases_from_operation_rows(
        [
            {"source_ps_id": "NPS26-0353", "source_op_seq_id": 20, "tooling_ready": False},
            {"source_ps_id": "NPS26-0353::2", "source_op_seq_id": 30, "tooling_ready": True},
            {"source_ps_id": "NPS26-0999", "source_op_seq_id": 20, "tooling_ready": True},
        ],
        "tooling_ready",
    )
    out = _apply_ready_exceptions_to_ps_op_keys(tokens, bases)
    assert out[("NPS26-0353", 20)] is False
    assert out[("NPS26-0353", 30)] is False
    assert out[("NPS26-0999", 20)] is True


class _FakeCursor:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _FakeCon:
    def __init__(self, ops):
        self.ops = {int(op["operation_id"]): dict(op) for op in ops}
        self.updated_ids = None
        self.last_sql = ""

    def execute(self, sql, params=None):
        self.last_sql = " ".join(str(sql).split())
        sql_l = self.last_sql.lower()
        params = params or ()
        if sql_l.startswith("update planner_operation"):
            ready = bool(params[0])
            ids = [int(i) for i in params[2]]
            self.updated_ids = ids
            col = "tooling_ready" if "tooling_ready" in sql_l else "program_ready"
            date_col = f"{col}_date"
            for op_id in ids:
                row = self.ops.get(op_id)
                if not row:
                    continue
                row[col] = ready
                row[date_col] = None if ready else date(2026, 8, 29)
            return _FakeCursor([])
        if "from planner_operation" in sql_l and "where operation_id = %s" in sql_l:
            op_id = int(params[0])
            row = self.ops.get(op_id)
            return _FakeCursor([row] if row else [])
        if "split_part" in sql_l:
            source_base = params[0]
            matched = [
                {
                    "operation_id": op["operation_id"],
                    "source_ps_id": op.get("source_ps_id"),
                    "job_no": op.get("job_no"),
                }
                for op in self.ops.values()
                if _readiness_source_ps_base(op.get("source_ps_id") or op.get("job_no")) == source_base
            ]
            return _FakeCursor(matched)
        if "where source_ps_id = %s" in sql_l and "source_op_seq_id" in sql_l:
            ps_id, seq_id = params[0], int(params[1])
            matched = [
                op
                for op in self.ops.values()
                if op.get("source_ps_id") == ps_id and int(op.get("source_op_seq_id") or 0) == seq_id
            ]
            matched.sort(key=lambda row: int(row["operation_id"]), reverse=True)
            return _FakeCursor(matched[:1])
        return _FakeCursor([])


def test_update_tooling_fans_out_to_all_bom_steps(monkeypatch):
    monkeypatch.setattr("planning.process_sheets._ensure_tooling_columns", lambda _con: None)
    con = _FakeCon(
        [
            {
                "operation_id": 11,
                "source_ps_id": "NPS26-0353",
                "source_op_seq_id": 20,
                "job_no": "NPS26-0353",
                "tooling_ready": True,
                "tooling_ready_date": None,
            },
            {
                "operation_id": 12,
                "source_ps_id": "NPS26-0353::2",
                "source_op_seq_id": 30,
                "job_no": "NPS26-0353::2",
                "tooling_ready": True,
                "tooling_ready_date": None,
            },
            {
                "operation_id": 99,
                "source_ps_id": "NPS26-0999",
                "source_op_seq_id": 20,
                "job_no": "NPS26-0999",
                "tooling_ready": True,
                "tooling_ready_date": None,
            },
        ]
    )
    payload, err = _update_tooling(con, False, operation_id=11)
    assert err is None
    assert payload["tooling_ready"] is False
    assert sorted(con.updated_ids) == [11, 12]
    assert con.ops[11]["tooling_ready"] is False
    assert con.ops[12]["tooling_ready"] is False
    assert con.ops[99]["tooling_ready"] is True


def test_update_program_fans_out_to_all_bom_steps(monkeypatch):
    monkeypatch.setattr("planning.process_sheets._ensure_program_columns", lambda _con: None)
    con = _FakeCon(
        [
            {
                "operation_id": 21,
                "source_ps_id": "NPS26-0353",
                "source_op_seq_id": 20,
                "job_no": "NPS26-0353",
                "program_ready": True,
                "program_ready_date": None,
            },
            {
                "operation_id": 22,
                "source_ps_id": "NPS26-0353",
                "source_op_seq_id": 40,
                "job_no": "NPS26-0353",
                "program_ready": True,
                "program_ready_date": None,
            },
        ]
    )
    payload, err = _update_program(con, False, operation_id=21)
    assert err is None
    assert payload["program_ready"] is False
    assert sorted(con.updated_ids) == [21, 22]
    assert con.ops[21]["program_ready"] is False
    assert con.ops[22]["program_ready"] is False
