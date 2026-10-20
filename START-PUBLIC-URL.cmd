@echo off
title J.A.R.V.I.S. Cloudflare Public HTTPS Tunnel
color 0b
echo ========================================================
echo       J.A.R.V.I.S. PUBLIC SECURE HTTPS TUNNEL
echo ========================================================
echo.
echo Starting secure Cloudflare Tunnel for http://localhost:3000 ...
echo Your public HTTPS URL will appear below:
echo.

if not exist "%~dp0cloudflared.exe" (
    echo Downloading cloudflared.exe binary...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0cloudflared.exe'"
)

"%~dp0cloudflared.exe" tunnel --url http://localhost:3000
pause
