# Create a Desktop shortcut for start_machine_planning.bat
# Usage:
#   powershell -File scripts\create_machine_planning_shortcut.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$Launcher = Join-Path $RepoRoot "start_machine_planning.bat"

if (-not (Test-Path $Launcher)) {
    throw "Missing $Launcher"
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Start Machine Planning.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $Launcher
$shortcut.WorkingDirectory = $RepoRoot
$shortcut.WindowStyle = 1
$shortcut.Description = "Start Machine Planning (Waitress + Cloudflare tunnel)"
$shortcut.IconLocation = "$env:SystemRoot\System32\imageres.dll,109"
$shortcut.Save()

Write-Host "Desktop shortcut created:"
Write-Host "  $ShortcutPath"
Write-Host ""
Write-Host "Double-click it to:"
Write-Host "  1. Start Waitress on port 5001 (if not already running)"
Write-Host "  2. Start Cloudflare tunnel (named domain if config.yml exists, else quick URL)"
