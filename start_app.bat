@echo off
REM Legacy dev server — prefer start_machine_planning.bat (Waitress + tunnel).
cd /d "%~dp0"
call .venv\Scripts\activate
python app.py
