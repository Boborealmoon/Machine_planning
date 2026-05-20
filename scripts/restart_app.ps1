# Stop any Flask listeners on port 5001 and start a fresh app.py.
$Port = if ($env:FLASK_PORT) { [int]$env:FLASK_PORT } else { 5001 }
$repoRoot = Split-Path $PSScriptRoot -Parent

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2

$still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($still) {
    Write-Error "Port $Port is still in use. Close the remaining process and retry."
    exit 1
}

Write-Host "Starting Flask on port $Port from $repoRoot"
Set-Location $repoRoot
$env:FLASK_PORT = "$Port"
python app.py
