@echo off
setlocal
pushd "%~dp0"
if /I "%~1"=="repair" set "MISSION_AI_REPAIR_PAIR=true"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
set "mission_ai_exit=%ERRORLEVEL%"
if not "%mission_ai_exit%"=="0" (
  echo Mission AI installation failed. Review the message above.
  pause
)
popd
exit /b %mission_ai_exit%
