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
  echo Tools: find_files / find_recent / find_in_files / find_tool
  echo First index build runs in background; queries are fast once it finishes.
  echo Native indexer: src\native\findidx.exe ^(prebuilt^); rebuild with src\native\build.bat
) else (
  echo Failed to start. Check if port 8344 is occupied.
)
pause
