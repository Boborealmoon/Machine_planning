#!/usr/bin/env bash
# Slim WO qty tracer (COMAIN quantum → planner jumps). Not a full ERP sync.
# Use on a hosted Linux server via cron, e.g. every 5 minutes:
#   */5 * * * * cd /path/to/Machine_planning && ./scripts/run_erp_qty_tracer.sh
#
# From repo root: chmod +x scripts/run_erp_qty_tracer.sh && ./scripts/run_erp_qty_tracer.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON="${REPO_ROOT}/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

mkdir -p logs
LOG="logs/erp-qty-tracer-$(date +%Y-%m-%d).log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] WO qty tracer start" | tee -a "$LOG"
if "$PYTHON" -u scripts/run_erp_qty_tracer.py 2>&1 | tee -a "$LOG"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WO qty tracer OK" | tee -a "$LOG"
else
  ec=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WO qty tracer FAILED (exit $ec)" | tee -a "$LOG"
  exit "$ec"
fi
