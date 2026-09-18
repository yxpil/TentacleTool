@echo off
cd /d %~dp0
echo Starting Search MCP server on port 8343...
set SEARCH_PORT=8343
start "Search MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8343
if %errorlevel%==0 (
  echo.
  echo Search server is RUNNING on 127.0.0.1:8343
) else (
  echo Failed to start. Check if port 8343 is occupied.
)
pause
