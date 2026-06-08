# Register Windows Task Scheduler job: daily planner email every minute (script self-gates on configured time).
# Run from repo root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_planner_email_scheduler.ps1
#
# Remove: Unregister-ScheduledTask -TaskName "MachinePlanning-PlannerEmail" -Confirm:$false

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RunScript = Join-Path $RepoRoot "scripts\run_planner_email.ps1"
$TaskName = "MachinePlanning-PlannerEmail"

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

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)

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
    -Description "Send daily production planner Excel snapshot email at configured time (SGT)."

Write-Host "Registered scheduled task '$TaskName' (checks every minute; send time is configured in /planner-email)."
