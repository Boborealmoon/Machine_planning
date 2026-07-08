# Start Machine Planning for daily use:
#   1. Ensure Waitress is listening on port 5001
#   2. Open Cloudflare quick tunnel (shows public URL in this window)
#
# Usage:
#   powershell -File scripts\start_machine_planning.ps1
#   powershell -File scripts\create_machine_planning_shortcut.ps1   # desktop shortcut

param(
    [int]$Port = $(if ($env:WAITRESS_PORT) { [int]$env:WAITRESS_PORT } elseif ($env:FLASK_PORT) { [int]$env:FLASK_PORT } else { 5001 })
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$TaskName = "MachinePlanning-Web"
$TunnelScript = Join-Path $RepoRoot "scripts\start_tunnel.ps1"
$NamedTunnelScript = Join-Path $RepoRoot "scripts\start_named_tunnel.ps1"
$CloudflaredConfig = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$RunWaitressScript = Join-Path $RepoRoot "scripts\run_waitress.ps1"

Set-Location $RepoRoot

trap {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

function Test-PortListening {
    param([int]$ListenPort)
    return [bool](Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue)
}

function Wait-PortListening {
    param([int]$ListenPort, [int]$TimeoutSec = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -ListenPort $ListenPort) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

Write-Host "=== Machine Planning ==="
Write-Host "Repo: $RepoRoot"
Write-Host ""

if (Test-PortListening -ListenPort $Port) {
    Write-Host "Waitress already listening on port $Port."
} else {
    Write-Host "Starting web server on port $Port..."
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Start-ScheduledTask -TaskName $TaskName | Out-Null
        if (-not (Wait-PortListening -ListenPort $Port)) {
            Write-Warning "Scheduled task did not open port $Port in time; starting Waitress in a new window..."
            Start-Process powershell -WindowStyle Minimized -ArgumentList @(
                "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", "`"$RunWaitressScript`"", "-Port", "$Port"
            )
            if (-not (Wait-PortListening -ListenPort $Port)) {
                throw "Could not start Waitress on port $Port. Check logs\waitress.log"
            }
        }
    } elseif (Test-Path $RunWaitressScript) {
        Start-Process powershell -WindowStyle Minimized -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", "`"$RunWaitressScript`"", "-Port", "$Port"
        )
        if (-not (Wait-PortListening -ListenPort $Port)) {
            throw "Could not start Waitress on port $Port."
        }
    } else {
        throw "No Waitress launcher found. Run scripts\install_waitress_logon_task.ps1 first."
    }
    Write-Host "Waitress is up: http://127.0.0.1:$Port/planner"
}

$useNamedTunnel = (Test-Path $CloudflaredConfig) -and (Test-Path $NamedTunnelScript)
if ($useNamedTunnel) {
    Write-Host "Starting named Cloudflare tunnel (productionplannercoway.com)..."
    Write-Host "Local planner: http://127.0.0.1:$Port/planner"
    Write-Host "Public URL:    https://productionplannercoway.com/planner"
    Write-Host "Press Ctrl+C to stop the tunnel only (Waitress keeps running)."
    Write-Host ""
    $tunnelRunner = $NamedTunnelScript
} else {
    Write-Host "Starting Cloudflare quick tunnel (public URL appears below)..."
    Write-Host "Local planner: http://127.0.0.1:$Port/planner"
    Write-Host "Press Ctrl+C to stop the tunnel only (Waitress keeps running)."
    Write-Host ""
    if (-not (Test-Path $TunnelScript)) {
        throw "Missing $TunnelScript"
    }
    $tunnelRunner = $TunnelScript
}

try {
    if ($useNamedTunnel) {
        & $tunnelRunner
    } else {
        & $tunnelRunner -Port $Port
    }
    $tunnelExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    if ($tunnelExit -ne 0) {
        throw @"
Cloudflare tunnel exited with code $tunnelExit.
Ensure Waitress is running on port $Port, close other tunnel windows, then try again.
"@
    }
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}
