@echo off
REM Web2MD Native Messaging Host Installer for Windows
REM Usage: install.bat <chrome-extension-id>

setlocal

set HOST_NAME=com.web2md.agent
set SCRIPT_DIR=%~dp0
set HOST_PATH=%SCRIPT_DIR%dist\native-host.js

if "%~1"=="" (
    echo Usage: install.bat ^<chrome-extension-id^>
    echo.
    echo To find your extension ID:
    echo   1. Open chrome://extensions
    echo   2. Enable Developer Mode
    echo   3. Find Web2MD and copy the ID
    exit /b 1
)

set EXT_ID=%~1
set TARGET_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

REM Create runner batch file
set RUNNER=%SCRIPT_DIR%web2md-agent-host.bat
(
    echo @echo off
    echo node "%HOST_PATH%" %%*
) > "%RUNNER%"

REM Write manifest
set RUNNER_JSON=%RUNNER:\=\\%
(
    echo {
    echo   "name": "%HOST_NAME%",
    echo   "description": "Web2MD Agent Bridge",
    echo   "path": "%RUNNER_JSON%",
    echo   "type": "stdio",
    echo   "allowed_origins": [
    echo     "chrome-extension://%EXT_ID%/"
    echo   ]
    echo }
) > "%TARGET_DIR%\%HOST_NAME%.json"

REM Register in Windows Registry
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%TARGET_DIR%\%HOST_NAME%.json" /f >nul 2>&1

echo.
echo Native messaging host installed successfully!
echo   Manifest: %TARGET_DIR%\%HOST_NAME%.json
echo   Extension ID: %EXT_ID%
echo.
echo Restart Chrome for the changes to take effect.
