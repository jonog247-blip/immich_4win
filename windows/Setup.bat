@echo off
setlocal EnableExtensions

rem Immich4Win - one time setup. Double-click this first, then Immich.bat.
rem ASCII only, for cmd.exe portability.

title Immich4Win setup

set "HERE=%~dp0"
set "EXE=%HERE%Immich.exe"
set "SCRIPT=%HERE%scripts\install.ps1"

echo.
echo   ============================================
echo    Immich4Win - first time setup
echo   ============================================
echo.
echo   This downloads the Windows programs Immich needs
echo   (about 700 MB) and checks them. You do not need
echo   to be an administrator.
echo.

if not exist "%SCRIPT%" goto no_script
if not exist "%EXE%" goto no_exe

rem Already set up? Say so instead of downloading again.
"%EXE%" doctor --json >"%TEMP%\immich4win-doctor.json" 2>nul
if not errorlevel 1 goto maybe_done

:run
echo   Starting setup. This can take a while; progress is shown below.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "CODE=%ERRORLEVEL%"
echo.

if "%CODE%"=="0" goto success

echo   Setup finished with problems (see above).
echo.
echo   Run this file again to retry: finished steps are kept.
echo   For details:  Immich.exe doctor
echo.
pause
exit /b %CODE%

:maybe_done
echo   Everything already looks installed.
echo.
set /p "ANSWER=  Re-check with setup anyway? [y/N] "
if /I not "%ANSWER%"=="y" goto ready
goto run

:success
echo   ============================================
echo    Setup complete
echo   ============================================
echo.
echo   Starting Immich now.
echo.
call "%HERE%Start-Immich.bat"
echo.
echo   Next time, just double-click Immich.bat
echo.
pause
exit /b 0

:ready
echo   Setup is already complete. Double-click Immich.bat to start.
echo.
pause
exit /b 0

:no_script
echo   scripts\install.ps1 is missing from this folder.
echo   Unzip the whole Immich4Win folder again, keeping every subfolder.
echo.
pause
exit /b 3

:no_exe
echo   Immich.exe is missing from this folder.
echo   Unzip the whole Immich4Win folder again, keeping every subfolder.
echo.
pause
exit /b 3
