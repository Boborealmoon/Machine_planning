#!/usr/bin/env bash
# On-prem / remote ERP sync. Mac/Linux: chmod +x scripts/run_erp_sync.sh
# Run from repo root: ./scripts/run_erp_sync.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON="${REPO_ROOT}/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

mkdir -p logs
LOG="logs/erp-sync-$(date +%Y-%m-%d).log"
export WERKZEUG_RUN_MAIN=false

JSON_LOG="logs/erp-sync-runs/erp-sync-$(date +%Y%m%d-%H%M%S).json"
mkdir -p logs/erp-sync-runs
echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting ERP sync" | tee -a "$LOG"
if "$PYTHON" -u scripts/run_pp_staging_sync.py --log-file "$LOG" --json-log "$JSON_LOG" 2>&1 | tee -a "$LOG"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERP sync OK" | tee -a "$LOG"
else
  ec=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERP sync FAILED (exit $ec)" | tee -a "$LOG"
  exit "$ec"
fi
