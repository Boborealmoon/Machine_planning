"""Tests for Day/Night HOTO ops queue grouping."""

import unittest

from planning.shift_management_service import (
    classify_board_attention,
    group_ops_machines,
    machine_ticket_totals,
    match_queue_job,
    process_sheet_autofill,
    process_sheet_match_keys,
)


class GroupOpsMachinesTests(unittest.TestCase):
    def test_puts_jobs_under_machine_and_flags_idle(self):
        machines = [
            {"machine_id": 2, "machine_no": "CNC 20", "machine_category": "Turning"},
            {"machine_id": 1, "machine_no": "CNC 10", "machine_category": "Milling"},
        ]
        blocks = [
            {
                "machine_id": 1,
                "machine_no": "CNC 10",
                "process_sheet_no": "PS-100",
                "queue_position": 1,
                "remaining_qty": 16,
                "job_no": "J-100",
            },
            {
                "machine_id": 1,
                "machine_no": "CNC 10",
                "process_sheet_no": "PS-101",
                "queue_position": 2,
            },
        ]
        grouped = group_ops_machines(
            machines,
            blocks,
            handovers_by_machine={1: {"status": "draft", "priority": "Normal"}},
            ticket_counts={(1, "PS-100"): 2},
            machine_ticket_counts={1: 2, 2: 0},
        )

        self.assertEqual([row["machine_no"] for row in grouped], ["CNC 10", "CNC 20"])
        busy, idle = grouped
        self.assertEqual(busy["queue_count"], 2)
        self.assertEqual(busy["active_process_sheet"], "PS-100")
        self.assertEqual(busy["active_job_no"], "J-100")
        self.assertEqual(busy["queue_remaining_qty"], 16)
        self.assertEqual(busy["jobs"][0]["open_ticket_count"], 2)
        self.assertEqual(busy["jobs"][1]["open_ticket_count"], 0)
        self.assertEqual(busy["handover"]["status"], "draft")
        self.assertEqual(busy["open_ticket_count"], 2)
        self.assertEqual(idle["jobs"], [])
        self.assertIsNone(idle["handover"])
        self.assertEqual(idle["queue_count"], 0)

    def test_sorts_open_tickets_ahead_of_other_busy_machines(self):
        machines = [
            {"machine_id": 1, "machine_no": "CNC 10"},
            {"machine_id": 2, "machine_no": "CNC 20"},
        ]
        blocks = [
            {"machine_id": 1, "process_sheet_no": "PS-A", "queue_position": 1},
            {"machine_id": 2, "process_sheet_no": "PS-B", "queue_position": 1},
        ]
        grouped = group_ops_machines(
            machines,
            blocks,
            {},
            {(2, "PS-B"): 1},
            {1: 0, 2: 1},
        )
        self.assertEqual([row["machine_no"] for row in grouped], ["CNC 20", "CNC 10"])

    def test_uses_queue_total_when_jobs_are_truncated(self):
        machines = [{"machine_id": 1, "machine_no": "CNC 10"}]
        blocks = [
            {
                "machine_id": 1,
                "process_sheet_no": "PS-A",
                "queue_position": 1,
                "queue_total": 9,
            }
        ]
        grouped = group_ops_machines(machines, blocks, {}, {}, {})
        self.assertEqual(grouped[0]["queue_count"], 9)
        self.assertEqual(len(grouped[0]["jobs"]), 1)

    def test_handles_empty_fleet(self):
        self.assertEqual(group_ops_machines([], [], {}, {}, {}), [])

    def test_machine_ticket_totals_sums_ps_keys(self):
        self.assertEqual(
            machine_ticket_totals({(1, "PS-A"): 2, (1, "PS-B"): 1, (2, ""): 3}),
            {1: 3, 2: 3},
        )


