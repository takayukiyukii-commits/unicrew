@echo off
REM UNICREW dev launcher (ASCII only)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0\.."

echo === Launching UNICREW dev server ===
echo (Closing this window will stop UNICREW)
echo.

REM kill stale unicrew.exe
taskkill /IM unicrew.exe /F >nul 2>&1

REM kill anything listening on 1420
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1420" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)

call npm run tauri:dev
