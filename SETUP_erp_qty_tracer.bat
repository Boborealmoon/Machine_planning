@echo off
REM Windows Task Scheduler: WO qty tracer every 5 minutes (shop-hours gated).
REM This is NOT a full ERP sync. Double-click once to install.

cd /d "%~dp0"
echo.
echo  Machine Planning - WO qty tracer setup
echo  ======================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_erp_qty_tracer_scheduler.ps1"
echo.
pause
