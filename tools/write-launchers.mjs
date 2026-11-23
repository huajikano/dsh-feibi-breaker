// Emit the two launcher .bat files as pure ASCII with CRLF line endings.
//
// cmd.exe parses a .bat with the console OEM code page and expects CRLF; a
// UTF-8 / LF-only file gets split mid-line and its fragments are executed as
// commands ("'m' is not recognized..."). The Chinese UI text lives in the
// Node and PowerShell halves, which are BOM-marked and run under chcp 65001.
//
// The launchers are also **zero-input**: no `set /p`, no `pause`. A one-click
// installer that asks which profile is not one click, so the profile is
// resolved inside scripts/lib/profile.js instead.
import { writeFileSync } from 'node:fs'

const BODY = (kind, script) => `@echo off
rem ---------------------------------------------------------------------------
rem  feibi-breaker ${kind} launcher.
rem
rem  ASCII ONLY and CRLF ONLY on purpose: see tools\\write-launchers.mjs.
rem  Zero interaction: no "set /p", no "pause". The profile is chosen by
rem  scripts\\lib\\profile.js (--profile, then $DSH_PROFILE, then every live
rem  profile; snapshot directories are excluded).
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ===== feibi-breaker ${kind} =====
echo.

set "ARGS="
if not "%~1"=="" set "ARGS=-Profile "%~1""

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${script}" %ARGS%
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
`

const files = [
  ['点我一键安装.bat', BODY('installer', 'install.ps1')],
  ['点我一键卸载.bat', BODY('uninstaller', 'uninstall.ps1')],
]

for (const [name, text] of files) {
  const bytes = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'ascii')
  writeFileSync(name, bytes)
  const nonAscii = [...bytes].filter((byte) => byte > 0x7f).length
  console.log(`${name}: ${bytes.length} bytes, nonAscii=${nonAscii}`)
}
