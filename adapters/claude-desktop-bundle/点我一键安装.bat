@echo off
chcp 65001 >nul
title Feibi + Claude Desktop - Install
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
