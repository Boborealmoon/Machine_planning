# Return DONE machine-lane blocks to the catalog (anchor preserved).
# The Flask app also runs this every 2 minutes while app.py is up.
# Schedule standalone runs: scripts\install_auto_unschedule_scheduler.ps1
#
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_auto_unschedule.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DayLog = Join-Path $LogDir ("auto-unschedule-{0:yyyy-MM-dd}.log" -f (Get-Date))

$mutex = New-Object System.Threading.Mutex($false, "Global\MachinePlanning-AutoUnschedule")
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0, $false)
} catch {
    $acquired = $true
}
if (-not $acquired) {
    $skip = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] auto-unschedule skipped - already in progress"
    Write-Host $skip
    Add-Content -Path $DayLog -Value $skip -Encoding utf8
    exit 0
}

try {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] auto-unschedule start"
    Write-Host $line
    Add-Content -Path $DayLog -Value $line -Encoding utf8

    $output = & $VenvPython (Join-Path $RepoRoot "scripts\auto_unschedule_done_ops.py") 2>&1
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
