@echo off
cd /d %~dp0
echo Starting Find MCP server on port 8344...
set FIND_PORT=8344
start "Find MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8344
if %errorlevel%==0 (
  echo.
  echo Find server is RUNNING on 127.0.0.1:8344
  echo First index build runs in background; queries will be fast once it finishes.
) else (
  echo Failed to start. Check if port 8344 is occupied.
)
pause
