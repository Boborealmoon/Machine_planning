# Send daily planner Excel snapshot email. Schedule via install_planner_email_scheduler.ps1
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_planner_email.ps1
# Force send now:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_planner_email.ps1 -Force

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DayLog = Join-Path $LogDir ("planner-email-{0:yyyy-MM-dd}.log" -f (Get-Date))

$env:WERKZEUG_RUN_MAIN = "false"
$argsList = @("-u", (Join-Path $RepoRoot "scripts\send_planner_daily_email.py"))
if ($Force) { $argsList += "--force" }

$header = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] === Planner email run ==="
Write-Host $header
Add-Content -Path $DayLog -Value $header -Encoding utf8

& $VenvPython @argsList 2>&1 | Tee-Object -FilePath $DayLog -Append
exit $LASTEXITCODE
