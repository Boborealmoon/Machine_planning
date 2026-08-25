# Light WO qty poll (Option A). Schedule via install_wo_qty_poll_scheduler.ps1.
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_wo_qty_poll.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DayLog = Join-Path $LogDir ("wo-qty-poll-{0:yyyy-MM-dd}.log" -f (Get-Date))

$pollMutex = New-Object System.Threading.Mutex($false, "Global\MachinePlanning-WoQtyPoll")
$pollAcquired = $false
try {
    $pollAcquired = $pollMutex.WaitOne(0, $false)
} catch {
    $pollAcquired = $true
}
if (-not $pollAcquired) {
    $skip = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WO qty poll skipped - previous poll still running"
    Write-Host $skip
    Add-Content -Path $DayLog -Value $skip -Encoding utf8
    exit 0
}

$env:WERKZEUG_RUN_MAIN = "false"

try {
    $header = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] === WO qty poll ==="
    Write-Host $header
    Add-Content -Path $DayLog -Value $header -Encoding utf8

    & $VenvPython -u (Join-Path $RepoRoot "scripts\run_wo_qty_poll.py") 2>&1 |
        Tee-Object -FilePath $DayLog -Append

    if ($LASTEXITCODE -ne 0) {
        $fail = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WO qty poll FAILED (exit $LASTEXITCODE)"
        Write-Host $fail
        Add-Content -Path $DayLog -Value $fail -Encoding utf8
        exit $LASTEXITCODE
    }
    exit 0
}
finally {
    if ($pollAcquired) {
        try { $pollMutex.ReleaseMutex() } catch { }
    }
    try { $pollMutex.Dispose() } catch { }
}
