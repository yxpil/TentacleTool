@echo off
cd /d %~dp0
echo Starting Stamp (Time & Scheduling) MCP server on port 8348...
set STAMP_PORT=8348
start "Stamp MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8348
if %errorlevel%==0 (
  echo.
  echo Stamp server is RUNNING on 127.0.0.1:8348
  echo Tools: stamp_now / stamp_convert / stamp_duration / stamp_zone / stamp_workday / stamp_cron
  echo Tip: call stamp_now first to calibrate the current time before any time-related task.
) else (
  echo Failed to start. Check if port 8348 is occupied.
)
pause
