# Refresh the Auk access token. Schedule via install_auk_token_refresh_scheduler.ps1.
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_auk_token_refresh.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DayLog = Join-Path $LogDir ("auk-token-refresh-{0:yyyy-MM-dd}.log" -f (Get-Date))

$header = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] === Auk token refresh ==="
Write-Host $header
Add-Content -Path $DayLog -Value $header -Encoding utf8

& $VenvPython -u (Join-Path $RepoRoot "scripts\refresh_auk_token.py") 2>&1 |
    Tee-Object -FilePath $DayLog -Append
exit $LASTEXITCODE
