@echo off
setlocal EnableExtensions

rem Immich4Win - stop every component and the background supervisor.
rem ASCII only, for cmd.exe portability.

set "EXE=%~dp0Immich.exe"

if not exist "%EXE%" goto no_exe

echo.
"%EXE%" stop
echo.
timeout /t 3 /nobreak >nul
exit /b 0

:no_exe
echo.
echo   Immich.exe was not found next to this script.
echo   Expected: "%EXE%"
echo.
pause
exit /b 3
