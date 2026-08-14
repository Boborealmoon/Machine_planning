"""Tests for Day/Night HOTO ops queue grouping."""

import unittest

from planning.shift_management_service import group_ops_machines


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
        self.assertEqual(busy["jobs"][0]["open_ticket_count"], 2)
        self.assertEqual(busy["jobs"][1]["open_ticket_count"], 0)
        self.assertEqual(busy["handover"]["status"], "draft")
        self.assertEqual(busy["open_ticket_count"], 2)
        self.assertEqual(idle["jobs"], [])
        self.assertIsNone(idle["handover"])
        self.assertEqual(idle["queue_count"], 0)

    def test_handles_empty_fleet(self):
        self.assertEqual(group_ops_machines([], [], {}, {}, {}), [])


if __name__ == "__main__":
    unittest.main()
