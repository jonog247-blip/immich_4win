@echo off
setlocal EnableExtensions

rem Immich4Win - start Immich natively on Windows 11 (no Docker).
rem Keep every value in this file ASCII so cmd.exe parses it under any code page.

set "PRODUCT=Immich4Win"
set "HERE=%~dp0"
set "EXE=%HERE%Immich.exe"

if not exist "%EXE%" goto no_exe

rem With no arguments this starts Immich in the background, waits for it and opens the browser.
rem The supervisor runs detached, so closing this window does not take the database down.
if "%~1"=="" goto background

if /I "%~1"=="--new-console" goto new_window

call :run %*
if errorlevel 1 goto failed
exit /b 0

:background
"%EXE%" start --detached
if errorlevel 4 goto already_running
if errorlevel 1 goto failed
timeout /t 3 /nobreak >nul
"%EXE%" open
exit /b 0

:already_running
echo   Immich is already running.
"%EXE%" open
exit /b 0

:new_window
shift
start "%PRODUCT%" "%EXE%" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b 0

:run
"%EXE%" %*
exit /b %ERRORLEVEL%

:no_exe
echo.
echo   Immich.exe was not found next to this script.
echo.
echo   Expected: "%EXE%"
echo   Run scripts\install.ps1 once from an elevated PowerShell, or keep every
echo   file of the portable build together in the same folder.
echo.
pause
exit /b 3

:failed
echo.
echo   Immich4Win exited with an error (see the messages above).
echo   Diagnostics:  Immich.exe doctor
echo   Logs:         "%LOCALAPPDATA%\Immich4Win\logs"
echo.
pause
exit /b 1
