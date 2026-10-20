@echo off
title J.A.R.V.I.S. Core OS
color 0B
echo ======================================================
echo   STARTING J.A.R.V.I.S. ULTIMATE LOCAL DESKTOP SERVER
echo ======================================================
echo.
cd /d "%~dp0"
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)
echo Launching J.A.R.V.I.S. HUD at http://localhost:3000 ...
start http://localhost:3000
node server.js
pause
