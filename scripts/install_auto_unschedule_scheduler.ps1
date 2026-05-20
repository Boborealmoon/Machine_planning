# Register Windows Task Scheduler: auto-unschedule DONE ops every 2 minutes.
# Easiest: double-click SETUP_auto_unschedule.bat in the repo root (one-time).
#
# Remove: Unregister-ScheduledTask -TaskName "MachinePlanning-AutoUnschedule" -Confirm:$false

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RunScript = Join-Path $RepoRoot "scripts\run_auto_unschedule.ps1"
$TaskName = "MachinePlanning-AutoUnschedule"

if (-not (Test-Path $RunScript)) {
    throw "Missing $RunScript"
}

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Write-Host "Removing existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunScript`"" `
    -WorkingDirectory $RepoRoot

$StartAt = (Get-Date).AddMinutes(1)
$Trigger = New-ScheduledTaskTrigger -Once -At $StartAt `
    -RepetitionInterval (New-TimeSpan -Minutes 2) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

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
    -Description "Move DONE planner ops off machine lanes back to catalog (anchor preserved)" | Out-Null

Write-Host ""
Write-Host "Done. Optional backup only — the scheduler already runs this on each full page reload."
Write-Host ""
Write-Host "Scheduled task: $TaskName"
Write-Host "  What it does:  When an op on a machine lane is fully DONE (output complete),"
Write-Host "                 it is moved back to the sidebar. Anchor time is kept."
Write-Host "  How often:     every 2 minutes (starts about 1 minute from now)"
Write-Host "  Logs:          $RepoRoot\logs\auto-unschedule-YYYY-MM-DD.log"
Write-Host ""
Write-Host "You can skip this task if you reload the planner page regularly or host the site"
Write-Host "so users open it in a browser (reload triggers the same cleanup)."
Write-Host ""
Write-Host "To test right now:"
Write-Host "  powershell -File `"$RunScript`""
Write-Host ""
Write-Host "To turn off later:"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
