"""Machine lane calculator — static archive tool for assignment what-ifs."""

from __future__ import annotations

from flask import Blueprint, render_template

machine_lane_calc_bp = Blueprint("machine_lane_calc", __name__)


@machine_lane_calc_bp.get("/archive/machine-lane-calc")
def machine_lane_calc_page():
    return render_template("archive/machine_lane_calc.html", active="machine_lane_calc")
