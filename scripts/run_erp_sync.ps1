# On-prem ERP sync (Option A). Schedule via install_erp_sync_scheduler.ps1 (weekdays 08:00, 13:00).
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_erp_sync.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$LogDir = Join-Path $RepoRoot "logs"
$RunDir = Join-Path $LogDir "erp-sync-runs"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$DayLog = Join-Path $LogDir ("erp-sync-{0:yyyy-MM-dd}.log" -f (Get-Date))
$LatestLog = Join-Path $LogDir "last_staging_sync.log"
$LegacyLatestLog = Join-Path $LogDir "erp-sync-latest.log"
$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RunLog = Join-Path $RunDir "erp-sync-$RunStamp.log"
$JsonLog = Join-Path $RunDir "erp-sync-$RunStamp.json"

# Skip if another sync is already running (scheduled + manual overlap)
$mutex = New-Object System.Threading.Mutex($false, "Global\MachinePlanning-ErpSync")
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0, $false)
} catch {
    $acquired = $true
}
if (-not $acquired) {
    $skip = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERP sync skipped - already in progress"
    Write-Host $skip
    Add-Content -Path $DayLog -Value $skip -Encoding utf8
    exit 0
}

function Update-LatestLog {
    param([string]$SourcePath)
    if (-not (Test-Path $SourcePath)) { return }
    foreach ($dest in @($LatestLog, $LegacyLatestLog)) {
        $tmp = "$dest.$RunStamp.tmp"
        try {
            Copy-Item -Path $SourcePath -Destination $tmp -Force
            if (Test-Path $dest) { Remove-Item -Path $dest -Force -ErrorAction SilentlyContinue }
            Move-Item -Path $tmp -Destination $dest -Force
        } catch {
            Write-Warning "Could not update $dest (close it in your editor if open). Full log: $SourcePath"
            if (Test-Path $tmp) { Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue }
        }
    }
}

$env:WERKZEUG_RUN_MAIN = "false"

try {
    $header = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] === ERP sync run $RunStamp ==="
    Write-Host $header
    Add-Content -Path $DayLog -Value $header -Encoding utf8
    Add-Content -Path $RunLog -Value $header -Encoding utf8

    & $VenvPython -u (Join-Path $RepoRoot "scripts\run_pp_staging_sync.py") `
        --log-file $DayLog `
        --json-log $JsonLog 2>&1 | Tee-Object -FilePath $RunLog -Append

    if ($LASTEXITCODE -ne 0) {
        $fail = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERP sync FAILED (exit $LASTEXITCODE)"
        Write-Host $fail
        Add-Content -Path $DayLog -Value $fail -Encoding utf8
        Add-Content -Path $RunLog -Value $fail -Encoding utf8
        Update-LatestLog -SourcePath $RunLog
        exit $LASTEXITCODE
    }

    $ok = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERP sync OK - json: $JsonLog"
    Write-Host $ok
    Add-Content -Path $DayLog -Value $ok -Encoding utf8
    Add-Content -Path $RunLog -Value $ok -Encoding utf8
    Update-LatestLog -SourcePath $RunLog
    exit 0
}
finally {
    if ($acquired) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    try { $mutex.Dispose() } catch { }
}
