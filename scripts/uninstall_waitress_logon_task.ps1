# Remove the Waitress logon scheduled task.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_waitress_logon_task.ps1

param(
    [string]$TaskName = "MachinePlanning-Web"
)

$ErrorActionPreference = "Stop"

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Existing) {
    Write-Host "Task '$TaskName' is not installed."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed logon task '$TaskName'."
