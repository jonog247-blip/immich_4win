@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Immich4Win - start Immich in the background, wait for it, then open the browser.
rem ASCII only, for cmd.exe portability.

set "PRODUCT=Immich4Win"
set "HERE=%~dp0"
set "EXE=%HERE%Immich.exe"

if not exist "%EXE%" goto no_exe

echo.
echo   Starting %PRODUCT% ...
echo.

rem "start --detached" is idempotent and returns 4 when Immich is already up,
rem so double-clicking this twice is harmless.
"%EXE%" start --detached --no-browser
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="4" goto ready
if not "%CODE%"=="0" goto failed

rem give the server a moment to accept connections
timeout /t 3 /nobreak >nul

:ready
set "URL="
for /f "usebackq delims=" %%L in (`""%EXE%" url 2^>nul"`) do set "URL=%%L"
if not defined URL (
  echo   Could not detect the web address - run "Immich.exe status" to see it.
  pause
  exit /b 0
)

echo   Opening !URL!
start "" "!URL!"
exit /b 0

:no_exe
echo.
echo   Immich.exe was not found next to this script.
echo   Expected: "%EXE%"
echo.
pause
exit /b 3

:failed
echo.
echo   Immich could not start. Run "Immich.exe doctor" for details.
echo.
pause
exit /b 1
