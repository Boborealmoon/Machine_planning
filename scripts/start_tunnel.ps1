# Expose local Flask (default port 5000) via Cloudflare quick tunnel.
# Usage:
#   .\scripts\start_tunnel.ps1
#   .\scripts\start_tunnel.ps1 -Port 8080
param(
    [int]$Port = $(if ($env:FLASK_PORT) { [int]$env:FLASK_PORT } else { 5000 })
)

$repoRoot = Split-Path $PSScriptRoot -Parent
$cloudflared = Join-Path $repoRoot ".tools\cloudflared.exe"

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
& $cloudflared tunnel --url $target
