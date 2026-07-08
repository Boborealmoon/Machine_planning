@echo off
REM One-click launcher: Waitress + Cloudflare tunnel (same as Desktop shortcut).
cd /d "%~dp0"
title Machine Planning
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_machine_planning.ps1"
if errorlevel 1 pause
