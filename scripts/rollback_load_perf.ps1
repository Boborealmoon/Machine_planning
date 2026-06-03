# Revert load-time performance changes from branch perf/load-time-redundancies.
# Usage (from repo root):
#   .\scripts\rollback_load_perf.ps1           # reset working tree to tag
#   .\scripts\rollback_load_perf.ps1 -Branch   # also switch back to previous branch

param(
    [switch]$Branch
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

$tag = "perf-before-load-redundancies"
if (-not (git rev-parse $tag 2>$null)) {
    Write-Error "Tag '$tag' not found. Roll back manually with: git checkout main -- <files>"
    exit 1
}

$prevBranch = git branch --show-current
Write-Host "Restoring files from tag $tag ..."
git checkout $tag -- `
    static/js/scheduler/api.js `
    static/js/scheduler/actuals.js `
    static/js/scheduler/render.js `
    static/js/actual_production.js `
    static/js/process_sheets.js `
    planning/process_sheets.py `
    planning/machines.py `
    planning/gantt_route.py `
    planning/program_tool_list_route.py `
    app.py `
    templates/scheduler.html 2>$null

if ($LASTEXITCODE -ne 0) {
    Write-Warning "Some paths may differ; try full reset: git reset --hard $tag"
}

if ($Branch -and $prevBranch -and $prevBranch -ne "perf/load-time-redundancies") {
    git checkout $prevBranch
}

Write-Host "Done. Review with 'git status', then commit or discard as needed."
