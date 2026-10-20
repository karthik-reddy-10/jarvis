@echo off
setlocal
cd /d "%~dp0"
title J.A.R.V.I.S. - Autonomous AI Assistant

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [JARVIS] First launch - installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
  )
)

echo.
echo ======================================================
echo   J.A.R.V.I.S. - Autonomous AI Assistant
echo   Local Address : http://localhost:3000
echo ======================================================
echo.

start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

node server.js
pause
