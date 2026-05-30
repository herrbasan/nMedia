@echo off
setlocal EnableDelayedExpansion

:: nMedia Deploy Script
:: Deploys the project to \\BADKID\Stuff\SRV\nMedia
:: Performs: git clone/pull, submodule update, npm install
::
:: Usage: scripts\deploy.bat

set "TARGET=\\BADKID\Stuff\SRV\nMedia"
set "REPO=https://github.com/herrbasan/nMedia.git"
set "SOURCE_CONFIG=config.json"

echo ==========================================
echo  nMedia Deploy
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

:: Pre-copy native build artifacts so submodule postinstall rebuilds are no-ops.
:: This must happen BEFORE npm install so the built binaries already exist.
echo.
echo [4/6] Copying native module binaries...
set "SOURCE_NVIDEO=modules\nVideo\dist"
set "TARGET_NVIDEO=%TARGET%\modules\nVideo\dist"
if exist "%SOURCE_NVIDEO%" (
    if not exist "%TARGET_NVIDEO%" mkdir "%TARGET_NVIDEO%"
    echo   nVideo dist...
    robocopy "%SOURCE_NVIDEO%" "%TARGET_NVIDEO%" /E /NFL /NDL /NJH /NJS
) else (
    echo   WARNING: Source modules\nVideo\dist not found. nVideo may need to be built on target.
)

set "SOURCE_NIMAGE=modules\nImage\dist"
set "TARGET_NIMAGE=%TARGET%\modules\nImage\dist"
if exist "%SOURCE_NIMAGE%" (
    if not exist "%TARGET_NIMAGE%" mkdir "%TARGET_NIMAGE%"
    echo   nImage dist...
    robocopy "%SOURCE_NIMAGE%" "%TARGET_NIMAGE%" /E /NFL /NDL /NJH /NJS
) else (
    echo   WARNING: Source modules\nImage\dist not found. nImage may need to be built on target.
)

:: Copy nVideo FFmpeg binaries (deps/win/bin — not tracked in git, downloaded by npm run setup)
set "SOURCE_FFMPEG=modules\nVideo\deps\win\bin"
set "TARGET_FFMPEG=%TARGET%\modules\nVideo\deps\win\bin"
if exist "%SOURCE_FFMPEG%" (
    if not exist "%TARGET_FFMPEG%" mkdir "%TARGET_FFMPEG%"
    echo   nVideo FFmpeg binaries...
    robocopy "%SOURCE_FFMPEG%" "%TARGET_FFMPEG%" /E /NFL /NDL /NJH /NJS
) else (
    echo   WARNING: Source modules\nVideo\deps\win\bin not found. Run 'npm run setup' in modules\nVideo first.
)

:: Copy nImage vcpkg DLLs (required for runtime, not tracked in git)
set "SOURCE_NIMAGE_DLLS=modules\nImage\build\Release"
set "TARGET_NIMAGE_DLLS=%TARGET%\modules\nImage\build\Release"
if exist "%SOURCE_NIMAGE_DLLS%" (
    if not exist "%TARGET_NIMAGE_DLLS%" mkdir "%TARGET_NIMAGE_DLLS%"
    echo   nImage build DLLs...
    robocopy "%SOURCE_NIMAGE_DLLS%" "%TARGET_NIMAGE_DLLS%" /E /NFL /NDL /NJH /NJS
) else (
    echo   WARNING: Source modules\nImage\build\Release not found. nImage may need to be built on target.
)

:: Copy nVideo build artifacts (required for runtime, not tracked in git)
set "SOURCE_NVIDEO_BUILD=modules\nVideo\build\Release"
set "TARGET_NVIDEO_BUILD=%TARGET%\modules\nVideo\build\Release"
if exist "%SOURCE_NVIDEO_BUILD%" (
    if not exist "%TARGET_NVIDEO_BUILD%" mkdir "%TARGET_NVIDEO_BUILD%"
    echo   nVideo build artifacts...
    robocopy "%SOURCE_NVIDEO_BUILD%" "%TARGET_NVIDEO_BUILD%" /E /NFL /NDL /NJH /NJS
) else (
    echo   WARNING: Source modules\nVideo\build\Release not found. nVideo may need to be built on target.
)

:: Run npm install (postinstall will rebuild submodules, but binaries are already in place)
echo.
echo [5/6] Installing dependencies...
cd /d "%TARGET%"
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    exit /b 1
)

:: Copy built binaries AGAIN to overwrite anything npm install / node-gyp stomped on.
:: node-gyp rebuild may produce stub/dummy outputs when deps are missing.
echo.
echo [6/6] Restoring native binaries after install...
if exist "%SOURCE_NVIDEO%" (
    echo   nVideo dist restore...
    robocopy "%SOURCE_NVIDEO%" "%TARGET_NVIDEO%" /E /NFL /NDL /NJH /NJS
)
if exist "%SOURCE_NIMAGE%" (
    echo   nImage dist restore...
    robocopy "%SOURCE_NIMAGE%" "%TARGET_NIMAGE%" /E /NFL /NDL /NJH /NJS
)
if exist "%SOURCE_FFMPEG%" (
    echo   nVideo FFmpeg restore...
    robocopy "%SOURCE_FFMPEG%" "%TARGET_FFMPEG%" /E /NFL /NDL /NJH /NJS
)
if exist "%SOURCE_NIMAGE_DLLS%" (
    echo   nImage build DLLs restore...
    robocopy "%SOURCE_NIMAGE_DLLS%" "%TARGET_NIMAGE_DLLS%" /E /NFL /NDL /NJH /NJS
)
if exist "%SOURCE_NVIDEO_BUILD%" (
    echo   nVideo build artifacts restore...
    robocopy "%SOURCE_NVIDEO_BUILD%" "%TARGET_NVIDEO_BUILD%" /E /NFL /NDL /NJH /NJS
)

echo.
echo ==========================================
echo  Deploy complete!
echo  Location: %TARGET%
echo ==========================================
echo.
echo Next steps:
echo   1. Review config.json on the target machine
echo   2. Start the service: npm start
echo.

endlocal
