@echo off
cd /d %~dp0
echo Starting WebView MCP server on port 8342...
set WEBVIEW_PORT=8342
start "WebView MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8342
if %errorlevel%==0 (
  echo.
  echo WebView server is RUNNING on 127.0.0.1:8342
) else (
  echo Failed to start. Check if port 8342 is occupied.
)
pause
