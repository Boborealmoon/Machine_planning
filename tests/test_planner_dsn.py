"""Planner DSN rewrite: session-mode pooler (5432) ? transaction mode (6543)."""
from __future__ import annotations

import unittest

from db import dsn_is_session_pooler, normalize_planner_dsn, planner_db_connect_error


SESSION_DSN = (
    "postgresql://postgres.abc:secret@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
)
TX_DSN = (
    "postgresql://postgres.abc:secret@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"
)
DIRECT_DSN = "postgresql://postgres.abc:secret@db.abc.supabase.co:5432/postgres"


class PlannerDsnTests(unittest.TestCase):
    def test_rewrites_session_pooler_to_transaction_port(self):
        self.assertTrue(dsn_is_session_pooler(SESSION_DSN))
        self.assertEqual(normalize_planner_dsn(SESSION_DSN), TX_DSN)
        self.assertFalse(dsn_is_session_pooler(TX_DSN))

    def test_leaves_transaction_pooler_unchanged(self):
        self.assertEqual(normalize_planner_dsn(TX_DSN), TX_DSN)

    def test_leaves_direct_db_host_unchanged(self):
        self.assertFalse(dsn_is_session_pooler(DIRECT_DSN))
        self.assertEqual(normalize_planner_dsn(DIRECT_DSN), DIRECT_DSN)

    def test_can_keep_session_mode(self):
        self.assertEqual(
            normalize_planner_dsn(SESSION_DSN, use_transaction_pooler=False),
            SESSION_DSN,
        )

    def test_preserves_userinfo_and_query(self):
        dsn = (
            "postgresql://postgres.abc:p%40ss@aws-0-ap-southeast-1.pooler.supabase.com"
            ":5432/postgres?sslmode=require"
        )
        out = normalize_planner_dsn(dsn)
        self.assertIn(":6543/", out)
        self.assertIn("p%40ss", out)
        self.assertTrue(out.endswith("sslmode=require"))

    def test_emaxconnsession_has_friendly_message(self):
        exc = RuntimeError(
            'connection to server at "aws-1-ap-southeast-1.pooler.supabase.com" '
            "(54.179.210.0), port 5432 failed: FATAL: (EMAXCONNSESSION) max clients "
            "reached in session mode - max clients are limited to pool_size: 15"
        )
        msg = planner_db_connect_error(exc) or ""
        self.assertIn("connection limit", msg.lower())
        self.assertIn("6543", msg)
