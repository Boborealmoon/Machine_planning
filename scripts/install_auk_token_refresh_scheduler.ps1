# Register Windows Task Scheduler job: Auk login every 6 hours.
# The job signs in with AUK_USERNAME / AUK_PASSWORD from .env and replaces
# AUK_ACCESS_TOKEN. The planner also runs the same refresh in-process.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_auk_token_refresh_scheduler.ps1
#
# Remove: Unregister-ScheduledTask -TaskName "MachinePlanning-AukTokenRefresh" -Confirm:$false

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RefreshScript = Join-Path $RepoRoot "scripts\run_auk_token_refresh.ps1"
$TaskName = "MachinePlanning-AukTokenRefresh"

if (-not (Test-Path $RefreshScript)) {
    throw "Missing $RefreshScript"
}

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Write-Host "Removing existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RefreshScript`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 6) `
    -RepetitionDuration (New-TimeSpan -Days 9999)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Sign in to Auk and replace AUK_ACCESS_TOKEN every 6 hours" | Out-Null

Write-Host ""
Write-Host "Scheduled task registered: $TaskName"
Write-Host "  Interval: every 6 hours"
Write-Host "  Script:   $RefreshScript"
Write-Host "  Logs:     $RepoRoot\logs\auk-token-refresh-YYYY-MM-DD.log"
Write-Host ""
Write-Host "Requires AUK_USERNAME and AUK_PASSWORD in .env"
Write-Host "Test now:  powershell -File `"$RefreshScript`""
Write-Host "Remove:    Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
