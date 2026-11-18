@echo off
setlocal EnableExtensions

rem Immich4Win - show what is running.
rem ASCII only, for cmd.exe portability.

set "EXE=%~dp0Immich.exe"

if not exist "%EXE%" goto no_exe

"%EXE%" status
echo.
pause
exit /b 0

:no_exe
echo.
echo   Immich.exe was not found next to this script.
echo.
pause
exit /b 3
