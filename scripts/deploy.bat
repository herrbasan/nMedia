@echo off
setlocal EnableDelayedExpansion

:: Media Service Deploy Script
:: Deploys the project to \\BADKID\Stuff\SRV\MediaService
:: Performs: git clone/pull, submodule update, npm install
::
:: Usage: scripts\deploy.bat

set "TARGET=\\BADKID\Stuff\SRV\MediaService"
set "REPO=https://github.com/herrbasan/MediaService.git"
set "SOURCE_CONFIG=config.json"

echo ==========================================
echo  Media Service Deploy
echo  Target: %TARGET%
echo ==========================================
echo.

:: Check target directory accessibility
if not exist "\\BADKID\Stuff\SRV" (
    echo ERROR: Cannot access \\BADKID\Stuff\SRV
    echo Make sure the network share is accessible.
    exit /b 1
)

:: Create target directory if it doesn't exist
if not exist "%TARGET%" (
    echo Creating target directory...
    mkdir "%TARGET%" 2>nul
    if errorlevel 1 (
        echo ERROR: Failed to create %TARGET%
        exit /b 1
    )
)

:: Check if target is already a git repo
if exist "%TARGET%\.git" (
    echo.
    echo [1/4] Target exists. Pulling latest changes...
    cd /d "%TARGET%"
    git fetch origin
    if errorlevel 1 (
        echo ERROR: git fetch failed
        exit /b 1
    )
    git reset --hard origin/master
    if errorlevel 1 (
        echo ERROR: git reset failed
        exit /b 1
    )
) else (
    echo.
    echo [1/4] Cloning repository...
    git clone --recursive "%REPO%" "%TARGET%"
    if errorlevel 1 (
        echo ERROR: git clone failed
        exit /b 1
    )
    cd /d "%TARGET%"
)

:: Update submodules
echo.
echo [2/4] Updating submodules...
git submodule update --init --recursive
if errorlevel 1 (
    echo ERROR: Submodule update failed
    exit /b 1
)

:: Copy config.json from source if it exists and target doesn't have one
echo.
echo [3/4] Checking configuration...
if exist "%SOURCE_CONFIG%" (
    if not exist "%TARGET%\config.json" (
        echo Copying config.json from source...
        copy /Y "%SOURCE_CONFIG%" "%TARGET%\config.json" >nul
        echo Config copied. Review and adjust paths for the target machine.
    ) else (
        echo config.json already exists on target. Skipping copy.
        echo Delete it on the target if you want to overwrite with source version.
    )
) else (
    echo Source config.json not found. Make sure config.json exists.
)

:: Run npm install
echo.
echo [4/4] Installing dependencies...
cd /d "%TARGET%"
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    exit /b 1
)

echo.
echo ==========================================
echo  Deploy complete!
echo  Location: %TARGET%
echo ==========================================
echo.
echo Next steps:
echo   1. Review config.json on the target machine
echo   2. Ensure native module binaries are built:
echo      cd modules\nVideo ^&^& npm run build
echo      cd modules\nImage ^&^& npm run build
echo   3. Start the service: npm start
echo.

endlocal
