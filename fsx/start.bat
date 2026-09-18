@echo off
cd /d %~dp0
echo Starting Fsx MCP server on port 8350...
set FSX_PORT=8350
start "Fsx MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8350
if %errorlevel%==0 (
  echo.
  echo Fsx server is RUNNING on 127.0.0.1:8350
  echo Tools: fsx_read / fsx_write / fsx_edit / fsx_list / fsx_tree / fsx_stat / fsx_grep / fsx_copy / fsx_move / fsx_delete
  echo fsx_delete is guarded: confirm=true required, recursive=true for dirs, system/home/drive-root protected.
) else (
  echo Failed to start. Check if port 8350 is occupied.
)
pause
