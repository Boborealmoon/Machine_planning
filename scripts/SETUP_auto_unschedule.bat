@echo off
REM Same as SETUP_auto_unschedule.bat in the repo root (run from either place).

cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_auto_unschedule_scheduler.ps1"
pause
