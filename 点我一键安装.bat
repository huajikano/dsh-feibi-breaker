@echo off
rem ---------------------------------------------------------------------------
rem  feibi-breaker installer launcher.
rem
rem  ASCII ONLY and CRLF ONLY on purpose: see tools\write-launchers.mjs.
rem  Zero interaction: no "set /p", no "pause". The profile is chosen by
rem  scripts\lib\profile.js (--profile, then $DSH_PROFILE, then every live
rem  profile; snapshot directories are excluded).
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ===== feibi-breaker installer =====
echo.

set "ARGS="
if not "%~1"=="" set "ARGS=-Profile "%~1""

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %ARGS%
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" goto failed
echo Done. Restart DeepSeek-Harness to apply.
goto hold

:failed
echo Finished with exit code %CODE%. See the report above.

:hold
rem A double-click closes the console as soon as the script ends; hold it for a
rem few seconds so the report stays readable. No keypress is required.
echo %cmdcmdline% | find /i "/c" >nul
if errorlevel 1 exit /b %CODE%
echo Window closes in 10 seconds...
ping -n 11 127.0.0.1 >nul
exit /b %CODE%
