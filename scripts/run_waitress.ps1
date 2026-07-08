# Run Machine Planning with Waitress (foreground). Use before installing the Windows service.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_waitress.ps1
#   powershell -File scripts\run_waitress.ps1 -Port 5001 -Threads 8

param(
    [int]$Port = $(if ($env:WAITRESS_PORT) { [int]$env:WAITRESS_PORT } elseif ($env:FLASK_PORT) { [int]$env:FLASK_PORT } else { 5001 }),
    [int]$Threads = $(if ($env:WAITRESS_THREADS) { [int]$env:WAITRESS_THREADS } else { 12 })
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Warning "No .venv at $RepoRoot — create one first:"
    Write-Warning "  py -3.12 -m venv .venv"
    Write-Warning "  .\.venv\Scripts\pip install -r requirements.txt"
    $VenvPython = "python"
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Error "Port $Port is already in use. Stop the other process or pick -Port."
    exit 1
}

if (-not (Test-Path (Join-Path $RepoRoot ".env"))) {
    Write-Warning ".env not found — copy .env.example to .env and fill in secrets before production use."
}

$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$env:FLASK_ENV = if ($env:FLASK_ENV) { $env:FLASK_ENV } else { "production" }
$env:WAITRESS_PORT = "$Port"
$env:WAITRESS_THREADS = "$Threads"
$env:WAITRESS_HOST = if ($env:WAITRESS_HOST) { $env:WAITRESS_HOST } else { "127.0.0.1" }
$env:WAITRESS_LOG_FILE = if ($env:WAITRESS_LOG_FILE) { $env:WAITRESS_LOG_FILE } else { "logs/waitress.log" }

Write-Host "Starting Waitress on http://$($env:WAITRESS_HOST):$Port (threads=$Threads)"
Write-Host "Repo: $RepoRoot"
Write-Host "Ctrl+C to stop"
Write-Host ""

& $VenvPython serve.py
