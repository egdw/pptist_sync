@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0一键打包-RK3588.ps1" %*
if errorlevel 1 (
  echo.
  echo Packaging failed. See the message above.
  pause
  exit /b 1
)
echo.
echo Packaging completed.
pause
