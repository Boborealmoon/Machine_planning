#!/usr/bin/env bash
# Move DONE planner ops off machine lanes (planner DB only — not ERP sync).
# Use on a hosted Linux server via cron, e.g. every 2 minutes:
#   */2 * * * * cd /path/to/Machine_planning && ./scripts/run_auto_unschedule.sh
#
# From repo root: chmod +x scripts/run_auto_unschedule.sh && ./scripts/run_auto_unschedule.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON="${REPO_ROOT}/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

mkdir -p logs
LOG="logs/auto-unschedule-$(date +%Y-%m-%d).log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] auto-unschedule start" | tee -a "$LOG"
if "$PYTHON" -u scripts/auto_unschedule_done_ops.py 2>&1 | tee -a "$LOG"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] auto-unschedule OK" | tee -a "$LOG"
else
  ec=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] auto-unschedule FAILED (exit $ec)" | tee -a "$LOG"
  exit "$ec"
fi
