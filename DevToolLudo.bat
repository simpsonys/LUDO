@echo off
chcp 65001 >nul
setlocal

:: ============================================================
::  LUDO 개발 도구 - PowerShell shim
:: ============================================================

set "PS_EXE=powershell"
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
)

set "PS_SCRIPT=%~dp0DevToolLudo.ps1"

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

endlocal
exit /b %ERRORLEVEL%
