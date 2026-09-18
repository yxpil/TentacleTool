@echo off
cd /d %~dp0
echo Starting Cryptox MCP server on port 8353...
set CRYPTOX_PORT=8353
start "Cryptox MCP" /min node src\index.js
timeout /t 2 /nobreak >nul
netstat -ano | findstr :8353
if %errorlevel%==0 (
  echo.
  echo Cryptox server is RUNNING on 127.0.0.1:8353
  echo Tools: cryptox_hash / cryptox_hmac / cryptox_checksum / cryptox_encode / cryptox_decode / cryptox_jwt
  echo        cryptox_uuid / cryptox_password / cryptox_cipher
  echo cryptox_cipher uses AES-256-GCM with PBKDF2-SHA256 key derivation; salt/iv/tag are stored in the envelope.
) else (
  echo Failed to start. Check if port 8353 is occupied.
)
pause
