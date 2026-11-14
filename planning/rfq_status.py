"""Derived RFQ status. Nothing in here is stored."""
from __future__ import annotations

OWNERS = ("Operations", "Supply Chain", "Planning")
OWNER_CATEGORY = {
    "Operations": "ops",
    "Supply Chain": "supply_chain",
    "Planning": "planning",
    "—": "ready",
}


def line_status(lines, line) -> dict:
    """Same branches as the workflow sample: draft, quote, stale, TAT, ready."""
    parent = _parent(lines, line)
    quote = parent.get("quote") or None
    qty = line.get("qty")
    material = (line.get("material") or "").strip()
    rev = int(line.get("rev") or 1)
    if qty in (None, "", 0) or not material:
        return _status("Draft", "neutral", "Operations")
    state = (quote or {}).get("state") or "not_sent"
    if state != "quoted":
        if state == "rfq_sent":
            return _status("Awaiting supplier", "amber", "Supply Chain")
        return _status("To be quoted", "amber", "Supply Chain")
    confirmed = int((quote or {}).get("confirmed_rev") or 1)
    if confirmed < rev:
        return _status("Ops changed – SC reconfirm", "red", "Supply Chain")
    tat = line.get("tat") or {}
    if tat.get("days") is None:
        return _status("TAT pending", "blue", "Planning")
    tat_rev = int(tat.get("confirmed_rev") or 1)
    if tat_rev < rev:
        return _status("Ops changed – TAT reconfirm", "red", "Planning")
    return _status("Ready for Sales", "green", "—")


def rfq_status(lines) -> dict:
    """First open team in Operations, Supply Chain, Planning. Empty is still with Ops."""
    if not lines:
        return {
            "label": "Waiting on Operations",
            "tone": "neutral",
            "waiting_on": "Operations",
            "category": "ops",
            "ready": 0,
            "total": 0,
        }
    statuses = [line_status(lines, line) for line in lines]
    ready = sum(1 for item in statuses if item["waiting_on"] == "—")
    total = len(lines)
    if ready == total:
        return {
            "label": "Ready for Sales",
            "tone": "green",
            "waiting_on": "—",
            "category": "ready",
            "ready": ready,
            "total": total,
        }
    open_items = [item for item in statuses if item["waiting_on"] != "—"]
    owner = next(name for name in OWNERS if any(item["waiting_on"] == name for item in open_items))
    if any(item["tone"] == "red" for item in open_items):
        tone = "red"
    elif owner == "Supply Chain":
        tone = "amber"
    elif owner == "Planning":
        tone = "blue"
    else:
        tone = "neutral"
    return {
        "label": f"Waiting on {owner}",
        "tone": tone,
        "waiting_on": owner,
        "category": OWNER_CATEGORY[owner],
        "ready": ready,
        "total": total,
    }


def _parent(lines, line):
    ref = line.get("quote_ref_sn")
    if not ref:
        return line
    for item in lines:
        if item.get("sn") == ref:
            return item
    return line


def _status(label: str, tone: str, waiting_on: str) -> dict:
    return {
        "label": label,
        "tone": tone,
        "waiting_on": waiting_on,
        "category": OWNER_CATEGORY[waiting_on],
        "stale": label.startswith("Ops changed"),
    }
