# Start Waitress at Windows logon (no Administrator required).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_waitress_logon_task.ps1
#
# Remove: powershell -File scripts\uninstall_waitress_logon_task.ps1

param(
    [string]$TaskName = "MachinePlanning-Web"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$RunScript = Join-Path $RepoRoot "scripts\run_waitress.ps1"
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
$LogDir = Join-Path $RepoRoot "logs"

if (-not (Test-Path $RunScript)) {
    throw "Missing $RunScript"
}

if (-not (Test-Path $VenvPython)) {
    throw @"
Missing virtualenv at $VenvPython
Create it first:
  py -3.12 -m venv .venv
  .\.venv\Scripts\pip install -r requirements.txt
"@
}

& $VenvPython -c "import waitress" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing Python dependencies..."
    & $VenvPython -m pip install -r (Join-Path $RepoRoot "requirements.txt")
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Write-Host "Removing existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunScript`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Machine Planning Waitress web server (starts at user logon, no admin)" | Out-Null

Write-Host ""
Write-Host "Logon task registered: $TaskName"
Write-Host "  Starts:         when $env:USERNAME logs on"
Write-Host "  Script:         $RunScript"
Write-Host "  Logs:           serve.py output -> console (hidden); ERP logs in $LogDir"
Write-Host ""
Write-Host "Start now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Stop:       Get-NetTCPConnection -LocalPort 5001 -State Listen | %% { Stop-Process -Id `$_.OwningProcess -Force }"
Write-Host "Status:     Get-ScheduledTask -TaskName $TaskName"
Write-Host "Remove:     powershell -File scripts\uninstall_waitress_logon_task.ps1"
Write-Host ""
Write-Host "For a true Windows Service (survives without login), run install_waitress_service.ps1 as Administrator."
