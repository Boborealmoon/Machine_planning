"""Console + file progress logging for ERP staging sync."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


def progress_bar(completed: int, total: int, width: int = 32) -> str:
    if total <= 0:
        return "[" + ("-" * width) + "] 0/0"
    filled = min(width, max(0, int(width * completed / total)))
    return f"[{'#' * filled}{'-' * (width - filled)}] {completed}/{total}"


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class ErpSyncProgress:
    """Writes human-readable lines and an optional JSON run summary."""

    def __init__(
        self,
        *,
        log_file: Path | None = None,
        json_file: Path | None = None,
        stream: TextIO | None = None,
    ):
        self.log_file = log_file
        self.json_file = json_file
        self.stream = stream or sys.stdout
        self.started_at = datetime.now(timezone.utc)
        self.steps: list[dict[str, Any]] = []
        self._run_status = "running"

    def emit(self, line: str) -> None:
        text = line if line.endswith("\n") else line + "\n"
        self.stream.write(text)
        self.stream.flush()
        if self.log_file:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            with self.log_file.open("a", encoding="utf-8") as f:
                f.write(text)

    def run_start(self, steps: list[str], labels: dict[str, str]) -> None:
        names = [labels.get(s, s) for s in steps]
        self.emit(f"[{_ts()}] ERP sync started - {len(steps)} step(s)")
        for i, name in enumerate(names, 1):
            self.emit(f"[{_ts()}]   planned {i}/{len(steps)}: {name}")

    def step_start(self, index: int, total: int, step_id: str, label: str) -> None:
        bar = progress_bar(index - 1, total)
        self.emit(f"[{_ts()}] {bar} {label} ({step_id}) - running...")

    def step_end(
        self,
        index: int,
        total: int,
        step_id: str,
        label: str,
        result: dict,
    ) -> None:
        bar = progress_bar(index, total)
        entry: dict[str, Any] = {
            "step": step_id,
            "label": label,
            "index": index,
            "total": total,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            **{k: v for k, v in result.items() if k not in ("error",)},
        }
        if result.get("error"):
            entry["error"] = result["error"]
            status = "FAILED"
            self._run_status = "failed"
        elif result.get("skipped"):
            entry["skipped"] = True
            entry["reason"] = result.get("reason")
            status = f"SKIPPED ({result.get('reason', 'unknown')})"
        else:
            parts = []
            if result.get("row_count") is not None:
                parts.append(f"rows={result['row_count']}")
            if result.get("duration_ms") is not None:
                parts.append(f"{result['duration_ms']}ms")
            if result.get("reload"):
                parts.append(f"reload={result['reload']}")
            status = "OK" + (f" ({', '.join(parts)})" if parts else "")

        entry["status"] = status
        self.steps.append(entry)
        self.emit(f"[{_ts()}] {bar} {label} - {status}")

    def run_end(self, success: bool) -> None:
        finished = datetime.now(timezone.utc)
        duration_s = (finished - self.started_at).total_seconds()
        word = "complete" if success else "FAILED"
        self.emit(
            f"[{_ts()}] ERP sync {word} in {duration_s:.1f}s "
            f"({len(self.steps)} step record(s))"
        )
        if self.json_file:
            payload = {
                "started_at": self.started_at.isoformat(),
                "finished_at": finished.isoformat(),
                "duration_seconds": round(duration_s, 2),
                "success": success,
                "steps": self.steps,
            }
            self.json_file.parent.mkdir(parents=True, exist_ok=True)
            self.json_file.write_text(
                json.dumps(payload, indent=2, default=str),
                encoding="utf-8",
            )
