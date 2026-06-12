# Register Windows Task Scheduler job: ERP sync at fixed daily times.
# Run from repo root (Admin NOT required if using current user only):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_erp_sync_scheduler.ps1
#
# Remove: Unregister-ScheduledTask -TaskName "MachinePlanning-ErpSync" -Confirm:$false

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SyncScript = Join-Path $RepoRoot "scripts\run_erp_sync.ps1"
$TaskName = "MachinePlanning-ErpSync"

if (-not (Test-Path $SyncScript)) {
    throw "Missing $SyncScript"
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
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$SyncScript`"" `
    -WorkingDirectory $RepoRoot

# Once daily at 08:00 (local time)
$SyncTimes = @("08:00")
$Triggers = $SyncTimes | ForEach-Object {
    New-ScheduledTaskTrigger -Daily -At $_
}

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Triggers `
    -Settings $Settings `
    -Principal $Principal `
    -Description "COMAIN to Supabase ERP sync for Machine Planning (daily 08:00)" | Out-Null

Write-Host ""
Write-Host "Scheduled task registered: $TaskName"
Write-Host "  Times:          $($SyncTimes -join ', ')"
Write-Host "  Script:         $SyncScript"
Write-Host "  Logs:           $RepoRoot\logs\last_staging_sync.log"
Write-Host ""
Write-Host "Test now:  powershell -File `"$SyncScript`""
Write-Host "View task: taskschd.msc -> Task Scheduler Library -> $TaskName"
Write-Host "Remove:    Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
