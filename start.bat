@echo off
REM Starts the Tonic Launcher: API on 5050, UI on 5173.
cd /d "%~dp0"
if not exist node_modules (
  echo Dependencies not installed. Running npm run install-all...
  call npm run install-all || goto :fail
)
start "" http://localhost:5173
call npm run dev
goto :eof

:fail
echo.
echo Install failed. Fix the error above and run this file again.
pause
