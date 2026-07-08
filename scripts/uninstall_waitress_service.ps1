# Remove the Machine Planning Waitress Windows service.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_waitress_service.ps1

param(
    [string]$ServiceName = "MachinePlanning-Web"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$NssmExe = Join-Path $RepoRoot ".tools\nssm.exe"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Error "Run this script in an elevated PowerShell (Run as administrator)."
    exit 1
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Service '$ServiceName' is not installed."
    exit 0
}

if (-not (Test-Path $NssmExe)) {
  Write-Error "NSSM not found at $NssmExe — install the service first or remove via services.msc"
  exit 1
}

if ($existing.Status -eq "Running") {
    & $NssmExe stop $ServiceName confirm
    Start-Sleep -Seconds 2
}

& $NssmExe remove $ServiceName confirm
Write-Host "Removed service '$ServiceName'."
