# Expose local Waitress (default port 5001) via Cloudflare quick tunnel.
# Usage:
#   .\scripts\start_tunnel.ps1
#   .\scripts\start_tunnel.ps1 -Port 8080
param(
    [int]$Port = $(if ($env:FLASK_PORT) { [int]$env:FLASK_PORT } else { 5001 }),
    [int]$MaxAttempts = 3
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$cloudflared = Join-Path $repoRoot ".tools\cloudflared.exe"

function Stop-RepoCloudflared {
    if (-not (Test-Path $cloudflared)) { return }
    $repoBinary = (Resolve-Path $cloudflared).Path
    Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $repoBinary) } |
        ForEach-Object {
            Write-Host "Stopping previous cloudflared (PID $($_.ProcessId))..."
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    Start-Sleep -Seconds 2
}

if (-not (Test-Path $cloudflared)) {
    Write-Host "Downloading cloudflared..."
    New-Item -ItemType Directory -Force -Path (Split-Path $cloudflared) | Out-Null
    Invoke-WebRequest `
        -Uri "https://github.com/cloudflare/cloudflared/releases/download/2026.5.0/cloudflared-windows-amd64.exe" `
        -OutFile $cloudflared `
        -UseBasicParsing
}

$target = "http://127.0.0.1:$Port"
Write-Host "Tunneling $target (Ctrl+C to stop)"
Write-Host ""
Write-Host "Tunnel URL is a different browser origin than localhost - hard-refresh (Ctrl+F5) on the"
Write-Host "trycloudflare.com tab after code changes."
Write-Host ""

Stop-RepoCloudflared

$exitCode = 1
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if ($attempt -gt 1) {
        Write-Host ""
        Write-Warning "Tunnel start failed. Retry $attempt of $MaxAttempts in 3 seconds..."
        Stop-RepoCloudflared
        Start-Sleep -Seconds 3
    }

    & $cloudflared tunnel --url $target
    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    if ($exitCode -eq 0) {
        exit 0
    }
}

Write-Host ""
Write-Host "Cloudflare quick tunnel failed after $MaxAttempts attempt(s) (exit $exitCode)." -ForegroundColor Red
Write-Host "Common fixes:"
Write-Host "  - Close any other Machine Planning tunnel windows, then run again"
Write-Host "  - Check internet / VPN / firewall"
Write-Host "  - Wait a minute and retry (Cloudflare trycloudflare.com can be flaky)"
Write-Host ""
exit $exitCode
