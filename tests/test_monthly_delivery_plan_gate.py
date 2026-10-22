"""Password lock for the monthly delivery plan page and API."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app import PLANNER_SESSION_AT_KEY, PLANNER_SESSION_KEY, app


class MonthlyDeliveryPlanGateTests(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_page_and_api_stay_open_when_passcode_unset(self):
        with patch.dict(os.environ, {"MONTHLY_DELIVERY_PLAN_PASSCODE": "", "PLANNER_PASSCODE": ""}):
            page = self.client.get("/monthly-delivery-plan")
            gate = self.client.get("/monthly-delivery-plan-gate")

        self.assertEqual(page.status_code, 200)
        self.assertIn("Monthly Delivery Plan", page.get_data(as_text=True))
        self.assertEqual(gate.status_code, 200)
        self.assertIn("Passcode gate is not active", gate.get_data(as_text=True))

    def test_page_redirects_to_gate_when_passcode_set(self):
        with patch.dict(
            os.environ,
            {"MONTHLY_DELIVERY_PLAN_PASSCODE": "plan-secret", "PLANNER_PASSCODE": ""},
        ):
            response = self.client.get("/monthly-delivery-plan")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/monthly-delivery-plan-gate", response.headers["Location"])

    def test_api_requires_passcode_when_set(self):
        with patch.dict(
            os.environ,
            {"MONTHLY_DELIVERY_PLAN_PASSCODE": "plan-secret", "PLANNER_PASSCODE": ""},
        ):
            response = self.client.get("/api/monthly-delivery-plan")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Monthly delivery plan locked.")

    def test_wrong_passcode_is_rejected(self):
        with patch.dict(
            os.environ,
            {"MONTHLY_DELIVERY_PLAN_PASSCODE": "plan-secret", "PLANNER_PASSCODE": ""},
        ):
            response = self.client.post(
                "/monthly-delivery-plan-gate",
                data={"passcode": "nope", "next": "/monthly-delivery-plan"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertIn("Invalid passcode.", response.get_data(as_text=True))

    def test_correct_passcode_unlocks_page_and_api(self):
        env = {"MONTHLY_DELIVERY_PLAN_PASSCODE": "plan-secret", "PLANNER_PASSCODE": ""}
        with patch.dict(os.environ, env):
            unlocked = self.client.post(
                "/monthly-delivery-plan-gate",
                data={"passcode": "plan-secret", "next": "https://evil.example/monthly-delivery-plan"},
                follow_redirects=False,
            )
            self.assertEqual(unlocked.status_code, 302)
            location = unlocked.headers["Location"]
            self.assertTrue(location.startswith("/monthly-delivery-plan?mt="))
            self.assertNotIn("evil.example", location)
            self.assertIn("mdp_rt", unlocked.headers.get("Set-Cookie", ""))

            page = self.client.get("/monthly-delivery-plan")
            self.assertEqual(page.status_code, 200)

            class _Db:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            with patch(
                "planning.monthly_delivery_plan_route._load_outstanding",
                return_value=([], 0),
            ), patch(
                "planning.monthly_delivery_plan_route.planner_db",
                return_value=_Db(),
            ), patch(
                "planning.monthly_delivery_plan_route.load_commitments",
                return_value=[],
            ), patch(
                "planning.monthly_delivery_plan_route.load_okay_row_ids",
                return_value=set(),
            ), patch(
                "planning.monthly_delivery_plan_route.build_commitment_view",
                return_value={"lines": []},
            ):
                api = self.client.get("/api/monthly-delivery-plan")

        self.assertEqual(api.status_code, 200)
        self.assertEqual(api.get_json()["lines"], [])

    def test_planner_session_still_hits_the_delivery_plan_lock(self):
        with patch.dict(
            os.environ,
            {"MONTHLY_DELIVERY_PLAN_PASSCODE": "plan-secret", "PLANNER_PASSCODE": "planner"},
        ):
            with self.client.session_transaction() as sess:
                sess[PLANNER_SESSION_KEY] = True
                sess[PLANNER_SESSION_AT_KEY] = 9_999_999_999
            response = self.client.get("/monthly-delivery-plan")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/monthly-delivery-plan-gate", response.headers["Location"])


if __name__ == "__main__":
    unittest.main()
