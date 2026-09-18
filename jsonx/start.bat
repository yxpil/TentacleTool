@echo off
cd /d %~dp0
echo Starting Jsonx (Data Format) MCP server on port 8349...
set JSONX_PORT=8349
start "Jsonx MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8349
if %errorlevel%==0 (
  echo.
  echo Jsonx server is RUNNING on 127.0.0.1:8349
  echo Tools: jsonx_parse / jsonx_convert / jsonx_query / jsonx_schema / jsonx_diff / jsonx_aggregate
  echo Tip: call jsonx_schema first when facing unknown data, then jsonx_query / jsonx_convert.
) else (
  echo Failed to start. Check if port 8349 is occupied.
)
pause
