@echo off
cd /d %~dp0
echo Starting NetON MCP server on port 8341...
set NETON_PORT=8341
start "NetON MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8341
if %errorlevel%==0 (
  echo.
  echo NetON server is RUNNING on 127.0.0.1:8341
  echo Tools: device_discovery / network_scan / port_scan / port_analyze / protocol_analyze / packet_capture
  echo Note: packet_capture in pktmon mode requires an elevated (Administrator) shell.
) else (
  echo Failed to start. Check if port 8341 is occupied.
)
pause
