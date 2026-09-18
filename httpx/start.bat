@echo off
cd /d %~dp0
echo Starting Httpx MCP server on port 8352...
set HTTPX_PORT=8352
start "Httpx MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8352
if %errorlevel%==0 (
  echo.
  echo Httpx server is RUNNING on 127.0.0.1:8352
  echo Tools: httpx_request / httpx_download / httpx_head / httpx_batch / httpx_json / httpx_probe
  echo SSRF protection ON by default; use allowPrivate=true to reach internal hosts.
) else (
  echo Failed to start. Check if port 8352 is occupied.
)
pause
