#!/usr/bin/env bash
# Revert load-time performance changes. Run from repo root:
#   ./scripts/rollback_load_perf.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG="perf-before-load-redundancies"
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG not found. Try: git checkout main -- <files>" >&2
  exit 1
fi

echo "Restoring files from tag $TAG ..."
git checkout "$TAG" -- \
  static/js/scheduler/api.js \
  static/js/scheduler/actuals.js \
  static/js/scheduler/render.js \
  static/js/actual_production.js \
  static/js/process_sheets.js \
  planning/process_sheets.py \
  planning/machines.py \
  planning/gantt_route.py \
  planning/program_tool_list_route.py \
  app.py \
  templates/scheduler.html

echo "Done. Review with git status."
