# Slim WO qty tracer: detect accepted-qty scans every 5 minutes during shop hours.
# This is NOT a full ERP sync. Schedule: scripts\install_erp_qty_tracer_scheduler.ps1
#
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_erp_qty_tracer.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DayLog = Join-Path $LogDir ("erp-qty-tracer-{0:yyyy-MM-dd}.log" -f (Get-Date))

$mutex = New-Object System.Threading.Mutex($false, "Global\MachinePlanning-WoQtyTracer")
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0, $false)
} catch {
    $acquired = $true
}
if (-not $acquired) {
    $skip = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WO qty tracer skipped - already in progress"
    Write-Host $skip
    Add-Content -Path $DayLog -Value $skip -Encoding utf8
    exit 0
}

try {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WO qty tracer start"
    Write-Host $line
    Add-Content -Path $DayLog -Value $line -Encoding utf8

    $output = & $VenvPython (Join-Path $RepoRoot "scripts\run_erp_qty_tracer.py") 2>&1
    $output | ForEach-Object {
        $entry = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $_"
        Write-Host $entry
        Add-Content -Path $DayLog -Value $entry -Encoding utf8
    }
    exit $LASTEXITCODE
} finally {
    if ($acquired) {
        try { $mutex.ReleaseMutex() } catch { }
    }
}
