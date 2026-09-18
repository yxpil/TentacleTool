@echo off
cd /d %~dp0
echo Starting Analyze MCP server on port 8346...
set ANALYZE_PORT=8346
start "Analyze MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8346
if %errorlevel%==0 (
  echo.
  echo Analyze server is RUNNING on 127.0.0.1:8346
  echo Tools: analyze_build / analyze_find / analyze_refs / analyze_callers / analyze_deps / analyze_path / analyze_impact / analyze_stats
  echo First graph build runs on demand; later queries hit the memory/disk cache.
) else (
  echo Failed to start. Check if port 8346 is occupied.
)
pause
