@echo off
cd /d %~dp0
echo Starting KB (MySQL Knowledge Base) MCP server on port 8347...
set KB_PORT=8347
start "KB MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8347
if %errorlevel%==0 (
  echo.
  echo KB server is RUNNING on 127.0.0.1:8347
  echo.
  echo If you have not configured a database yet:
  echo   1. copy kb.config.example.json to kb.config.json
  echo   2. edit sources / knowledgeBases
  echo   3. or set KB_MYSQL_URL=mysql://user:pass@host:3306/dbname
  echo Then call the kb_config tool with refresh=true to reload.
) else (
  echo Failed to start. Check if port 8347 is occupied.
)
pause
