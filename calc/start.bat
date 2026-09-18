@echo off
cd /d %~dp0
echo Starting Calc MCP server on port 8345...
set CALC_PORT=8345
start "Calc MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8345
if %errorlevel%==0 (
  echo.
  echo Calc server is RUNNING on 127.0.0.1:8345
) else (
  echo Failed to start. Check if port 8345 is occupied.
)
pause