class BoardAttentionTests(unittest.TestCase):
    def test_empty_board_has_no_sections(self):
        out = classify_board_attention([], [])
        self.assertEqual(out["pending_ack"], [])
        self.assertEqual(out["disputed"], [])
        self.assertEqual(out["issues"], [])
        self.assertEqual(out["tickets"], [])

    def test_drops_clean_drafts_and_acked_rows(self):
        out = classify_board_attention(
            [
                {
                    "handover_id": 1,
                    "status": "draft",
                    "priority": "Normal",
                    "machine_status": "Running",
                    "ncr_status": "N/A",
                },
                {
                    "handover_id": 2,
                    "status": "acknowledged",
                    "priority": "Normal",
                    "machine_status": "Idle",
                    "ncr_status": "Closed",
                },
            ],
            [{"ticket_id": 9, "status": "closed"}],
        )
        self.assertEqual(out["pending_ack"], [])
        self.assertEqual(out["issues"], [])
        self.assertEqual(out["tickets"], [])

    def test_keeps_actionable_handovers_and_open_tickets(self):
        pending = {"handover_id": 3, "status": "pending_ack", "machine_no": "CNC 10"}
        disputed = {"handover_id": 4, "status": "disputed", "machine_no": "CNC 11"}
        breakdown = {
            "handover_id": 5,
            "status": "draft",
            "machine_status": "Breakdown",
            "priority": "Normal",
            "machine_no": "CNC 12",
        }
        out = classify_board_attention(
            [pending, disputed, breakdown],
            [
                {"ticket_id": 1, "status": "open", "title": "Tooling"},
                {"ticket_id": 2, "status": "closed", "title": "Done"},
            ],
        )
        self.assertEqual([h["handover_id"] for h in out["pending_ack"]], [3])
        self.assertEqual([h["handover_id"] for h in out["disputed"]], [4])
        self.assertEqual([h["handover_id"] for h in out["issues"]], [5])
        self.assertEqual(out["issues"][0]["issue_labels"], ["Breakdown"])
        self.assertEqual([t["ticket_id"] for t in out["tickets"]], [1])


class ProcessSheetSearchTests(unittest.TestCase):
    def test_match_keys_normalize_partials_and_case(self):
        keys = process_sheet_match_keys("NPS26-0150::2", "nps26-0150")
        self.assertIn("nps26-0150", keys)
        self.assertIn("nps26-0150::2", keys)

    def test_matches_queue_job_by_process_sheet_or_job_no(self):
        jobs = [
            {"process_sheet_no": "NPS26-0150", "job_no": "NPS26-0150", "remaining_qty": 12, "block_id": 9},
            {"process_sheet_no": "APS26-0001", "job_no": "APS26-0001::2", "remaining_qty": 4},
        ]
        hit = match_queue_job(jobs, "nps26-0150")
        self.assertEqual(hit["block_id"], 9)
        self.assertEqual(match_queue_job(jobs, "APS26-0001::2")["remaining_qty"], 4)
        self.assertIsNone(match_queue_job(jobs, "NPS99-9999"))

    def test_autofill_prefers_queue_qty_then_last_handover_then_sheet(self):
        item = {"display_qty": 40, "process_sheet_no": "NPS26-0150"}
        from_sheet = process_sheet_autofill(item)
        self.assertEqual(from_sheet["remaining_qty"], 40)
        self.assertFalse(from_sheet["on_queue"])

        from_last = process_sheet_autofill(
            item,
            last_handover={"remaining_qty": 18, "tool_life_pct": 55, "material_qty": 3, "material_unit": "bar"},
        )
        self.assertEqual(from_last["remaining_qty"], 18)
        self.assertEqual(from_last["tool_life_pct"], 55)
        self.assertEqual(from_last["material_unit"], "bar")

        from_queue = process_sheet_autofill(
            item,
            queue_job={"remaining_qty": 7, "block_id": 11, "operation_name": "OP 40"},
            last_handover={"remaining_qty": 18, "tool_life_pct": 55},
        )
        self.assertEqual(from_queue["remaining_qty"], 7)
        self.assertTrue(from_queue["on_queue"])
        self.assertEqual(from_queue["block_id"], 11)
        self.assertEqual(from_queue["operation_name"], "OP 40")
        self.assertEqual(from_queue["tool_life_pct"], 55)


if __name__ == "__main__":
    unittest.main()
