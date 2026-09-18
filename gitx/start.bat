@echo off
cd /d %~dp0
echo Starting Gitx MCP server on port 8351...
set GITX_PORT=8351
set GIT_BINARY=C:\Program Files\Git\cmd\git.exe
start "Gitx MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8351
if %errorlevel%==0 (
  echo.
  echo Gitx server is RUNNING on 127.0.0.1:8351
  echo Tools: gitx_status / gitx_log / gitx_diff / gitx_show / gitx_blame / gitx_file_history / gitx_branch / gitx_stash / gitx_remote / gitx_commit
  echo Read-only-by-default: no push/force-push/reset --hard/clean -fdx/rebase (do those in your terminal).
) else (
  echo Failed to start. Check if port 8351 is occupied.
)
pause
