@echo off
setlocal
set "PYTHON_EXE=%~dp0..\newplugin-server\.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
  echo Backend environment is missing.
  echo Run: %~dp0..\newplugin-server\setup_environment.bat
  pause
  exit /b 1
)
rem Run Python from the sibling server folder so cache never enters the extension.
set "PYTHONDONTWRITEBYTECODE=1"
cd /d "%~dp0..\newplugin-server"

echo Starting Comic Slice Receiver at http://127.0.0.1:8000
echo Coordinate indexes and slices will be saved under: %~dp0captures
echo Press Ctrl+C to stop.
"%PYTHON_EXE%" -B -m uvicorn capture_server:app --host 127.0.0.1 --port 8000
pause
