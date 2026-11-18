@echo off
setlocal EnableExtensions

rem Immich4Win - check every dependency and setting.
rem ASCII only, for cmd.exe portability.

set "EXE=%~dp0Immich.exe"

if not exist "%EXE%" goto no_exe

"%EXE%" doctor
echo.
pause
exit /b 0

:no_exe
echo.
echo   Immich.exe was not found next to this script.
echo.
pause
exit /b 3
