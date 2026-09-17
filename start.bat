@echo off
cd /d C:\Users\yxpil\Desktop\NetON
echo Starting NetON MCP server on port 8341...
set NETON_PORT=8341
start "NetON MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8341
if %errorlevel%==0 (
  echo.
  echo NetON server is RUNNING on 127.0.0.1:8341
) else (
  echo Failed to start. Check if port 8341 is occupied.
)
pause
