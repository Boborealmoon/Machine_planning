# Register Windows Task Scheduler job: WO qty poll every 5 minutes.
# The Python job no-ops outside weekdays 07:00-19:00 so COMAIN is not hit off-shift.
# Run from repo root (Admin NOT required if using current user only):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_wo_qty_poll_scheduler.ps1
#
# Remove: Unregister-ScheduledTask -TaskName "MachinePlanning-WoQtyPoll" -Confirm:$false

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PollScript = Join-Path $RepoRoot "scripts\run_wo_qty_poll.ps1"
$TaskName = "MachinePlanning-WoQtyPoll"

if (-not (Test-Path $PollScript)) {
    throw "Missing $PollScript"
}

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Warning "No .venv found at $RepoRoot - create it before the first scheduled run:"
    Write-Warning "  py -3.14 -m venv .venv   (or: python -m venv .venv)"
    Write-Warning "  .\.venv\Scripts\pip install -r requirements.txt"
}

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Write-Host "Removing existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PollScript`"" `
    -WorkingDirectory $RepoRoot

# Every 5 minutes. The Python poll itself no-ops on nights and weekends
# (weekdays 07:00-19:00) so we never hit COMAIN off-shift.
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$Trigger.RepetitionInterval = (New-TimeSpan -Minutes 5)
$Trigger.RepetitionDuration = (New-TimeSpan -Days 9999)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "COMAIN WO qty poll for ERP Scanned Output (every 5 min; Python skips nights/weekends)" | Out-Null

Write-Host ""
Write-Host "Scheduled task registered: $TaskName"
Write-Host "  Interval:       every 5 minutes (Python skips nights and weekends)"
Write-Host "  Script:         $PollScript"
Write-Host "  Logs:           $RepoRoot\logs\wo-qty-poll-YYYY-MM-DD.log"
Write-Host ""
Write-Host "Test now:  powershell -File `"$PollScript`""
Write-Host "View task: taskschd.msc -> Task Scheduler Library -> $TaskName"
Write-Host "Remove:    Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
