# Install Machine Planning as a Windows service (Waitress via NSSM).
# Run from repo root in an elevated PowerShell (Run as administrator):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_waitress_service.ps1
#
# Remove: powershell -File scripts\uninstall_waitress_service.ps1

param(
    [string]$ServiceName = "MachinePlanning-Web"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$ToolsDir = Join-Path $RepoRoot ".tools"
$NssmExe = Join-Path $ToolsDir "nssm.exe"
$LogDir = Join-Path $RepoRoot "logs"
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"

function Ensure-Nssm {
    if (Test-Path $NssmExe) { return }

    $zipUrl = "https://nssm.cc/release/nssm-2.24.zip"
    $zipPath = Join-Path $ToolsDir "nssm.zip"
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

    Write-Host "Downloading NSSM..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

    $extractRoot = Join-Path $ToolsDir "nssm-extract"
    if (Test-Path $extractRoot) { Remove-Item -Recurse -Force $extractRoot }
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

    $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
    $candidate = Get-ChildItem -Path $extractRoot -Recurse -Filter "nssm.exe" |
        Where-Object { $_.FullName -match [regex]::Escape($arch) } |
        Select-Object -First 1
    if (-not $candidate) {
        $candidate = Get-ChildItem -Path $extractRoot -Recurse -Filter "nssm.exe" | Select-Object -First 1
    }
    if (-not $candidate) {
        throw "Could not find nssm.exe inside downloaded archive."
    }

    Copy-Item -Path $candidate.FullName -Destination $NssmExe -Force
    Remove-Item -Recurse -Force $extractRoot, $zipPath -ErrorAction SilentlyContinue
    Write-Host "NSSM installed at $NssmExe"
}

function Read-DotEnvValue {
    param([string]$Key)
    $envFile = Join-Path $RepoRoot ".env"
    if (-not (Test-Path $envFile)) { return $null }
    foreach ($line in Get-Content $envFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)\s*$") {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2) {
                if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
            }
            return $value
        }
    }
    return $null
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Error "Run this script in an elevated PowerShell (Run as administrator)."
    exit 1
}

if (-not (Test-Path $VenvPython)) {
    throw @"
Missing virtualenv at $VenvPython
Create it first:
  py -3.12 -m venv .venv
  .\.venv\Scripts\pip install -r requirements.txt
"@
}

if (-not (Test-Path (Join-Path $RepoRoot "serve.py"))) {
    throw "Missing serve.py in $RepoRoot"
}

if (-not (Test-Path (Join-Path $RepoRoot ".env"))) {
    Write-Warning ".env not found - copy .env.example to .env before production use."
}

& $VenvPython -c "import waitress" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing Python dependencies..."
    & $VenvPython -m pip install -r (Join-Path $RepoRoot "requirements.txt")
}

Ensure-Nssm
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stdoutLog = Join-Path $LogDir "waitress-stdout.log"
$stderrLog = Join-Path $LogDir "waitress-stderr.log"

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing service '$ServiceName'..."
    if ($existing.Status -eq "Running") {
        & $NssmExe stop $ServiceName confirm
        Start-Sleep -Seconds 2
    }
    & $NssmExe remove $ServiceName confirm
    Start-Sleep -Seconds 1
}

Write-Host "Installing service '$ServiceName'..."
& $NssmExe install $ServiceName $VenvPython "serve.py"
& $NssmExe set $ServiceName AppDirectory $RepoRoot
& $NssmExe set $ServiceName DisplayName "Machine Planning Web (Waitress)"
& $NssmExe set $ServiceName Description "Production HTTP server for Machine Planning planner app"
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName AppStdout $stdoutLog
& $NssmExe set $ServiceName AppStderr $stderrLog
& $NssmExe set $ServiceName AppStdoutCreationDisposition 4
& $NssmExe set $ServiceName AppStderrCreationDisposition 4
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateOnline 1
& $NssmExe set $ServiceName AppRotateBytes 10485760

# Production defaults; serve.py also reads WAITRESS_* / FLASK_PORT from .env
$flaskEnv = Read-DotEnvValue "FLASK_ENV"
if (-not $flaskEnv) { $flaskEnv = "production" }
& $NssmExe set $ServiceName AppEnvironmentExtra "FLASK_ENV=$flaskEnv"

& $NssmExe start $ServiceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$port = Read-DotEnvValue "WAITRESS_PORT"
if (-not $port) { $port = Read-DotEnvValue "FLASK_PORT" }
if (-not $port) { $port = "5001" }
$hostAddr = Read-DotEnvValue "WAITRESS_HOST"
if (-not $hostAddr) { $hostAddr = "127.0.0.1" }

Write-Host ""
Write-Host "Service installed: $ServiceName"
Write-Host "  Status:         $($svc.Status)"
Write-Host "  Listen:         http://${hostAddr}:$port"
Write-Host "  App directory:  $RepoRoot"
Write-Host "  Logs:           $stdoutLog"
Write-Host "                  $stderrLog"
Write-Host ""
Write-Host "Manage:"
Write-Host "  Start:   nssm start $ServiceName"
Write-Host "  Stop:    nssm stop $ServiceName"
Write-Host "  Restart: nssm restart $ServiceName"
Write-Host "  Status:  Get-Service $ServiceName"
Write-Host ""
Write-Host "Pair with Cloudflare tunnel (scripts/start_tunnel.ps1) or reverse proxy on port $port."

if ($svc.Status -ne "Running") {
    Write-Warning ("Service is not running. Check " + $stderrLog)
    exit 1
}
