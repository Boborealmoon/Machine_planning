@echo off
REM OPTIONAL backup: Windows Task Scheduler every 2 minutes.
REM You do NOT need this if you reload the scheduler page (cleanup runs on reload).
REM Double-click only if you want cleanup while the page is closed.

cd /d "%~dp0"
echo.
echo  Machine Planning - auto-unschedule setup
echo  ========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_auto_unschedule_scheduler.ps1"
echo.
pause
