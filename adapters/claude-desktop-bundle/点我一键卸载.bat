@echo off
chcp 65001 >nul
title Feibi + Claude Desktop - Uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
