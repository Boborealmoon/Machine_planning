# Run the named Cloudflare tunnel for productionplannercoway.com (or your config.yml hostnames).
# Requires: C:\Users\<you>\.cloudflared\config.yml + credentials JSON
#
# Usage:
#   powershell -File scripts\start_named_tunnel.ps1

param(
    [string]$ConfigPath = (Join-Path $env:USERPROFILE ".cloudflared\config.yml"),
    [string]$TunnelName = "",
    [int]$MaxAttempts = 3
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$cloudflared = Join-Path $repoRoot ".tools\cloudflared.exe"

function Stop-AllCloudflared {
    Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "Stopping cloudflared (PID $($_.Id))..."
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}

function Read-TunnelNameFromConfig {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return "" }
    foreach ($line in Get-Content $Path -Encoding UTF8) {
        if ($line -match '^\s*tunnel:\s*(\S+)\s*$') {
            return $Matches[1]
        }
    }
    return ""
}

if (-not (Test-Path $cloudflared)) {
    Write-Host "Downloading cloudflared..."
    New-Item -ItemType Directory -Force -Path (Split-Path $cloudflared) | Out-Null
    Invoke-WebRequest `
        -Uri "https://github.com/cloudflare/cloudflared/releases/download/2026.5.0/cloudflared-windows-amd64.exe" `
        -OutFile $cloudflared `
        -UseBasicParsing
}

if (-not (Test-Path $ConfigPath)) {
    throw "Named tunnel config not found: $ConfigPath"
}

if (-not $TunnelName) {
    $TunnelName = Read-TunnelNameFromConfig -Path $ConfigPath
}
if (-not $TunnelName) {
    throw "Could not read tunnel name from $ConfigPath (expected line: tunnel: your-name)"
}

Write-Host "Named tunnel: $TunnelName"
Write-Host "Config:       $ConfigPath"
Write-Host "Ctrl+C to stop (productionplannercoway.com will go offline)"
Write-Host ""

Stop-AllCloudflared

$exitCode = 1
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if ($attempt -gt 1) {
        Write-Warning "Tunnel disconnected. Retry $attempt of $MaxAttempts in 3 seconds..."
        Stop-AllCloudflared
        Start-Sleep -Seconds 3
    }

    & $cloudflared tunnel --config $ConfigPath run $TunnelName
    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    if ($exitCode -eq 0) {
        exit 0
    }
}

Write-Host ""
Write-Host "Named tunnel failed after $MaxAttempts attempt(s) (exit $exitCode)." -ForegroundColor Red
Write-Host "Check:"
Write-Host "  - Waitress is listening on http://127.0.0.1:5001"
Write-Host "  - config.yml service URL matches your app port"
Write-Host "  - Internet / VPN / firewall allows cloudflared"
Write-Host ""
exit $exitCode
