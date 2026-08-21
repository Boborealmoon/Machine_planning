# Register Windows Task Scheduler: WO qty tracer every 5 minutes (shop-hours gated in Python).
# Easiest: double-click SETUP_erp_qty_tracer.bat in the repo root (one-time).
#
# Remove: Unregister-ScheduledTask -TaskName "MachinePlanning-WoQtyTracer" -Confirm:$false

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RunScript = Join-Path $RepoRoot "scripts\run_erp_qty_tracer.ps1"
$TaskName = "MachinePlanning-WoQtyTracer"

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
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
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
    -Description "Slim COMAIN WO qty tracer for ERP Scanned Output (every 5 min; shop hours gated in Python)" | Out-Null

Write-Host ""
Write-Host "Scheduled task registered: $TaskName"
Write-Host "  What it does:  Read current WO accepted qty from COMAIN and record increases"
Write-Host "                 on the ERP Scanned Output board. Not a full ERP sync."
Write-Host "  How often:     every 5 minutes (Python skips nights/weekends)"
Write-Host "  Shop hours:    Mon-Fri 08:00-20:30 Asia/Singapore (override with env)"
Write-Host "  Logs:          $RepoRoot\logs\erp-qty-tracer-YYYY-MM-DD.log"
Write-Host ""
Write-Host "Do not also set ENABLE_ERP_QTY_TRACER=1 in the Flask app — that would double-poll COMAIN."
Write-Host ""
Write-Host "To test right now:"
Write-Host "  powershell -File `"$RunScript`""
Write-Host ""
Write-Host "To turn off later:"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
